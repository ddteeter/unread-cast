// tests/processing/extractor.test.ts
import { describe, it, expect } from 'vitest';

describe('extractor', () => {
  it('should extract content from HTML', async () => {
    const { extractContent } = await import('../../src/processing/extractor.js');

    const html = `
      <html>
        <head><title>Test Article</title></head>
        <body>
          <nav>Navigation</nav>
          <article>
            <h1>Test Article</h1>
            <p>This is the main content of the article. It contains several sentences to ensure we have enough content for extraction. The article discusses important topics that readers find interesting.</p>
            <p>Another paragraph with more content to make sure we exceed the minimum threshold. This paragraph adds more substance to the article and helps demonstrate the extraction process.</p>
          </article>
          <footer>Footer content</footer>
        </body>
      </html>
    `;

    const result = await extractContent(html);

    expect(result.title).toBe('Test Article');
    expect(result.content).toContain('main content');
    expect(result.content).not.toContain('Navigation');
    expect(result.content).not.toContain('Footer');
  });
});
