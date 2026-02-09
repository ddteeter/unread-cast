// src/processing/fetcher.ts
import { JSDOM } from 'jsdom';

interface MediumUrlInfo {
  isMedium: boolean;
  username?: string;
  articleSlug?: string;
  rssUrl?: string;
}

/**
 * Detects if a URL is a Medium article and extracts metadata
 */
function detectMediumUrl(url: string): MediumUrlInfo {
  try {
    const urlObj = new URL(url);
    const hostname = urlObj.hostname;
    const pathname = urlObj.pathname;

    const pathParts = pathname.split('/').filter(Boolean);
    const articleSlug = pathParts[pathParts.length - 1] || '';

    // Personal blog: username.medium.com
    if (hostname.endsWith('.medium.com')) {
      const username = hostname.replace('.medium.com', '');
      return {
        isMedium: true,
        username,
        articleSlug,
        rssUrl: `https://medium.com/feed/@${username}`,
      };
    }

    // Medium publication: medium.com/@username
    if (hostname === 'medium.com' && pathname.startsWith('/@')) {
      const username = pathParts[0]?.replace('@', '') || '';
      return {
        isMedium: true,
        username,
        articleSlug,
        rssUrl: `https://medium.com/feed/@${username}`,
      };
    }

    return { isMedium: false };
  } catch {
    return { isMedium: false };
  }
}

/**
 * Extracts article content from Medium RSS feed XML
 */
function extractContentFromRss(rssXml: string, articleSlug: string): string {
  const dom = new JSDOM(rssXml, { contentType: 'text/xml' });
  const doc = dom.window.document;

  const items = doc.querySelectorAll('item');

  if (items.length === 0) {
    throw new Error('No items found in Medium RSS feed');
  }

  // Find item by matching article slug in link/guid
  for (const item of items) {
    const link = item.querySelector('link')?.textContent?.trim() || '';
    const guid = item.querySelector('guid')?.textContent?.trim() || '';

    if (link.includes(articleSlug) || guid.includes(articleSlug)) {
      // Get all elements and find one with localName 'encoded' (works regardless of namespace prefix)
      let htmlContent = '';

      const allElements = item.getElementsByTagName('*');
      for (let i = 0; i < allElements.length; i++) {
        const el = allElements[i];
        if (el.localName === 'encoded') {
          htmlContent = el.textContent || '';
          break;
        }
      }

      if (!htmlContent || htmlContent.length < 100) {
        throw new Error(`No content found in RSS item for article: ${articleSlug}`);
      }

      // Wrap for Readability compatibility
      return `
        <html>
          <head><title>Medium Article</title></head>
          <body>${htmlContent}</body>
        </html>
      `;
    }
  }

  throw new Error(`Article not found in Medium RSS feed: ${articleSlug}`);
}

/**
 * Fetches Medium article content via RSS feed
 */
async function fetchFromMediumRss(url: string): Promise<string> {
  const mediumInfo = detectMediumUrl(url);

  if (!mediumInfo.isMedium || !mediumInfo.rssUrl || !mediumInfo.articleSlug) {
    throw new Error(`Invalid Medium URL: ${url}`);
  }

  const response = await fetch(mediumInfo.rssUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; UnreadCast/1.0; +https://github.com/unread-cast)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Medium RSS feed ${mediumInfo.rssUrl}: ${response.status}`);
  }

  const rssXml = await response.text();
  return extractContentFromRss(rssXml, mediumInfo.articleSlug);
}

export async function fetchHtml(url: string): Promise<string> {
  const mediumInfo = detectMediumUrl(url);

  if (mediumInfo.isMedium && mediumInfo.rssUrl) {
    // Use RSS for Medium URLs, fail immediately if RSS fetch fails
    return await fetchFromMediumRss(url);
  }

  // Existing direct fetch logic for non-Medium URLs
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; UnreadCast/1.0; +https://github.com/unread-cast)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}
