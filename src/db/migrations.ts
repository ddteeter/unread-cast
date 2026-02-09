import type { IMigration } from '@blackglory/better-sqlite3-migrations';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helper to load SQL files
function loadSql(filename: string): string {
  // When running from TypeScript (src/db/migrations.ts) or compiled JS (dist/db/migrations.js):
  // Both need to go up 2 levels to reach project root where migrations/ directory lives
  const pathToMigrations = join(__dirname, '../../migrations', filename);

  if (existsSync(pathToMigrations)) {
    return readFileSync(pathToMigrations, 'utf-8');
  } else {
    throw new Error(`Migration file not found: ${filename}\nTried: ${pathToMigrations}`);
  }
}

export const migrations: IMigration[] = [
  {
    version: 1,
    up: loadSql('001-initial-schema.sql'),
    down: `
      DROP TABLE IF EXISTS usage_log;
      DROP TABLE IF EXISTS episodes;
      DROP TABLE IF EXISTS processing_lock;
      DROP TABLE IF EXISTS categories;
      DROP TABLE IF EXISTS entries;
    `,
  },
  {
    version: 2,
    up: loadSql('002-add-resume-support.sql'),
    down: `
      DROP INDEX IF EXISTS idx_entries_force_reprocess;
      -- Note: SQLite doesn't support DROP COLUMN, so down migration only removes index
      -- Columns remain but are harmless (default values prevent issues)
    `,
  },
  // Future migrations will be added here
];
