#!/usr/bin/env tsx
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

const description = process.argv[2];
if (!description) {
  console.error('Usage: npm run migration:create <description>');
  console.error('Example: npm run migration:create add-user-preferences');
  process.exit(1);
}

// Read existing migrations.ts to find next version
const migrationsTs = readFileSync('src/db/migrations.ts', 'utf-8');
const versionMatches = migrationsTs.match(/version:\s*(\d+)/g) || [];
const maxVersion = Math.max(0, ...versionMatches.map((m) => parseInt(m.match(/\d+/)![0])));
const nextVersion = maxVersion + 1;

// Create SQL file
const filename = `${String(nextVersion).padStart(3, '0')}-${description}.sql`;
const sqlContent = `-- Migration ${String(nextVersion).padStart(3, '0')}: ${description}
-- Created: ${new Date().toISOString().split('T')[0]}

-- Add your SQL statements here

`;
writeFileSync(join('migrations', filename), sqlContent);

// Instructions for adding to migrations.ts
console.log(`\x1b[32m✓\x1b[0m Created migrations/${filename}`);
console.log('');
console.log('\x1b[1mNext steps:\x1b[0m');
console.log(`1. Edit migrations/${filename} with your SQL`);
console.log('2. Add to src/db/migrations.ts:');
console.log('');
console.log('\x1b[36m   {');
console.log(`     version: ${nextVersion},`);
console.log(`     up: loadSql('${filename}'),`);
console.log(`     down: 'DROP TABLE ...',  // Write your rollback SQL`);
console.log('   },\x1b[0m');
console.log('');
console.log('3. Test: npm run dev');
console.log('4. Commit both files together');
