import type Database from 'better-sqlite3';

/**
 * @deprecated This schema initialization has been replaced by the migration system.
 * See src/db/migrations.ts and migrations/001-initial-schema.sql
 * This file is kept for reference only.
 */
export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      category TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT,
      extracted_content TEXT,
      transcript_json TEXT,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      processed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS episodes (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL,
      category TEXT,
      title TEXT NOT NULL,
      description TEXT,
      audio_key TEXT NOT NULL,
      audio_duration INTEGER,
      audio_size INTEGER,
      published_at TEXT NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES entries(id)
    );

    CREATE TABLE IF NOT EXISTS categories (
      name TEXT PRIMARY KEY,
      feed_id TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id TEXT PRIMARY KEY,
      entry_id TEXT,
      service TEXT NOT NULL,
      model TEXT NOT NULL,
      input_units INTEGER NOT NULL,
      output_units INTEGER,
      cost_usd REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (entry_id) REFERENCES entries(id)
    );

    CREATE TABLE IF NOT EXISTS processing_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      locked_at TEXT,
      locked_by TEXT
    );

    INSERT OR IGNORE INTO processing_lock (id) VALUES (1);

    CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
    CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
    CREATE INDEX IF NOT EXISTS idx_episodes_category ON episodes(category);
    CREATE INDEX IF NOT EXISTS idx_episodes_published_at ON episodes(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_log_created_at ON usage_log(created_at);
  `);
}
