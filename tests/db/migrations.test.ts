import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '@blackglory/better-sqlite3-migrations';
import type { IMigration } from '@blackglory/better-sqlite3-migrations';

describe('database migrations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should apply migrations and track version', () => {
    const migrations: IMigration[] = [
      { version: 1, up: 'CREATE TABLE test1 (id INTEGER);', down: 'DROP TABLE test1;' },
      { version: 2, up: 'CREATE TABLE test2 (id INTEGER);', down: 'DROP TABLE test2;' },
    ];

    migrate(db, migrations);

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(2);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('test1');
    expect(tables.map((t) => t.name)).toContain('test2');
  });

  it('should be idempotent - skip already applied migrations', () => {
    const migrations: IMigration[] = [
      { version: 1, up: 'CREATE TABLE test1 (id INTEGER);', down: 'DROP TABLE test1;' },
    ];

    migrate(db, migrations);
    // Run again - should not error
    expect(() => migrate(db, migrations)).not.toThrow();

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(1);
  });

  it('should support rollback via target version', () => {
    const migrations: IMigration[] = [
      { version: 1, up: 'CREATE TABLE test1 (id INTEGER);', down: 'DROP TABLE test1;' },
      { version: 2, up: 'CREATE TABLE test2 (id INTEGER);', down: 'DROP TABLE test2;' },
    ];

    migrate(db, migrations); // Apply all
    migrate(db, migrations, 1); // Rollback to version 1

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(1);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('test1');
    expect(tables.map((t) => t.name)).not.toContain('test2');
  });

  it('should support programmatic migrations', () => {
    const migrations: IMigration[] = [
      {
        version: 1,
        up: (db) => {
          db.exec('CREATE TABLE test1 (id INTEGER, value TEXT);');
          db.prepare('INSERT INTO test1 (id, value) VALUES (?, ?)').run(1, 'test');
        },
        down: (db) => {
          db.exec('DROP TABLE test1;');
        },
      },
    ];

    migrate(db, migrations);

    const row = db.prepare('SELECT * FROM test1 WHERE id = ?').get(1) as { value: string };
    expect(row.value).toBe('test');
  });

  it('should rollback to version 0 (drop all tables)', () => {
    const migrations: IMigration[] = [
      { version: 1, up: 'CREATE TABLE test1 (id INTEGER);', down: 'DROP TABLE test1;' },
    ];

    migrate(db, migrations);
    migrate(db, migrations, 0); // Rollback to version 0

    const version = db.pragma('user_version', { simple: true }) as number;
    expect(version).toBe(0);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).not.toContain('test1');
  });

  it('should skip migrations already applied based on version', () => {
    const migrations: IMigration[] = [
      { version: 1, up: 'CREATE TABLE test1 (id INTEGER);', down: 'DROP TABLE test1;' },
      { version: 2, up: 'CREATE TABLE test2 (id INTEGER);', down: 'DROP TABLE test2;' },
    ];

    // Apply all migrations
    migrate(db, migrations);
    expect(db.pragma('user_version', { simple: true })).toBe(2);

    // Running again should be idempotent - no error, no re-execution
    expect(() => migrate(db, migrations)).not.toThrow();
    expect(db.pragma('user_version', { simple: true })).toBe(2);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('test1');
    expect(tables.map((t) => t.name)).toContain('test2');
  });

  it('should use transactions for atomic migrations', () => {
    const migrations: IMigration[] = [
      {
        version: 1,
        up: (db) => {
          // This will succeed
          db.exec('CREATE TABLE test1 (id INTEGER);');
          // Verify we can see changes within same transaction
          const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all() as { name: string }[];
          expect(tables.map((t) => t.name)).toContain('test1');
        },
        down: 'DROP TABLE test1;',
      },
    ];

    migrate(db, migrations);

    // Verify table persisted after transaction
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('test1');
  });
});
