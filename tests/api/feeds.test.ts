// tests/api/feeds.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { v4 as uuidv4 } from 'uuid';

describe('feed handlers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);

    // Add default category
    db.prepare('INSERT INTO categories (name, feed_id, created_at) VALUES (?, ?, ?)').run(
      'default',
      uuidv4(),
      new Date().toISOString()
    );
  });

  afterEach(() => {
    db.close();
  });

  it('should list all feeds', async () => {
    const { createFeedHandlers } = await import('../../src/api/feeds.js');
    const handlers = createFeedHandlers(db, {
      baseUrl: 'https://example.com',
      feedTitle: 'Test Podcast',
      feedAuthor: 'Test Author',
      feedDescription: 'Test description',
      r2PublicUrl: 'https://audio.example.com',
    });

    const feeds = await handlers.listFeeds();

    expect(feeds.length).toBeGreaterThanOrEqual(1);
    expect(feeds[0].category).toBe('default');
    expect(feeds[0].url).toContain('/feed/');
  });

  it('should generate valid RSS XML', async () => {
    const { createFeedHandlers } = await import('../../src/api/feeds.js');
    const handlers = createFeedHandlers(db, {
      baseUrl: 'https://example.com',
      feedTitle: 'Test Podcast',
      feedAuthor: 'Test Author',
      feedDescription: 'Test description',
      r2PublicUrl: 'https://audio.example.com',
    });

    // Get the feed ID for default category
    const feeds = await handlers.listFeeds();
    const defaultFeed = feeds.find((f) => f.category === 'default');

    const xml = await handlers.getFeedXml(defaultFeed!.url.split('/feed/')[1].replace('.xml', ''));

    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('Test Podcast');
  });
});
