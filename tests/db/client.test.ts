import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('database client', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'unread-cast-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create tables on initialization', async () => {
    const { createDatabase } = await import('../../src/db/client.js');
    const db = createDatabase(join(tempDir, 'test.db'));

    // Check tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
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

    const defaultCat = db.prepare('SELECT * FROM categories WHERE name = ?').get('default') as
      | { name: string; feed_id: string }
      | undefined;

    expect(defaultCat).toBeDefined();
    expect(defaultCat?.feed_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    db.close();
  });

  it('should run migrations and set database version', async () => {
    const { createDatabase } = await import('../../src/db/client.js');
    const db = createDatabase(join(tempDir, 'test.db'));

    // Check that migrations ran and version was set
    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBeGreaterThan(0);

    // Verify all expected tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('entries');
    expect(tableNames).toContain('episodes');
    expect(tableNames).toContain('categories');
    expect(tableNames).toContain('usage_log');
    expect(tableNames).toContain('processing_lock');

    // Verify indexes exist
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
      .all() as { name: string }[];

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain('idx_entries_status');
    expect(indexNames).toContain('idx_entries_category');
    expect(indexNames).toContain('idx_episodes_category');
    expect(indexNames).toContain('idx_episodes_published_at');
    expect(indexNames).toContain('idx_usage_log_created_at');

    db.close();
  });

  it('should be idempotent - reinitializing same database should not error', async () => {
    const { createDatabase } = await import('../../src/db/client.js');
    const dbPath = join(tempDir, 'test.db');

    // First initialization
    const db1 = createDatabase(dbPath);
    const version1 = db1.pragma('user_version', { simple: true }) as number;
    db1.close();

    // Second initialization - should not error
    const db2 = createDatabase(dbPath);
    const version2 = db2.pragma('user_version', { simple: true }) as number;

    // Version should remain the same
    expect(version2).toBe(version1);

    // Tables should still exist
    const tables = db2
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toContain('entries');
    expect(tables.map((t) => t.name)).toContain('episodes');

    db2.close();
  });
});
