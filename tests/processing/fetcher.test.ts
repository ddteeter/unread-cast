// tests/processing/fetcher.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('fetcher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

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
