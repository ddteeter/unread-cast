// src/api/feeds.ts
import type Database from 'better-sqlite3';
import type { Episode, Category } from '../types/index.js';

export interface FeedConfig {
  baseUrl: string;
  feedTitle: string;
  feedAuthor: string;
  feedDescription: string;
  artworkUrl?: string;
  r2PublicUrl: string;
}

export interface FeedInfo {
  category: string;
  title: string;
  url: string;
}

export interface FeedHandlers {
  listFeeds(): Promise<FeedInfo[]>;
  getFeedXml(feedId: string): Promise<string>;
  getCategoryByFeedId(feedId: string): Promise<Category | null>;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatRfc2822(date: Date): string {
  return date.toUTCString();
}

export function createFeedHandlers(
  db: Database.Database,
  config: FeedConfig
): FeedHandlers {
  async function listFeeds(): Promise<FeedInfo[]> {
    const categories = db
      .prepare('SELECT name, feed_id FROM categories ORDER BY name')
      .all() as { name: string; feed_id: string }[];

    return categories.map((cat) => ({
      category: cat.name,
      title:
        cat.name === 'default'
          ? config.feedTitle
          : `${config.feedTitle} - ${cat.name}`,
      url: `${config.baseUrl}/feed/${cat.feed_id}.xml`,
    }));
  }

  async function getCategoryByFeedId(feedId: string): Promise<Category | null> {
    const row = db
      .prepare('SELECT * FROM categories WHERE feed_id = ?')
      .get(feedId) as { name: string; feed_id: string; created_at: string } | undefined;

    if (!row) return null;

    return {
      name: row.name,
      feedId: row.feed_id,
      createdAt: row.created_at,
    };
  }

  async function getFeedXml(feedId: string): Promise<string> {
    const category = await getCategoryByFeedId(feedId);
    if (!category) {
      throw new Error('Feed not found');
    }

    const categoryName = category.name;
    const title =
      categoryName === 'default'
        ? config.feedTitle
        : `${config.feedTitle} - ${categoryName}`;

    // Get episodes for this category (limit 50, newest first)
    const episodes = db
      .prepare(
        `SELECT * FROM episodes
         WHERE category = ? OR (category IS NULL AND ? = 'default')
         ORDER BY published_at DESC
         LIMIT 50`
      )
      .all(categoryName, categoryName) as {
      id: string;
      title: string;
      description: string;
      audio_key: string;
      audio_duration: number;
      audio_size: number;
      published_at: string;
    }[];

    const items = episodes
      .map((ep) => {
        const audioUrl = `${config.r2PublicUrl}/${ep.audio_key}`;
        const pubDate = formatRfc2822(new Date(ep.published_at));
        const duration = formatDuration(ep.audio_duration || 0);

        return `    <item>
      <title>${escapeXml(ep.title)}</title>
      <description>${escapeXml(ep.description || '')}</description>
      <enclosure url="${escapeXml(audioUrl)}" length="${ep.audio_size || 0}" type="audio/aac"/>
      <guid isPermaLink="false">${ep.id}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:duration>${duration}</itunes:duration>
    </item>`;
      })
      .join('\n');

    const artworkTag = config.artworkUrl
      ? `\n    <itunes:image href="${escapeXml(config.artworkUrl)}"/>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(config.baseUrl)}</link>
    <description>${escapeXml(config.feedDescription)}</description>
    <language>en-us</language>
    <itunes:author>${escapeXml(config.feedAuthor)}</itunes:author>${artworkTag}
    <atom:link href="${escapeXml(config.baseUrl)}/feed/${feedId}.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
  }

  return {
    listFeeds,
    getFeedXml,
    getCategoryByFeedId,
  };
}
