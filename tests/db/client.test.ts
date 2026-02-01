import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('database client', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'podcast-later-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create tables on initialization', async () => {
    const { createDatabase } = await import('../../src/db/client.js');
    const db = createDatabase(join(tempDir, 'test.db'));

    // Check tables exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('entries');
    expect(tableNames).toContain('episodes');
    expect(tableNames).toContain('categories');
    expect(tableNames).toContain('usage_log');
    expect(tableNames).toContain('processing_lock');

    db.close();
  });

  it('should create default category on init', async () => {
    const { createDatabase } = await import('../../src/db/client.js');
    const db = createDatabase(join(tempDir, 'test.db'));

    const defaultCat = db
      .prepare('SELECT * FROM categories WHERE name = ?')
      .get('default') as { name: string; feed_id: string } | undefined;

    expect(defaultCat).toBeDefined();
    expect(defaultCat?.feed_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    db.close();
  });
});
