import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { initializeSchema } from './schema.js';

export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  initializeSchema(db);

  // Ensure default category exists
  const defaultCategory = db
    .prepare('SELECT * FROM categories WHERE name = ?')
    .get('default');

  if (!defaultCategory) {
    db.prepare(
      'INSERT INTO categories (name, feed_id, created_at) VALUES (?, ?, ?)'
    ).run('default', uuidv4(), new Date().toISOString());
  }

  // Ensure processing_lock row exists
  const lockRow = db.prepare('SELECT * FROM processing_lock WHERE id = 1').get();
  if (!lockRow) {
    db.prepare(
      'INSERT INTO processing_lock (id, locked_at, locked_by) VALUES (1, NULL, NULL)'
    ).run();
  }

  return db;
}

export type { Database };
