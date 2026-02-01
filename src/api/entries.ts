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
      extractedContent: null,
      transcriptJson: null,
      errorMessage: null,
      retryCount: 0,
      nextRetryAt: null,
      createdAt,
      processedAt: null,
    };
  }

  async function getEntry(id: string): Promise<Entry | null> {
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      url: row.url as string,
      category: row.category as string | null,
      status: row.status as Entry['status'],
      title: row.title as string | null,
      extractedContent: row.extracted_content as string | null,
      transcriptJson: row.transcript_json as string | null,
      errorMessage: row.error_message as string | null,
      retryCount: row.retry_count as number,
      nextRetryAt: row.next_retry_at as string | null,
      createdAt: row.created_at as string,
      processedAt: row.processed_at as string | null,
    };
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

    return rows.map((row) => ({
      id: row.id as string,
      url: row.url as string,
      category: row.category as string | null,
      status: row.status as Entry['status'],
      title: row.title as string | null,
      extractedContent: row.extracted_content as string | null,
      transcriptJson: row.transcript_json as string | null,
      errorMessage: row.error_message as string | null,
      retryCount: row.retry_count as number,
      nextRetryAt: row.next_retry_at as string | null,
      createdAt: row.created_at as string,
      processedAt: row.processed_at as string | null,
    }));
  }

  return {
    createEntry,
    getEntry,
    listEntries,
  };
}
