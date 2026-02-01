// src/api/entries.ts
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Entry } from '../types/index.js';

export interface CreateEntryInput {
  url: string;
  category?: string;
}

export interface EntryHandlers {
  createEntry(input: CreateEntryInput): Promise<Entry>;
  getEntry(id: string): Promise<Entry | null>;
  listEntries(status?: string): Promise<Entry[]>;
}

function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function createEntryHandlers(db: Database.Database): EntryHandlers {
  async function createEntry(input: CreateEntryInput): Promise<Entry> {
    if (!isValidUrl(input.url)) {
      const error = new Error('Invalid URL format');
      (error as Error & { code: string }).code = 'INVALID_URL';
      throw error;
    }

    // Check for duplicate
    const existing = db
      .prepare('SELECT id FROM entries WHERE url = ?')
      .get(input.url);

    if (existing) {
      const error = new Error('URL already exists');
      (error as Error & { code: string }).code = 'DUPLICATE_URL';
      throw error;
    }

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const category = input.category ?? null;

    db.prepare(
      `INSERT INTO entries (id, url, category, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`
    ).run(id, input.url, category, createdAt);

    // Create category if it doesn't exist
    if (category) {
      const existingCategory = db
        .prepare('SELECT name FROM categories WHERE name = ?')
        .get(category);

      if (!existingCategory) {
        db.prepare(
          'INSERT INTO categories (name, feed_id, created_at) VALUES (?, ?, ?)'
        ).run(category, uuidv4(), createdAt);
      }
    }

    return {
      id,
      url: input.url,
      category,
      status: 'pending',
      title: null,
      extracted_content: null,
      transcript_json: null,
      error_message: null,
      retry_count: 0,
      next_retry_at: null,
      created_at: createdAt,
      processed_at: null,
    };
  }

  async function getEntry(id: string): Promise<Entry | null> {
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;

    return row as unknown as Entry;
  }

  async function listEntries(status?: string): Promise<Entry[]> {
    const query = status
      ? 'SELECT * FROM entries WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM entries ORDER BY created_at DESC';

    const rows = (
      status
        ? db.prepare(query).all(status)
        : db.prepare(query).all()
    ) as Record<string, unknown>[];

    return rows as unknown as Entry[];
  }

  return {
    createEntry,
    getEntry,
    listEntries,
  };
}
