// tests/processing/fetcher.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('fetcher', () => {
  beforeEach(async () => {
    vi.resetAllMocks();
    // Clear module cache to ensure fresh imports
    vi.resetModules();
  });

  describe('non-Medium URLs', () => {
    it('should fetch HTML from URL', async () => {
      const mockHtml = '<html><body>Test content</body></html>';
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        text: () => Promise.resolve(mockHtml),
      });

      const { fetchHtml } = await import('../../src/processing/fetcher.js');
      const result = await fetchHtml('https://example.com');

      expect(result).toBe(mockHtml);
    });

    it('should throw on fetch error', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const { fetchHtml } = await import('../../src/processing/fetcher.js');

      await expect(fetchHtml('https://example.com')).rejects.toThrow('404');
    });
  });

  describe('Medium RSS support', () => {
    const createMockRssFeed = (articleSlug: string, content: string) =>
      `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Test Article</title>
      <link>https://username.medium.com/${articleSlug}</link>
      <guid>https://username.medium.com/${articleSlug}</guid>
      <content:encoded><![CDATA[${content}]]></content:encoded>
    </item>
  </channel>
</rss>`;

    describe('URL detection', () => {
      it('should detect personal blog Medium URLs', async () => {
        const articleUrl = 'https://steve-yegge.medium.com/software-survival-3-0-97a2a6255f7b';
        const rssUrl = 'https://medium.com/feed/@steve-yegge';
        const mockContent =
          '<div><h1>Test Article</h1><p>Article content goes here with enough text to pass validation.</p></div>';

        global.fetch = vi.fn().mockImplementation((url: string) => {
          if (url === rssUrl) {
            return Promise.resolve({
              ok: true,
              text: () =>
                Promise.resolve(
                  createMockRssFeed('software-survival-3-0-97a2a6255f7b', mockContent)
                ),
            });
          }
          return Promise.reject(new Error('Unexpected URL'));
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');
        const result = await fetchHtml(articleUrl);

        expect(result).toContain(mockContent);
        expect(global.fetch).toHaveBeenCalledWith(rssUrl, expect.any(Object));
      });

      it('should detect publication Medium URLs', async () => {
        const articleUrl = 'https://medium.com/@username/test-article-12345';
        const rssUrl = 'https://medium.com/feed/@username';
        const mockContent =
          '<div><h1>Publication Article</h1><p>This is a test publication article with sufficient content.</p></div>';

        global.fetch = vi.fn().mockImplementation((url: string) => {
          if (url === rssUrl) {
            return Promise.resolve({
              ok: true,
              text: () => Promise.resolve(createMockRssFeed('test-article-12345', mockContent)),
            });
          }
          return Promise.reject(new Error('Unexpected URL'));
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');
        const result = await fetchHtml(articleUrl);

        expect(result).toContain(mockContent);
        expect(global.fetch).toHaveBeenCalledWith(rssUrl, expect.any(Object));
      });

      it('should not treat non-Medium URLs as Medium', async () => {
        const mockHtml = '<html><body>Regular content</body></html>';
        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(mockHtml),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');
        const result = await fetchHtml('https://example.com/article');

        expect(result).toBe(mockHtml);
        expect(global.fetch).toHaveBeenCalledWith(
          'https://example.com/article',
          expect.any(Object)
        );
      });
    });

    describe('RSS parsing', () => {
      it('should extract content from RSS feed', async () => {
        const articleUrl = 'https://username.medium.com/test-article-abc123';
        const mockContent =
          '<div><h1>Article Title</h1><p>Full article content with plenty of text to meet minimum requirements.</p></div>';

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(createMockRssFeed('test-article-abc123', mockContent)),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');
        const result = await fetchHtml(articleUrl);

        expect(result).toContain(mockContent);
        expect(result).toContain('<html>');
        expect(result).toContain('<body>');
      });

      it('should match article by slug in link', async () => {
        const articleUrl = 'https://username.medium.com/my-article-slug';
        const mockContent =
          '<div><p>Content that is definitely long enough to pass the validation check in the parser with extra words.</p></div>';

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(createMockRssFeed('my-article-slug', mockContent)),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');
        const result = await fetchHtml(articleUrl);

        expect(result).toContain(mockContent);
      });

      it('should match article by slug in guid', async () => {
        const articleUrl = 'https://username.medium.com/my-article-slug';
        const mockContent =
          '<div><p>Content that is definitely long enough to pass the validation check in the parser with extra words.</p></div>';
        const rssXml = createMockRssFeed('my-article-slug', mockContent).replace(
          '<link>https://username.medium.com/my-article-slug</link>',
          '<link>https://different-link.com</link>'
        );

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(rssXml),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');
        const result = await fetchHtml(articleUrl);

        expect(result).toContain(mockContent);
      });
    });

    describe('error handling', () => {
      it('should throw when RSS feed fetch fails', async () => {
        const articleUrl = 'https://username.medium.com/test-article';

        global.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 503,
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');

        await expect(fetchHtml(articleUrl)).rejects.toThrow('Failed to fetch Medium RSS feed');
        await expect(fetchHtml(articleUrl)).rejects.toThrow('503');
      });

      it('should throw when article not found in RSS feed', async () => {
        const articleUrl = 'https://username.medium.com/nonexistent-article';
        const mockContent =
          '<div><p>Different article content that is long enough for validation.</p></div>';
        const rssXml = createMockRssFeed('different-article-slug', mockContent);

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(rssXml),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');

        await expect(fetchHtml(articleUrl)).rejects.toThrow('Article not found in Medium RSS feed');
        await expect(fetchHtml(articleUrl)).rejects.toThrow('nonexistent-article');
      });

      it('should throw when RSS feed is empty', async () => {
        const articleUrl = 'https://username.medium.com/test-article';
        const emptyRss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Empty Feed</title>
  </channel>
</rss>`;

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(emptyRss),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');

        await expect(fetchHtml(articleUrl)).rejects.toThrow('No items found');
      });

      it('should throw when content:encoded is missing', async () => {
        const articleUrl = 'https://username.medium.com/test-article';
        const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <item>
      <link>https://username.medium.com/test-article</link>
    </item>
  </channel>
</rss>`;

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(rssXml),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');

        await expect(fetchHtml(articleUrl)).rejects.toThrow('No content found in RSS item');
      });

      it('should throw when content is too short', async () => {
        const articleUrl = 'https://username.medium.com/test-article';
        const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <item>
      <link>https://username.medium.com/test-article</link>
      <content:encoded><![CDATA[<p>Short</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(rssXml),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');

        await expect(fetchHtml(articleUrl)).rejects.toThrow('No content found in RSS item');
      });

      it('should throw when XML is malformed', async () => {
        const articleUrl = 'https://username.medium.com/test-article';
        const malformedXml = '<rss><broken';

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(malformedXml),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');

        // Should throw some error (either parse error or no items found)
        await expect(fetchHtml(articleUrl)).rejects.toThrow();
      });
    });

    describe('edge cases', () => {
      it('should handle multiple items in RSS feed', async () => {
        const articleUrl = 'https://username.medium.com/second-article';
        const mockContent1 =
          '<div><p>First article with more than enough content to pass all validation checks successfully.</p></div>';
        const mockContent2 =
          '<div><p>Second article with more than enough content to pass all validation checks successfully.</p></div>';

        // Create RSS with multiple items manually
        const rssXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>First Article</title>
      <link>https://username.medium.com/first-article</link>
      <guid>https://username.medium.com/first-article</guid>
      <content:encoded><![CDATA[${mockContent1}]]></content:encoded>
    </item>
    <item>
      <title>Second Article</title>
      <link>https://username.medium.com/second-article</link>
      <guid>https://username.medium.com/second-article</guid>
      <content:encoded><![CDATA[${mockContent2}]]></content:encoded>
    </item>
  </channel>
</rss>`;

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(rssXml),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');
        const result = await fetchHtml(articleUrl);

        expect(result).toContain(mockContent2);
        expect(result).not.toContain(mockContent1);
      });

      it('should handle URL with query parameters', async () => {
        const articleUrl = 'https://username.medium.com/test-article?source=rss';
        const mockContent =
          '<div><p>Article content with more than sufficient length for validation to pass the minimum requirement.</p></div>';

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(createMockRssFeed('test-article', mockContent)),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');
        const result = await fetchHtml(articleUrl);

        expect(result).toContain(mockContent);
      });

      it('should handle URL with trailing slash', async () => {
        const articleUrl = 'https://username.medium.com/test-article/';
        const mockContent =
          '<div><p>Article content with more than sufficient length for validation to pass the minimum requirement.</p></div>';

        global.fetch = vi.fn().mockResolvedValue({
          ok: true,
          text: () => Promise.resolve(createMockRssFeed('test-article', mockContent)),
        });

        const { fetchHtml } = await import('../../src/processing/fetcher.js');
        const result = await fetchHtml(articleUrl);

        expect(result).toContain(mockContent);
      });
    });
  });
});
