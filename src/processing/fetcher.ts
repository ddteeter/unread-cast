// src/processing/fetcher.ts
export async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; PodcastLater/1.0; +https://github.com/podcast-later)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}
