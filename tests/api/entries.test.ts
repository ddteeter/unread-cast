// tests/api/entries.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';

describe('entry handlers', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'unread-cast-test-'));
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create a new entry', async () => {
    const { createEntryHandlers } = await import('../../src/api/entries.js');
    const handlers = createEntryHandlers(db);

    const result = await handlers.createEntry({
      url: 'https://example.com/article',
      category: 'tech',
    });

    expect(result.id).toBeDefined();
    expect(result.url).toBe('https://example.com/article');
    expect(result.category).toBe('tech');
    expect(result.status).toBe('pending');
  });

  it('should reject invalid URLs', async () => {
    const { createEntryHandlers } = await import('../../src/api/entries.js');
    const handlers = createEntryHandlers(db);

    try {
      await handlers.createEntry({ url: 'not-a-url' });
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      expect(error.code).toBe('INVALID_URL');
    }
  });

  it('should reject duplicate URLs', async () => {
    const { createEntryHandlers } = await import('../../src/api/entries.js');
    const handlers = createEntryHandlers(db);

    await handlers.createEntry({ url: 'https://example.com/article' });

    try {
      await handlers.createEntry({ url: 'https://example.com/article' });
      expect.fail('Should have thrown an error');
    } catch (error: any) {
      expect(error.code).toBe('DUPLICATE_URL');
    }
  });
});
