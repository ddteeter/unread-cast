# Database Migrations

This directory contains SQL migration files used by `@blackglory/better-sqlite3-migrations`.

## File Naming Convention

- Format: `NNN-description.sql` (e.g., `001-initial-schema.sql`)
- Sequential numbering starting from 001
- Use descriptive names (e.g., `002-add-user-preferences.sql`)

## Usage

SQL files are loaded by `src/db/migrations.ts` and executed via the library.
Each migration needs a corresponding entry in the migrations array.

See the project's CLAUDE.md documentation for a detailed guide on creating migrations.

## Current Migrations

- `001-initial-schema.sql` - Baseline schema with entries, episodes, categories, usage_log, and processing_lock tables
