// src/processing/extractor.ts
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export interface ExtractionResult {
  title: string;
  content: string;
  byline?: string;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function extractContent(html: string): Promise<ExtractionResult> {
  const dom = new JSDOM(html, { url: 'https://example.com' });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    return {
      title: '',
      content: '',
    };
  }

  return {
    title: article.title || '',
    content: article.textContent || '',
    byline: article.byline || undefined,
  };
}
