# Database Migration Guide

Unread Cast uses `@blackglory/better-sqlite3-migrations` for database schema versioning. This guide explains how to create and manage migrations.

## Overview

### How It Works

- **Version tracking**: Uses SQLite's built-in `user_version` pragma
- **Migration definitions**: TypeScript array in `src/db/migrations.ts`
- **SQL files**: Stored in `/migrations/` directory
- **Automatic execution**: Runs on app startup via `createDatabase()`
- **Rollback support**: Each migration defines `down` to reverse changes

### Migration Format

Each migration has three properties:

```typescript
{
  version: 1,              // Sequential number (1, 2, 3...)
  up: loadSql('001.sql'),  // SQL string or function to apply
  down: 'DROP TABLE...'    // SQL string or function to rollback
}
```

## Creating a New Migration

### Step 1: Create SQL File

Create a new file in `migrations/` with the next sequential number:

```bash
# Example: migrations/002-add-user-preferences.sql
```

**Naming convention**: `NNN-description.sql`

```sql
-- Migration 002: Add user preferences table
-- Created: 2026-02-07
-- Description: Store user-specific settings for feed customization

CREATE TABLE user_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  setting_key TEXT NOT NULL,
  setting_value TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, setting_key)
);

CREATE INDEX idx_user_preferences_user_id ON user_preferences(user_id);
```

### Step 2: Add to migrations.ts

Edit `src/db/migrations.ts` and add the new migration:

```typescript
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
  // NEW MIGRATION HERE:
  {
    version: 2,
    up: loadSql('002-add-user-preferences.sql'),
    down: 'DROP TABLE IF EXISTS user_preferences;',
  },
];
```

### Step 3: Test Locally

```bash
# Start the app (migrations run automatically)
npm run dev

# Verify migration applied
sqlite3 data/unread-cast.db "PRAGMA user_version;"
# Should output: 2

sqlite3 data/unread-cast.db ".tables"
# Should include: user_preferences
```

### Step 4: Commit Both Files

```bash
git add migrations/002-add-user-preferences.sql
git add src/db/migrations.ts
git commit -m "feat: add user preferences table"
```

## Migration Types

### 1. SQL String Migrations (Most Common)

Use `loadSql()` for SQL files or inline strings for simple migrations:

```typescript
{
  version: 2,
  up: loadSql('002-add-column.sql'),
  down: 'ALTER TABLE entries DROP COLUMN new_column;',
}
```

### 2. Programmatic Migrations

Use functions for complex data transformations:

```typescript
{
  version: 3,
  up: (db) => {
    // Create new column
    db.exec('ALTER TABLE entries ADD COLUMN status_v2 TEXT;');

    // Migrate data
    db.prepare(`
      UPDATE entries
      SET status_v2 = CASE
        WHEN status = 'pending' THEN 'queued'
        WHEN status = 'processing' THEN 'in_progress'
        ELSE status
      END
    `).run();

    // Drop old column and rename
    db.exec('ALTER TABLE entries DROP COLUMN status;');
    db.exec('ALTER TABLE entries RENAME COLUMN status_v2 TO status;');
  },
  down: (db) => {
    // Reverse the migration
    db.exec('ALTER TABLE entries ADD COLUMN status_old TEXT;');
    db.prepare(`
      UPDATE entries
      SET status_old = CASE
        WHEN status = 'queued' THEN 'pending'
        WHEN status = 'in_progress' THEN 'processing'
        ELSE status
      END
    `).run();
    db.exec('ALTER TABLE entries DROP COLUMN status;');
    db.exec('ALTER TABLE entries RENAME COLUMN status_old TO status;');
  },
}
```

### 3. Adding Columns

**Without default value:**

```sql
ALTER TABLE entries ADD COLUMN new_field TEXT;
```

**With default value:**

```sql
ALTER TABLE entries ADD COLUMN priority INTEGER DEFAULT 0;
```

### 4. Adding Indexes

```sql
CREATE INDEX idx_entries_priority ON entries(priority);
```

### 5. Data Migrations

Use programmatic migrations for transforming existing data:

```typescript
{
  version: 4,
  up: (db) => {
    // Normalize existing URLs
    const entries = db.prepare('SELECT id, url FROM entries').all();
    const stmt = db.prepare('UPDATE entries SET url = ? WHERE id = ?');

    for (const entry of entries) {
      const normalizedUrl = entry.url.toLowerCase().trim();
      stmt.run(normalizedUrl, entry.id);
    }
  },
  down: (db) => {
    // Rollback is difficult for data migrations
    // Often best to leave data as-is or have backup
    console.log('Data migration rollback - no action');
  },
}
```

## Best Practices

### 1. Atomic Migrations

Each migration runs in a transaction (`BEGIN IMMEDIATE`). If any part fails, the entire migration is rolled back.

```sql
-- GOOD: Single migration does related changes together
CREATE TABLE new_table (id TEXT PRIMARY KEY);
CREATE INDEX idx_new_table_id ON new_table(id);
INSERT INTO new_table (id) SELECT id FROM old_table;

-- BAD: Don't split related changes across multiple migrations
```

### 2. Idempotent SQL

Use `IF NOT EXISTS` / `IF EXISTS` for safety:

```sql
-- GOOD: Safe to run multiple times
CREATE TABLE IF NOT EXISTS new_table (id TEXT PRIMARY KEY);
ALTER TABLE entries ADD COLUMN IF NOT EXISTS new_field TEXT;

-- BAD: Will error if already exists
CREATE TABLE new_table (id TEXT PRIMARY KEY);
```

### 3. Backwards Compatibility

When possible, make migrations non-breaking:

```sql
-- GOOD: Add optional column
ALTER TABLE entries ADD COLUMN metadata TEXT;

-- RISKY: Removing columns breaks old code
-- Only do this when coordinated with code deployment
ALTER TABLE entries DROP COLUMN old_field;
```

### 4. Write Down Migrations

Always define `down` for rollback capability:

```typescript
// GOOD: Can rollback
{
  version: 5,
  up: 'CREATE TABLE temp (id TEXT);',
  down: 'DROP TABLE temp;',
}

// BAD: Can't rollback (emergency only)
{
  version: 5,
  up: 'CREATE TABLE temp (id TEXT);',
  down: '',  // Empty rollback
}
```

### 5. Test Before Committing

```bash
# Test forward migration
npm run dev

# Verify schema
sqlite3 data/unread-cast.db ".schema"

# Test rollback (if needed)
# Temporarily modify src/db/client.ts:
# migrate(db, migrations, targetVersion);
```

## Rollback Procedure

### Emergency Rollback

If a migration causes production issues:

1. **Identify target version** - Version to rollback to (e.g., 2)

2. **Modify code temporarily** - Edit `src/db/client.ts`:

```typescript
// Change this:
migrate(db, migrations);

// To this (rollback to version 2):
migrate(db, migrations, 2);
```

3. **Restart application**:

```bash
docker-compose restart app
```

4. **Verify rollback**:

```bash
docker-compose exec app sh
sqlite3 /data/unread-cast.db "PRAGMA user_version;"
# Should output: 2
```

5. **Fix migration and revert code** - Fix the problematic migration, then change `client.ts` back:

```typescript
migrate(db, migrations);  // Remove target version
```

6. **Redeploy**:

```bash
docker-compose restart app
```

### Manual Rollback (Direct SQL)

If migration system fails completely:

```bash
# Connect to database
docker-compose exec app sh
sqlite3 /data/unread-cast.db

# Manually run DOWN migration SQL
DROP TABLE problematic_table;

# Reset version
PRAGMA user_version = 1;
```

## Common Patterns

### Adding a Column with Data Migration

```typescript
{
  version: 6,
  up: (db) => {
    // Add column
    db.exec('ALTER TABLE entries ADD COLUMN word_count INTEGER;');

    // Populate with data
    const entries = db.prepare('SELECT id, extracted_content FROM entries').all();
    const stmt = db.prepare('UPDATE entries SET word_count = ? WHERE id = ?');

    for (const entry of entries) {
      if (entry.extracted_content) {
        const count = entry.extracted_content.split(/\s+/).length;
        stmt.run(count, entry.id);
      }
    }
  },
  down: 'ALTER TABLE entries DROP COLUMN word_count;',
}
```

### Renaming a Table

```sql
-- SQLite doesn't support RENAME TABLE directly, use this pattern:
ALTER TABLE old_name RENAME TO new_name;
```

### Changing Column Type

SQLite doesn't support changing column types. Use this pattern:

```typescript
{
  version: 7,
  up: (db) => {
    // Create new table with correct schema
    db.exec(`
      CREATE TABLE entries_new (
        id TEXT PRIMARY KEY,
        retry_count INTEGER DEFAULT 0,  -- Changed from TEXT to INTEGER
        -- ... other columns ...
      );
    `);

    // Copy data with type conversion
    db.exec(`
      INSERT INTO entries_new
      SELECT id, CAST(retry_count AS INTEGER), ...
      FROM entries;
    `);

    // Replace old table
    db.exec('DROP TABLE entries;');
    db.exec('ALTER TABLE entries_new RENAME TO entries;');

    // Recreate indexes
    db.exec('CREATE INDEX idx_entries_status ON entries(status);');
  },
  down: (db) => {
    // Reverse the process
    // ... similar steps in reverse
  },
}
```

## Troubleshooting

### Migration Failed - Transaction Rolled Back

**Symptom**: Error during migration, database unchanged

**Solution**:
- Check migration SQL syntax
- Verify referenced tables/columns exist
- Review error message for details
- Fix migration and restart

### Version Mismatch After Deployment

**Symptom**: Database at version N, code expects version M

**Solution**:
- If N < M: Missing migrations - they'll auto-apply on restart
- If N > M: Code is outdated - deploy latest code
- If stuck: Use rollback procedure above

### Can't Rollback - Down Migration Fails

**Symptom**: Rollback attempt errors

**Solution**:
- Check down migration SQL
- May need manual database intervention
- Restore from backup if critical

### Processing Lock Row Missing

**Symptom**: "Processing lock row not initialized in database"

**Solution**:
- Post-migration seeding in `createDatabase()` handles this
- If missing: `INSERT INTO processing_lock (id) VALUES (1);`

## Database Backups

Before major migrations:

```bash
# Stop application
docker-compose stop app

# Backup database
cp data/unread-cast.db data/unread-cast.db.backup

# Run migration
docker-compose up -d app

# If problems occur, restore:
# docker-compose stop app
# cp data/unread-cast.db.backup data/unread-cast.db
# docker-compose up -d app
```

## Migration Checklist

Before committing a new migration:

- [ ] SQL file created in `migrations/` with sequential number
- [ ] Entry added to `src/db/migrations.ts`
- [ ] `down` migration defined for rollback
- [ ] Tested locally with `npm run dev`
- [ ] Verified database version increased
- [ ] Verified new schema exists (`sqlite3 .tables` / `.schema`)
- [ ] Verified existing data intact
- [ ] Both files committed together
- [ ] Dockerfile includes migrations directory (already done)

## References

- Library: [@blackglory/better-sqlite3-migrations](https://github.com/BlackGlory/better-sqlite3-migrations)
- SQLite ALTER TABLE: https://www.sqlite.org/lang_altertable.html
- SQLite PRAGMA: https://www.sqlite.org/pragma.html
