// Trigger HeadcanonTL plugin publishing workflow.
import { load, type Cheerio, type CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import { fetchApi } from '@libs/fetch';
import { defaultCover } from '@libs/defaultCover';
import { NovelStatus } from '@libs/novelStatus';
import { Plugin } from '@/types/plugin';
import { Filters } from '@libs/filterInputs';

/**
 * LNReader source for Headcanon TL (WordPress.com).
 *
 * The site's catalogue pages link to individual project/table-of-contents
 * pages. Those pages list chapter posts using WordPress date-based permalinks.
 */
class HeadcanonTLPlugin implements Plugin.PluginBase {
  id = 'headcanonTL';
  name = 'Headcanon TL';
  icon = 'src/en/headcanonTL/icon.png';
  site = 'https://headcanontl.wordpress.com';
  version = '1.0.0';
  filters = {} satisfies Filters;

  private readonly chapterUrlPattern = /^\/\d{4}\/\d{2}\/\d{2}\//;

  private async fetchHtml(url: string): Promise<string> {
    const response = await fetchApi(url);
    if (!response.ok) {
      throw new Error(`Headcanon TL returned HTTP ${response.status}`);
    }
    return response.text();
  }

  private toSitePath(href?: string): string | undefined {
    if (!href) return undefined;

    try {
      const url = new URL(href, this.site);
      const siteUrl = new URL(this.site);
      if (url.hostname !== siteUrl.hostname) return undefined;
      if (url.pathname.startsWith('/wp-admin') || url.pathname.startsWith('/wp-login')) {
        return undefined;
      }
      return `${url.pathname}${url.search}`;
    } catch {
      return undefined;
    }
  }

  private getMainContent($: CheerioAPI): Cheerio<Element> {
    const selectors = [
      'article .entry-content',
      '.entry-content',
      '.wp-block-post-content',
      'main',
    ];

    for (const selector of selectors) {
      const element = $(selector).first();
      if (element.length) return element;
    }

    return $('body');
  }

  private cleanText(value: string): string {
    return value.replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
  }

  private imageFromElement($: CheerioAPI, element: Cheerio<Element>): string {
    const image = element.find('img').first();
    if (!image.length) return defaultCover;

    const source =
      image.attr('data-orig-file') ||
      image.attr('data-large-file') ||
      image.attr('data-lazy-src') ||
      image.attr('data-src') ||
      image.attr('src');

    if (!source) return defaultCover;

    try {
      return new URL(source, this.site).toString();
    } catch {
      return source;
    }
  }

  private isCataloguePage(path: string): boolean {
    if (!path || this.chapterUrlPattern.test(path)) return false;
    if (path === '/') return false;
    if (/\.(?:png|jpe?g|gif|webp|svg|pdf|xml)$/i.test(path)) return false;
    if (/\/(?:tag|category|author|page|wp-json|feed)(?:\/|$)/i.test(path)) return false;
    if (/\/(?:contact(?:-us)?|about|privacy-policy|terms-of-service)(?:\/|$)/i.test(path)) return false;
    return true;
  }

  private parseCatalogue(html: string): Plugin.NovelItem[] {
    const $ = load(html);
    const novels: Plugin.NovelItem[] = [];
    const seen = new Set<string>();

    // Headcanon TL publishes its project directory in the site's header menu:
    // active projects appear under "Projects" and completed projects under
    // "Archives". They are individual TOC pages rather than a single archive URL.
    const menuLinks = $(
      'nav a[href], header a[href], .menu a[href], .wp-block-navigation a[href], .main-navigation a[href], #site-navigation a[href]',
    );

    const addNovel = (anchor: Cheerio<Element>) => {
      const path = this.toSitePath(anchor.attr('href'));
      const name = this.cleanText(anchor.text());

      if (!path || !this.isCataloguePage(path) || name.length < 3) return;
      if (/^(?:image|illustrations?|home|projects|archives|contact us|see more…?)$/i.test(name)) {
        return;
      }
      if (seen.has(path)) return;

      seen.add(path);
      novels.push({
        name,
        path,
        cover: this.imageFromElement($, anchor),
      });
    };

    menuLinks.each((_, element) => addNovel($(element)));

    // Fallback for WordPress themes that render the project list outside <nav>.
    if (!novels.length) {
      $('a[href]').each((_, element) => {
        const anchor = $(element);
        const path = this.toSitePath(anchor.attr('href'));
        if (path?.includes('table-of-contents')) addNovel(anchor);
      });
    }

    return novels;
  }

  private async orderByLatest(novels: Plugin.NovelItem[]): Promise<Plugin.NovelItem[]> {
    try {
      const html = await this.fetchHtml(`${this.site}/`);
      const $ = load(html);
      const recentTitles: string[] = [];

      $('article').each((_, element) => {
        const article = $(element);
        const heading = article
          .find('h1 a, h2 a, h3 a, .entry-title a, .wp-block-post-title a')
          .first();
        const title = this.cleanText(heading.text());
        if (title) recentTitles.push(title);
      });

      const ordered: Plugin.NovelItem[] = [];
      const used = new Set<string>();
      for (const title of recentTitles) {
        const match = novels.find(
          novel =>
            !used.has(novel.path) &&
            title.toLocaleLowerCase().includes(novel.name.toLocaleLowerCase()),
        );
        if (match) {
          ordered.push(match);
          used.add(match.path);
        }
      }

      return [...ordered, ...novels.filter(novel => !used.has(novel.path))];
    } catch {
      // The catalogue remains usable even if the homepage cannot be fetched.
      return novels;
    }
  }

  async popularNovels(
    pageNo: number,
    { showLatestNovels }: Plugin.PopularNovelsOptions<typeof this.filters>,
  ): Promise<Plugin.NovelItem[]> {
    // Headcanon TL currently exposes its complete project list on one page.
    if (pageNo > 1) return [];

    const html = await this.fetchHtml(`${this.site}/`);
    const novels = this.parseCatalogue(html);
    return showLatestNovels ? this.orderByLatest(novels) : novels;
  }

  async searchNovels(
    searchTerm: string,
    pageNo: number,
  ): Promise<Plugin.NovelItem[]> {
    if (pageNo > 1 || !searchTerm.trim()) return [];

    const query = new URL(this.site);
    query.searchParams.set('s', searchTerm.trim());

    try {
      const html = await this.fetchHtml(query.toString());
      const $ = load(html);
      const results: Plugin.NovelItem[] = [];
      const seen = new Set<string>();

      $('article').each((_, element) => {
        const article = $(element);
        const anchor = article
          .find('h1 a, h2 a, h3 a, .entry-title a, .wp-block-post-title a')
          .first();
        const path = this.toSitePath(anchor.attr('href'));
        const name = this.cleanText(anchor.text());

        if (!path || !this.isCataloguePage(path) || !name || seen.has(path)) return;
        seen.add(path);
        results.push({ name, path, cover: this.imageFromElement($, article) });
      });

      if (results.length) return results;
    } catch {
      // Fall back to the complete project index below.
    }

    const catalogue = await this.fetchHtml(`${this.site}/`);
    const needle = searchTerm.toLocaleLowerCase();
    return this.parseCatalogue(catalogue).filter(novel =>
      novel.name.toLocaleLowerCase().includes(needle),
    );
  }

  async parseNovel(novelPath: string): Promise<Plugin.SourceNovel> {
    const url = new URL(novelPath, this.site).toString();
    const html = await this.fetchHtml(url);
    const $ = load(html);
    const content = this.getMainContent($);

    const heading = $('h1.entry-title, h1.wp-block-post-title, article h1, main h1, h1')
      .first();
    const pageTitle = this.cleanText(heading.text()) || this.cleanText($('title').text());
    const name = pageTitle.replace(/\s*[|–—-]\s*Headcanon TL$/i, '').trim();

    const paragraphs = content
      .find('p')
      .map((_, element) => this.cleanText($(element).text()))
      .get()
      .filter(Boolean);

    const authorLine = paragraphs.find(line => /^author\s*:/i.test(line));
    const artistLine = paragraphs.find(line => /^artist\s*:/i.test(line));
    const summary = content.find('blockquote').first().text().trim() ||
      paragraphs
        .filter(line =>
          !/^(?:author|artist|support the official releases|table of contents)\s*:/i.test(line) &&
          !/^support the official releases/i.test(line),
        )
        .filter(line => !/^volume\s+\d+$/i.test(line))
        .slice(0, 3)
        .join('\n\n');

    const cover = this.imageFromElement($, content);
    const chapters: Plugin.ChapterItem[] = [];
    const seen = new Set<string>();

    content.find('a[href]').each((_, element) => {
      const anchor = $(element);
      const path = this.toSitePath(anchor.attr('href'));
      const chapterName = this.cleanText(anchor.text());

      if (!path || !this.chapterUrlPattern.test(path) || !chapterName) return;
      if (/^illustrations?$/i.test(chapterName) || /\/illustrations?\/?$/i.test(path)) return;
      if (seen.has(path)) return;

      seen.add(path);
      const dateMatch = path.match(/^\/(\d{4})\/(\d{2})\/(\d{2})\//);
      const releaseTime = dateMatch
        ? `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
        : undefined;

      chapters.push({
        name: chapterName,
        path,
        chapterNumber: chapters.length + 1,
        releaseTime,
      });
    });

    return {
      path: novelPath,
      name: name || 'Headcanon TL project',
      cover,
      summary,
      author: authorLine?.replace(/^author\s*:\s*/i, ''),
      artist: artistLine?.replace(/^artist\s*:\s*/i, ''),
      status: NovelStatus.Unknown,
      chapters,
    };
  }

  async parseChapter(chapterPath: string): Promise<string> {
    const url = new URL(chapterPath, this.site).toString();
    const html = await this.fetchHtml(url);
    const $ = load(html);
    const content = this.getMainContent($);

    if (!content.length) {
      throw new Error('Could not find the chapter content on Headcanon TL.');
    }

    content.find('script, style, noscript, iframe, .sharedaddy, .jp-relatedposts').remove();

    // WordPress sometimes stores the original image only in a lazy-load field.
    content.find('img').each((_, element) => {
      const image = $(element);
      const source =
        image.attr('data-orig-file') ||
        image.attr('data-large-file') ||
        image.attr('data-lazy-src') ||
        image.attr('data-src') ||
        image.attr('src');

      if (source) {
        try {
          image.attr('src', new URL(source, url).toString());
        } catch {
          image.attr('src', source);
        }
      }

      image.removeAttr('srcset');
      image.removeAttr('sizes');
    });

    // Strip inline event handlers and executable URL schemes before returning HTML.
    content.find('*').each((_, element) => {
      const node = $(element);
      for (const attribute of Object.keys(element.attribs || {})) {
        if (/^on/i.test(attribute)) node.removeAttr(attribute);
      }

      for (const attribute of ['href', 'src']) {
        const value = node.attr(attribute);
        if (!value) continue;
        const compactValue = value.replace(/[\u0000-\u0020]/g, '').toLowerCase();
        if (/^(?:javascript|vbscript):/.test(compactValue)) {
          node.removeAttr(attribute);
        }
      }
    });

    return content.html()?.trim() || '';
  }

  resolveUrl(path: string): string {
    return new URL(path, this.site).toString();
  }
}

export default new HeadcanonTLPlugin();
