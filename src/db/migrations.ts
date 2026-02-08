import type { IMigration } from '@blackglory/better-sqlite3-migrations';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Helper to load SQL files
function loadSql(filename: string): string {
  // When running from TypeScript (src/db/migrations.ts): go up 2 levels to project root
  // When running from compiled JS (dist/src/db/migrations.js): go up 3 levels to project root
  const pathFromSrc = join(__dirname, '../../migrations', filename);
  const pathFromDist = join(__dirname, '../../../migrations', filename);

  if (existsSync(pathFromSrc)) {
    return readFileSync(pathFromSrc, 'utf-8');
  } else if (existsSync(pathFromDist)) {
    return readFileSync(pathFromDist, 'utf-8');
  } else {
    throw new Error(
      `Migration file not found: ${filename}\nTried:\n- ${pathFromSrc}\n- ${pathFromDist}`
    );
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
  // Future migrations will be added here
];
