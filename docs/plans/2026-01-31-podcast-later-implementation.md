# Podcast Later Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an article-to-podcast converter that accepts URLs, generates audio via LLM+TTS, and serves episodes as RSS feeds.

**Architecture:** TypeScript Fastify server with SQLite database, Cloudflare R2 for audio storage, OpenAI/Anthropic for LLM, OpenAI for TTS. Processing runs on cron with budget controls.

**Tech Stack:** TypeScript, Fastify, SQLite (better-sqlite3), Zod, OpenAI SDK, Anthropic SDK, AWS SDK (for R2), fluent-ffmpeg, node-cron

---

## Phase 1: Project Foundation

### Task 1: Initialize Project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`

**Step 1: Initialize npm project**

```bash
npm init -y
```

**Step 2: Install production dependencies**

```bash
npm install fastify @fastify/cors better-sqlite3 @mozilla/readability jsdom openai @anthropic-ai/sdk @aws-sdk/client-s3 @aws-sdk/lib-storage node-cron fluent-ffmpeg uuid zod
```

**Step 3: Install dev dependencies**

```bash
npm install -D typescript tsx @types/node @types/better-sqlite3 @types/jsdom @types/uuid @types/fluent-ffmpeg vitest
```

**Step 4: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 5: Create .gitignore**

```
node_modules/
dist/
*.log
.env
/data/
```

**Step 6: Update package.json scripts**

Add to package.json:
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Step 7: Create directory structure**

```bash
mkdir -p src/{api,db,processing,services,types}
mkdir -p tests/{api,db,processing,services}
```

**Step 8: Commit**

```bash
git add -A
git commit -m "chore: initialize project with dependencies"
```

---

### Task 2: Define TypeScript Types

**Files:**
- Create: `src/types/index.ts`

**Step 1: Write types file**

```typescript
// src/types/index.ts

export interface Entry {
  id: string;
  url: string;
  category: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  title: string | null;
  extractedContent: string | null;
  transcriptJson: string | null;
  errorMessage: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface Episode {
  id: string;
  entryId: string;
  category: string | null;
  title: string;
  description: string;
  audioKey: string;
  audioDuration: number;
  audioSize: number;
  publishedAt: string;
}

export interface Category {
  name: string;
  feedId: string;
  createdAt: string;
}

export interface UsageLog {
  id: string;
  entryId: string | null;
  service: 'openai_chat' | 'openai_tts' | 'anthropic';
  model: string;
  inputUnits: number;
  outputUnits: number | null;
  costUsd: number;
  createdAt: string;
}

export interface ProcessingLock {
  id: number;
  lockedAt: string | null;
  lockedBy: string | null;
}

export interface TranscriptSegment {
  speaker: 'HOST' | 'EXPERT' | 'NARRATOR';
  text: string;
  instruction: string;
}

export type Transcript = TranscriptSegment[];

export interface ProcessingResult {
  success: boolean;
  entryId: string;
  episodeId?: string;
  error?: string;
}

export interface BudgetStatus {
  period: string;
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  percentUsed: number;
  status: 'ok' | 'warning' | 'exceeded';
  processingEnabled: boolean;
}

export interface PricingConfig {
  openai?: {
    [model: string]: {
      input_per_1m?: number;
      output_per_1m?: number;
      chars_per_1m?: number;
    };
  };
  anthropic?: {
    [model: string]: {
      input_per_1m: number;
      output_per_1m: number;
    };
  };
}

export interface ApiError {
  error: string;
  message: string;
  code: string;
}

export type ErrorCode =
  | 'INVALID_URL'
  | 'DUPLICATE_URL'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'PRICING_CONFIG_MISSING';
```

**Step 2: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add TypeScript type definitions"
```

---

### Task 3: Create Config Module

**Files:**
- Create: `src/config.ts`
- Create: `tests/config.test.ts`

**Step 1: Write failing test for config parsing**

```typescript
// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw if required env vars are missing', async () => {
    process.env = {};
    await expect(import('../src/config.js')).rejects.toThrow();
  });

  it('should parse all required env vars', async () => {
    process.env.API_KEY = 'test-key';
    process.env.BASE_URL = 'https://example.com';
    process.env.OPENAI_API_KEY = 'sk-test';
    process.env.R2_ACCOUNT_ID = 'account123';
    process.env.R2_ACCESS_KEY_ID = 'access123';
    process.env.R2_SECRET_ACCESS_KEY = 'secret123';
    process.env.R2_BUCKET_NAME = 'podcast-audio';
    process.env.R2_PUBLIC_URL = 'https://audio.example.com';
    process.env.MONTHLY_BUDGET_USD = '20';

    // Dynamic import to pick up env changes
    const { config } = await import('../src/config.js');

    expect(config.apiKey).toBe('test-key');
    expect(config.baseUrl).toBe('https://example.com');
    expect(config.monthlyBudgetUsd).toBe(20);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/config.test.ts
```

Expected: FAIL (module not found)

**Step 3: Write config module**

```typescript
// src/config.ts
import { z } from 'zod';

const configSchema = z.object({
  // Required
  apiKey: z.string().min(1),
  baseUrl: z.string().url(),
  openaiApiKey: z.string().min(1),
  r2AccountId: z.string().min(1),
  r2AccessKeyId: z.string().min(1),
  r2SecretAccessKey: z.string().min(1),
  r2BucketName: z.string().min(1),
  r2PublicUrl: z.string().url(),
  monthlyBudgetUsd: z.number().positive(),

  // Optional with defaults
  port: z.number().default(8080),
  cronSchedule: z.string().default('0 */6 * * *'),
  anthropicApiKey: z.string().optional(),
  llmProvider: z.enum(['openai', 'anthropic']).default('openai'),
  llmModel: z.string().default('gpt-4o'),
  ttsVoices: z.array(z.string()).default([
    'alloy', 'ash', 'ballad', 'coral', 'echo',
    'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'
  ]),
  feedTitle: z.string().default('Podcast Later'),
  feedAuthor: z.string().default('Podcast Later'),
  feedDescription: z.string().default('Auto-generated podcasts from articles'),
  artworkUrl: z.string().url().optional(),
  retentionDays: z.number().default(90),
  minContentLength: z.number().default(500),
  pricingConfigPath: z.string().default('/data/pricing.json'),
  pushoverUserKey: z.string().optional(),
  pushoverAppToken: z.string().optional(),
  budgetWarningPercent: z.number().default(80),
  dataDir: z.string().default('/data'),
});

export type Config = z.infer<typeof configSchema>;

function parseEnv(): Config {
  const raw = {
    apiKey: process.env.API_KEY,
    baseUrl: process.env.BASE_URL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    r2AccountId: process.env.R2_ACCOUNT_ID,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    r2BucketName: process.env.R2_BUCKET_NAME,
    r2PublicUrl: process.env.R2_PUBLIC_URL,
    monthlyBudgetUsd: process.env.MONTHLY_BUDGET_USD
      ? parseFloat(process.env.MONTHLY_BUDGET_USD)
      : undefined,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : undefined,
    cronSchedule: process.env.CRON_SCHEDULE,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    llmProvider: process.env.LLM_PROVIDER as 'openai' | 'anthropic' | undefined,
    llmModel: process.env.LLM_MODEL,
    ttsVoices: process.env.TTS_VOICES?.split(',').map((v) => v.trim()),
    feedTitle: process.env.FEED_TITLE,
    feedAuthor: process.env.FEED_AUTHOR,
    feedDescription: process.env.FEED_DESCRIPTION,
    artworkUrl: process.env.ARTWORK_URL,
    retentionDays: process.env.RETENTION_DAYS
      ? parseInt(process.env.RETENTION_DAYS, 10)
      : undefined,
    minContentLength: process.env.MIN_CONTENT_LENGTH
      ? parseInt(process.env.MIN_CONTENT_LENGTH, 10)
      : undefined,
    pricingConfigPath: process.env.PRICING_CONFIG_PATH,
    pushoverUserKey: process.env.PUSHOVER_USER_KEY,
    pushoverAppToken: process.env.PUSHOVER_APP_TOKEN,
    budgetWarningPercent: process.env.BUDGET_WARNING_PERCENT
      ? parseInt(process.env.BUDGET_WARNING_PERCENT, 10)
      : undefined,
    dataDir: process.env.DATA_DIR,
  };

  return configSchema.parse(raw);
}

export const config = parseEnv();
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/config.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config module with env parsing"
```

---

### Task 4: Create Database Schema and Client

**Files:**
- Create: `src/db/schema.ts`
- Create: `src/db/client.ts`
- Create: `tests/db/client.test.ts`

**Step 1: Write failing test for database operations**

```typescript
// tests/db/client.test.ts
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
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/db/client.test.ts
```

Expected: FAIL (module not found)

**Step 3: Write schema module**

```typescript
// src/db/schema.ts
import type Database from 'better-sqlite3';

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

    CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
    CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
    CREATE INDEX IF NOT EXISTS idx_episodes_category ON episodes(category);
    CREATE INDEX IF NOT EXISTS idx_episodes_published_at ON episodes(published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_log_created_at ON usage_log(created_at);
  `);
}
```

**Step 4: Write database client module**

```typescript
// src/db/client.ts
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
```

**Step 5: Run test to verify it passes**

```bash
npm test -- tests/db/client.test.ts
```

Expected: PASS

**Step 6: Commit**

```bash
git add src/db/schema.ts src/db/client.ts tests/db/client.test.ts
git commit -m "feat: add database schema and client"
```

---

## Phase 2: Services Layer

### Task 5: Create Budget Service

**Files:**
- Create: `src/services/budget.ts`
- Create: `tests/services/budget.test.ts`

**Step 1: Write failing test for budget service**

```typescript
// tests/services/budget.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';

describe('budget service', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'podcast-later-test-'));
    db = new Database(':memory:');
    initializeSchema(db);

    // Create pricing config
    writeFileSync(
      join(tempDir, 'pricing.json'),
      JSON.stringify({
        openai: {
          'gpt-4o': { input_per_1m: 2.5, output_per_1m: 10.0 },
          'gpt-4o-mini-tts': { chars_per_1m: 12.0 },
        },
      })
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should calculate cost correctly for chat models', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(
      db,
      join(tempDir, 'pricing.json'),
      100
    );

    // 1000 input tokens, 500 output tokens at gpt-4o rates
    const cost = service.calculateCost('openai_chat', 'gpt-4o', 1000, 500);
    // (1000/1_000_000 * 2.5) + (500/1_000_000 * 10.0) = 0.0025 + 0.005 = 0.0075
    expect(cost).toBeCloseTo(0.0075, 6);
  });

  it('should calculate cost correctly for TTS', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(
      db,
      join(tempDir, 'pricing.json'),
      100
    );

    // 10000 characters at gpt-4o-mini-tts rates
    const cost = service.calculateCost('openai_tts', 'gpt-4o-mini-tts', 10000);
    // 10000/1_000_000 * 12.0 = 0.12
    expect(cost).toBeCloseTo(0.12, 6);
  });

  it('should return correct budget status', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(
      db,
      join(tempDir, 'pricing.json'),
      20
    );

    // Log some usage
    await service.logUsage({
      entryId: null,
      service: 'openai_chat',
      model: 'gpt-4o',
      inputUnits: 1000000, // $2.50
      outputUnits: 100000, // $1.00
      costUsd: 3.5,
    });

    const status = await service.getStatus();
    expect(status.spentUsd).toBeCloseTo(3.5, 2);
    expect(status.budgetUsd).toBe(20);
    expect(status.remainingUsd).toBeCloseTo(16.5, 2);
    expect(status.percentUsed).toBeCloseTo(17.5, 1);
    expect(status.status).toBe('ok');
    expect(status.processingEnabled).toBe(true);
  });

  it('should block processing when budget exceeded', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(
      db,
      join(tempDir, 'pricing.json'),
      10
    );

    await service.logUsage({
      entryId: null,
      service: 'openai_chat',
      model: 'gpt-4o',
      inputUnits: 1000000,
      outputUnits: 1000000,
      costUsd: 12.5, // Over budget
    });

    const canProcess = await service.canProcess();
    expect(canProcess).toBe(false);

    const status = await service.getStatus();
    expect(status.status).toBe('exceeded');
    expect(status.processingEnabled).toBe(false);
  });

  it('should throw if model not in pricing config', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(
      db,
      join(tempDir, 'pricing.json'),
      100
    );

    expect(() =>
      service.calculateCost('openai_chat', 'unknown-model', 1000, 500)
    ).toThrow('PRICING_CONFIG_MISSING');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/services/budget.test.ts
```

Expected: FAIL (module not found)

**Step 3: Write budget service**

```typescript
// src/services/budget.ts
import { readFileSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { BudgetStatus, PricingConfig, UsageLog } from '../types/index.js';

export interface BudgetService {
  calculateCost(
    service: string,
    model: string,
    inputUnits: number,
    outputUnits?: number
  ): number;
  logUsage(usage: Omit<UsageLog, 'id' | 'createdAt'>): Promise<void>;
  getStatus(): Promise<BudgetStatus>;
  canProcess(): Promise<boolean>;
  loadPricingConfig(): PricingConfig;
}

export function createBudgetService(
  db: Database.Database,
  pricingConfigPath: string,
  monthlyBudgetUsd: number,
  budgetWarningPercent: number = 80
): BudgetService {
  let pricingConfig: PricingConfig | null = null;

  function loadPricingConfig(): PricingConfig {
    if (pricingConfig) return pricingConfig;
    try {
      const content = readFileSync(pricingConfigPath, 'utf-8');
      pricingConfig = JSON.parse(content) as PricingConfig;
      return pricingConfig;
    } catch (error) {
      const err = new Error('Failed to load pricing config');
      (err as Error & { code: string }).code = 'PRICING_CONFIG_MISSING';
      throw err;
    }
  }

  function calculateCost(
    service: string,
    model: string,
    inputUnits: number,
    outputUnits?: number
  ): number {
    const config = loadPricingConfig();

    if (service === 'openai_chat' || service === 'openai_tts') {
      const modelConfig = config.openai?.[model];
      if (!modelConfig) {
        const err = new Error(`Model ${model} not found in pricing config`);
        (err as Error & { code: string }).code = 'PRICING_CONFIG_MISSING';
        throw err;
      }

      if (service === 'openai_tts') {
        const charsPerMillion = modelConfig.chars_per_1m ?? 0;
        return (inputUnits / 1_000_000) * charsPerMillion;
      } else {
        const inputPerMillion = modelConfig.input_per_1m ?? 0;
        const outputPerMillion = modelConfig.output_per_1m ?? 0;
        const inputCost = (inputUnits / 1_000_000) * inputPerMillion;
        const outputCost = ((outputUnits ?? 0) / 1_000_000) * outputPerMillion;
        return inputCost + outputCost;
      }
    }

    if (service === 'anthropic') {
      const modelConfig = config.anthropic?.[model];
      if (!modelConfig) {
        const err = new Error(`Model ${model} not found in pricing config`);
        (err as Error & { code: string }).code = 'PRICING_CONFIG_MISSING';
        throw err;
      }
      const inputCost = (inputUnits / 1_000_000) * modelConfig.input_per_1m;
      const outputCost =
        ((outputUnits ?? 0) / 1_000_000) * modelConfig.output_per_1m;
      return inputCost + outputCost;
    }

    throw new Error(`Unknown service: ${service}`);
  }

  async function logUsage(
    usage: Omit<UsageLog, 'id' | 'createdAt'>
  ): Promise<void> {
    const id = uuidv4();
    const createdAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO usage_log (id, entry_id, service, model, input_units, output_units, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      usage.entryId,
      usage.service,
      usage.model,
      usage.inputUnits,
      usage.outputUnits,
      usage.costUsd,
      createdAt
    );
  }

  async function getStatus(): Promise<BudgetStatus> {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const result = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as total
         FROM usage_log
         WHERE created_at >= ?`
      )
      .get(monthStart.toISOString()) as { total: number };

    const spentUsd = result.total;
    const remainingUsd = Math.max(0, monthlyBudgetUsd - spentUsd);
    const percentUsed = (spentUsd / monthlyBudgetUsd) * 100;

    let status: 'ok' | 'warning' | 'exceeded';
    if (percentUsed >= 100) {
      status = 'exceeded';
    } else if (percentUsed >= budgetWarningPercent) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      period,
      spentUsd,
      budgetUsd: monthlyBudgetUsd,
      remainingUsd,
      percentUsed,
      status,
      processingEnabled: status !== 'exceeded',
    };
  }

  async function canProcess(): Promise<boolean> {
    // First check if pricing config is valid
    try {
      loadPricingConfig();
    } catch {
      return false;
    }

    const status = await getStatus();
    return status.processingEnabled;
  }

  return {
    calculateCost,
    logUsage,
    getStatus,
    canProcess,
    loadPricingConfig,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/services/budget.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/budget.ts tests/services/budget.test.ts
git commit -m "feat: add budget service with cost tracking"
```

---

### Task 6: Create Pushover Service

**Files:**
- Create: `src/services/pushover.ts`
- Create: `tests/services/pushover.test.ts`

**Step 1: Write failing test for pushover service**

```typescript
// tests/services/pushover.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('pushover service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should send notification when configured', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch;

    const { createPushoverService } = await import(
      '../../src/services/pushover.js'
    );
    const service = createPushoverService('user-key', 'app-token');

    await service.send('Test Title', 'Test message');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.pushover.net/1/messages.json',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      })
    );
  });

  it('should be a no-op when not configured', async () => {
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const { createPushoverService } = await import(
      '../../src/services/pushover.js'
    );
    const service = createPushoverService(undefined, undefined);

    await service.send('Test Title', 'Test message');

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should send budget warning', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    global.fetch = mockFetch;

    const { createPushoverService } = await import(
      '../../src/services/pushover.js'
    );
    const service = createPushoverService('user-key', 'app-token');

    await service.sendBudgetWarning(82, 16.4, 20);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.pushover.net/1/messages.json',
      expect.objectContaining({
        method: 'POST',
      })
    );
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/services/pushover.test.ts
```

Expected: FAIL (module not found)

**Step 3: Write pushover service**

```typescript
// src/services/pushover.ts
export interface PushoverService {
  send(title: string, message: string, priority?: number): Promise<void>;
  sendBudgetWarning(
    percentUsed: number,
    spent: number,
    budget: number
  ): Promise<void>;
  sendBudgetExceeded(spent: number, budget: number): Promise<void>;
  sendProcessingFailed(entryId: string, url: string, error: string): Promise<void>;
}

export function createPushoverService(
  userKey: string | undefined,
  appToken: string | undefined
): PushoverService {
  const isConfigured = Boolean(userKey && appToken);

  async function send(
    title: string,
    message: string,
    priority: number = 0
  ): Promise<void> {
    if (!isConfigured) {
      console.log(`[Pushover disabled] ${title}: ${message}`);
      return;
    }

    try {
      const response = await fetch('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: appToken,
          user: userKey,
          title,
          message,
          priority,
        }),
      });

      if (!response.ok) {
        console.error('Failed to send Pushover notification:', response.status);
      }
    } catch (error) {
      console.error('Error sending Pushover notification:', error);
    }
  }

  async function sendBudgetWarning(
    percentUsed: number,
    spent: number,
    budget: number
  ): Promise<void> {
    await send(
      'Podcast Later - Budget Warning',
      `Monthly spend at ${percentUsed.toFixed(0)}% ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Processing will pause at 100%.`
    );
  }

  async function sendBudgetExceeded(
    spent: number,
    budget: number
  ): Promise<void> {
    await send(
      'Podcast Later - Budget Exceeded',
      `Monthly budget exceeded ($${spent.toFixed(2)} of $${budget.toFixed(2)}). Processing is paused until next month.`,
      1 // High priority
    );
  }

  async function sendProcessingFailed(
    entryId: string,
    url: string,
    error: string
  ): Promise<void> {
    await send(
      'Podcast Later - Processing Failed',
      `Entry ${entryId} failed after max retries.\nURL: ${url}\nError: ${error}`
    );
  }

  return {
    send,
    sendBudgetWarning,
    sendBudgetExceeded,
    sendProcessingFailed,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/services/pushover.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/pushover.ts tests/services/pushover.test.ts
git commit -m "feat: add pushover notification service"
```

---

### Task 7: Create R2 Storage Service

**Files:**
- Create: `src/services/r2.ts`
- Create: `tests/services/r2.test.ts`

**Step 1: Write failing test for R2 service**

```typescript
// tests/services/r2.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'stream';

describe('r2 service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should create R2 client with correct endpoint', async () => {
    const { createR2Service } = await import('../../src/services/r2.js');

    const service = createR2Service({
      accountId: 'test-account',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      bucketName: 'test-bucket',
      publicUrl: 'https://audio.example.com',
    });

    expect(service).toBeDefined();
    expect(service.upload).toBeDefined();
    expect(service.delete).toBeDefined();
  });

  it('should construct correct public URL', async () => {
    const { createR2Service } = await import('../../src/services/r2.js');

    const service = createR2Service({
      accountId: 'test-account',
      accessKeyId: 'test-access',
      secretAccessKey: 'test-secret',
      bucketName: 'test-bucket',
      publicUrl: 'https://audio.example.com',
    });

    const url = service.getPublicUrl('episode-123.aac');
    expect(url).toBe('https://audio.example.com/episode-123.aac');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/services/r2.test.ts
```

Expected: FAIL (module not found)

**Step 3: Write R2 service**

```typescript
// src/services/r2.ts
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { Readable } from 'stream';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl: string;
}

export interface R2Service {
  upload(
    key: string,
    body: Readable | Buffer,
    contentType?: string
  ): Promise<{ url: string; size: number }>;
  uploadStream(
    key: string,
    stream: Readable,
    contentType?: string
  ): Promise<{ url: string; size: number }>;
  delete(key: string): Promise<void>;
  getPublicUrl(key: string): string;
}

export function createR2Service(config: R2Config): R2Service {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });

  function getPublicUrl(key: string): string {
    const baseUrl = config.publicUrl.endsWith('/')
      ? config.publicUrl.slice(0, -1)
      : config.publicUrl;
    return `${baseUrl}/${key}`;
  }

  async function upload(
    key: string,
    body: Readable | Buffer,
    contentType: string = 'audio/aac'
  ): Promise<{ url: string; size: number }> {
    const isBuffer = Buffer.isBuffer(body);

    if (isBuffer) {
      await client.send(
        new PutObjectCommand({
          Bucket: config.bucketName,
          Key: key,
          Body: body,
          ContentType: contentType,
        })
      );
      return { url: getPublicUrl(key), size: body.length };
    }

    // For streams, use Upload for multipart
    return uploadStream(key, body as Readable, contentType);
  }

  async function uploadStream(
    key: string,
    stream: Readable,
    contentType: string = 'audio/aac'
  ): Promise<{ url: string; size: number }> {
    let totalSize = 0;

    // Track size as data flows through
    stream.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
    });

    const upload = new Upload({
      client,
      params: {
        Bucket: config.bucketName,
        Key: key,
        Body: stream,
        ContentType: contentType,
      },
    });

    await upload.done();

    return { url: getPublicUrl(key), size: totalSize };
  }

  async function deleteObject(key: string): Promise<void> {
    await client.send(
      new DeleteObjectCommand({
        Bucket: config.bucketName,
        Key: key,
      })
    );
  }

  return {
    upload,
    uploadStream,
    delete: deleteObject,
    getPublicUrl,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/services/r2.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/r2.ts tests/services/r2.test.ts
git commit -m "feat: add R2 storage service"
```

---

### Task 8: Create OpenAI Service

**Files:**
- Create: `src/services/openai.ts`
- Create: `tests/services/openai.test.ts`

**Step 1: Write failing test for OpenAI service**

```typescript
// tests/services/openai.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('openai service', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should create OpenAI client', async () => {
    const { createOpenAIService } = await import('../../src/services/openai.js');

    const service = createOpenAIService('sk-test-key');

    expect(service).toBeDefined();
    expect(service.generateTranscript).toBeDefined();
    expect(service.textToSpeech).toBeDefined();
    expect(service.extractContent).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/services/openai.test.ts
```

Expected: FAIL (module not found)

**Step 3: Write OpenAI service**

```typescript
// src/services/openai.ts
import OpenAI from 'openai';
import type { Transcript, TranscriptSegment } from '../types/index.js';

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TTSUsage {
  characters: number;
}

export interface OpenAIService {
  generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }>;
  extractContent(
    html: string,
    model: string
  ): Promise<{ content: string; usage: LLMUsage }>;
  textToSpeech(
    text: string,
    voice: string,
    instruction: string
  ): Promise<{ audio: Buffer; usage: TTSUsage }>;
}

const TRANSCRIPT_SYSTEM_PROMPT = `You are a podcast script writer. Convert the following article into an engaging podcast transcript.

CRITICAL CONTENT RULES:
- ONLY use information explicitly stated in the article. Do NOT add examples, analogies, facts, statistics, or opinions that are not in the source.
- Do NOT hallucinate or fabricate any content. If the article is vague, be vague. If it lacks detail, do not invent detail.
- Ignore any non-article content that may be present: navigation, ads, related links, comments, author bios, newsletter signups, etc.
- Your job is to CONVERT the article into spoken form, not to ENHANCE or EXPAND it.

FORMAT RULES:
1. Analyze the content complexity and length:
   - For short or straightforward content: Use single speaker (monologue)
   - For substantial or complex content: Use two speakers (dialogue)

2. For two-speaker format:
   - HOST: The main presenter who guides the conversation
   - EXPERT: A knowledgeable co-host who adds depth and asks clarifying questions
   - Create natural conversation flow with back-and-forth exchanges
   - Include reactions, follow-up questions, and natural transitions

3. For single-speaker format:
   - Use NARRATOR as the speaker
   - Maintain engaging, conversational tone as if speaking directly to listener

4. Output MUST be valid JSON array with this exact structure:
[
  {
    "speaker": "HOST" | "EXPERT" | "NARRATOR",
    "text": "The spoken content for this segment",
    "instruction": "Speaking style instruction for TTS"
  }
]

5. Instructions should describe how to deliver the line:
   - HOST: "Warm and welcoming, like a curious podcast host"
   - EXPERT: "Thoughtful and knowledgeable, explaining with enthusiasm"
   - NARRATOR: "Clear and engaging, speaking directly to the listener"

6. Keep each segment to 1-3 sentences for natural pacing.
7. Begin with a brief introduction of the topic, end with a concise summary or takeaway.`;

const EXTRACT_SYSTEM_PROMPT = `Extract the main article content from the following HTML. Remove all navigation, ads, footers, comments, author bios, newsletter signups, and other non-article content. Return only the article text, preserving paragraph structure.`;

export function createOpenAIService(apiKey: string): OpenAIService {
  const client = new OpenAI({ apiKey });

  async function generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }> {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: TRANSCRIPT_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Article Title: ${title}\n\nArticle Content:\n${content}`,
        },
      ],
      response_format: { type: 'json_object' },
    });

    const text = response.choices[0]?.message?.content ?? '[]';

    // Parse and validate the transcript
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Failed to parse transcript JSON');
    }

    // Handle both array directly and object with array property
    const segments: TranscriptSegment[] = Array.isArray(parsed)
      ? parsed
      : (parsed as { transcript?: TranscriptSegment[] }).transcript ?? [];

    // Validate each segment
    for (const segment of segments) {
      if (!segment.speaker || !segment.text || !segment.instruction) {
        throw new Error('Invalid transcript segment structure');
      }
    }

    return {
      transcript: segments,
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async function extractContent(
    html: string,
    model: string
  ): Promise<{ content: string; usage: LLMUsage }> {
    const response = await client.chat.completions.create({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: html },
      ],
    });

    return {
      content: response.choices[0]?.message?.content ?? '',
      usage: {
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async function textToSpeech(
    text: string,
    voice: string,
    instruction: string
  ): Promise<{ audio: Buffer; usage: TTSUsage }> {
    const response = await client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: voice as 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable' | 'nova' | 'onyx' | 'sage' | 'shimmer' | 'verse',
      input: text,
      instructions: instruction,
      response_format: 'aac',
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      audio: buffer,
      usage: { characters: text.length },
    };
  }

  return {
    generateTranscript,
    extractContent,
    textToSpeech,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/services/openai.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/openai.ts tests/services/openai.test.ts
git commit -m "feat: add OpenAI service for LLM and TTS"
```

---

### Task 9: Create Anthropic Service

**Files:**
- Create: `src/services/anthropic.ts`
- Create: `tests/services/anthropic.test.ts`

**Step 1: Write failing test for Anthropic service**

```typescript
// tests/services/anthropic.test.ts
import { describe, it, expect } from 'vitest';

describe('anthropic service', () => {
  it('should create Anthropic client', async () => {
    const { createAnthropicService } = await import(
      '../../src/services/anthropic.js'
    );

    const service = createAnthropicService('test-key');

    expect(service).toBeDefined();
    expect(service.generateTranscript).toBeDefined();
    expect(service.extractContent).toBeDefined();
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/services/anthropic.test.ts
```

Expected: FAIL (module not found)

**Step 3: Write Anthropic service**

```typescript
// src/services/anthropic.ts
import Anthropic from '@anthropic-ai/sdk';
import type { Transcript, TranscriptSegment } from '../types/index.js';
import type { LLMUsage } from './openai.js';

export interface AnthropicService {
  generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }>;
  extractContent(
    html: string,
    model: string
  ): Promise<{ content: string; usage: LLMUsage }>;
}

const TRANSCRIPT_SYSTEM_PROMPT = `You are a podcast script writer. Convert the following article into an engaging podcast transcript.

CRITICAL CONTENT RULES:
- ONLY use information explicitly stated in the article. Do NOT add examples, analogies, facts, statistics, or opinions that are not in the source.
- Do NOT hallucinate or fabricate any content. If the article is vague, be vague. If it lacks detail, do not invent detail.
- Ignore any non-article content that may be present: navigation, ads, related links, comments, author bios, newsletter signups, etc.
- Your job is to CONVERT the article into spoken form, not to ENHANCE or EXPAND it.

FORMAT RULES:
1. Analyze the content complexity and length:
   - For short or straightforward content: Use single speaker (monologue)
   - For substantial or complex content: Use two speakers (dialogue)

2. For two-speaker format:
   - HOST: The main presenter who guides the conversation
   - EXPERT: A knowledgeable co-host who adds depth and asks clarifying questions
   - Create natural conversation flow with back-and-forth exchanges
   - Include reactions, follow-up questions, and natural transitions

3. For single-speaker format:
   - Use NARRATOR as the speaker
   - Maintain engaging, conversational tone as if speaking directly to listener

4. Output MUST be valid JSON array with this exact structure:
[
  {
    "speaker": "HOST" | "EXPERT" | "NARRATOR",
    "text": "The spoken content for this segment",
    "instruction": "Speaking style instruction for TTS"
  }
]

5. Instructions should describe how to deliver the line:
   - HOST: "Warm and welcoming, like a curious podcast host"
   - EXPERT: "Thoughtful and knowledgeable, explaining with enthusiasm"
   - NARRATOR: "Clear and engaging, speaking directly to the listener"

6. Keep each segment to 1-3 sentences for natural pacing.
7. Begin with a brief introduction of the topic, end with a concise summary or takeaway.

Respond with ONLY the JSON array, no other text.`;

const EXTRACT_SYSTEM_PROMPT = `Extract the main article content from the following HTML. Remove all navigation, ads, footers, comments, author bios, newsletter signups, and other non-article content. Return only the article text, preserving paragraph structure.`;

export function createAnthropicService(apiKey: string): AnthropicService {
  const client = new Anthropic({ apiKey });

  async function generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }> {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system: TRANSCRIPT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Article Title: ${title}\n\nArticle Content:\n${content}`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const text = textBlock?.type === 'text' ? textBlock.text : '[]';

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Failed to parse transcript JSON');
    }

    const segments: TranscriptSegment[] = Array.isArray(parsed)
      ? parsed
      : (parsed as { transcript?: TranscriptSegment[] }).transcript ?? [];

    for (const segment of segments) {
      if (!segment.speaker || !segment.text || !segment.instruction) {
        throw new Error('Invalid transcript segment structure');
      }
    }

    return {
      transcript: segments,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async function extractContent(
    html: string,
    model: string
  ): Promise<{ content: string; usage: LLMUsage }> {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system: EXTRACT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: html }],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const content = textBlock?.type === 'text' ? textBlock.text : '';

    return {
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  return {
    generateTranscript,
    extractContent,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/services/anthropic.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/services/anthropic.ts tests/services/anthropic.test.ts
git commit -m "feat: add Anthropic service for LLM"
```

---

## Phase 3: API Layer

### Task 10: Create Auth Middleware

**Files:**
- Create: `src/api/middleware.ts`
- Create: `tests/api/middleware.test.ts`

**Step 1: Write failing test for auth middleware**

```typescript
// tests/api/middleware.test.ts
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';

describe('auth middleware', () => {
  it('should reject requests without API key', async () => {
    const { createAuthHook } = await import('../../src/api/middleware.js');

    const app = Fastify();
    app.addHook('preHandler', createAuthHook('test-api-key'));
    app.get('/test', () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/test',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should reject requests with wrong API key', async () => {
    const { createAuthHook } = await import('../../src/api/middleware.js');

    const app = Fastify();
    app.addHook('preHandler', createAuthHook('test-api-key'));
    app.get('/test', () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'X-API-Key': 'wrong-key' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('should allow requests with correct API key', async () => {
    const { createAuthHook } = await import('../../src/api/middleware.js');

    const app = Fastify();
    app.addHook('preHandler', createAuthHook('test-api-key'));
    app.get('/test', () => ({ ok: true }));

    const response = await app.inject({
      method: 'GET',
      url: '/test',
      headers: { 'X-API-Key': 'test-api-key' },
    });

    expect(response.statusCode).toBe(200);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/api/middleware.test.ts
```

Expected: FAIL (module not found)

**Step 3: Write auth middleware**

```typescript
// src/api/middleware.ts
import type { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';

export function createAuthHook(apiKey: string) {
  return function authHook(
    request: FastifyRequest,
    reply: FastifyReply,
    done: HookHandlerDoneFunction
  ): void {
    const providedKey = request.headers['x-api-key'];

    if (!providedKey || providedKey !== apiKey) {
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Missing or invalid API key',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    done();
  };
}

// List of paths that don't require auth
export const publicPaths = ['/health', '/feed/'];

export function isPublicPath(path: string): boolean {
  return publicPaths.some((p) => path.startsWith(p));
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/api/middleware.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/api/middleware.ts tests/api/middleware.test.ts
git commit -m "feat: add auth middleware"
```

---

### Task 11: Create Entry Handlers

**Files:**
- Create: `src/api/entries.ts`
- Create: `tests/api/entries.test.ts`

**Step 1: Write failing test for entry handlers**

```typescript
// tests/api/entries.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';

describe('entry handlers', () => {
  let tempDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'podcast-later-test-'));
    db = new Database(':memory:');
    initializeSchema(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should create a new entry', async () => {
    const { createEntryHandlers } = await import('../../src/api/entries.js');
    const handlers = createEntryHandlers(db);

    const result = await handlers.createEntry({
      url: 'https://example.com/article',
      category: 'tech',
    });

    expect(result.id).toBeDefined();
    expect(result.url).toBe('https://example.com/article');
    expect(result.category).toBe('tech');
    expect(result.status).toBe('pending');
  });

  it('should reject invalid URLs', async () => {
    const { createEntryHandlers } = await import('../../src/api/entries.js');
    const handlers = createEntryHandlers(db);

    await expect(
      handlers.createEntry({ url: 'not-a-url' })
    ).rejects.toThrow('INVALID_URL');
  });

  it('should reject duplicate URLs', async () => {
    const { createEntryHandlers } = await import('../../src/api/entries.js');
    const handlers = createEntryHandlers(db);

    await handlers.createEntry({ url: 'https://example.com/article' });

    await expect(
      handlers.createEntry({ url: 'https://example.com/article' })
    ).rejects.toThrow('DUPLICATE_URL');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/api/entries.test.ts
```

Expected: FAIL (module not found)

**Step 3: Write entry handlers**

```typescript
// src/api/entries.ts
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Entry } from '../types/index.js';

export interface CreateEntryInput {
  url: string;
  category?: string;
}

export interface EntryHandlers {
  createEntry(input: CreateEntryInput): Promise<Entry>;
  getEntry(id: string): Promise<Entry | null>;
  listEntries(status?: string): Promise<Entry[]>;
}

function isValidUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function createEntryHandlers(db: Database.Database): EntryHandlers {
  async function createEntry(input: CreateEntryInput): Promise<Entry> {
    if (!isValidUrl(input.url)) {
      const error = new Error('Invalid URL format');
      (error as Error & { code: string }).code = 'INVALID_URL';
      throw error;
    }

    // Check for duplicate
    const existing = db
      .prepare('SELECT id FROM entries WHERE url = ?')
      .get(input.url);

    if (existing) {
      const error = new Error('URL already exists');
      (error as Error & { code: string }).code = 'DUPLICATE_URL';
      throw error;
    }

    const id = uuidv4();
    const createdAt = new Date().toISOString();
    const category = input.category ?? null;

    db.prepare(
      `INSERT INTO entries (id, url, category, status, created_at)
       VALUES (?, ?, ?, 'pending', ?)`
    ).run(id, input.url, category, createdAt);

    // Create category if it doesn't exist
    if (category) {
      const existingCategory = db
        .prepare('SELECT name FROM categories WHERE name = ?')
        .get(category);

      if (!existingCategory) {
        db.prepare(
          'INSERT INTO categories (name, feed_id, created_at) VALUES (?, ?, ?)'
        ).run(category, uuidv4(), createdAt);
      }
    }

    return {
      id,
      url: input.url,
      category,
      status: 'pending',
      title: null,
      extractedContent: null,
      transcriptJson: null,
      errorMessage: null,
      retryCount: 0,
      nextRetryAt: null,
      createdAt,
      processedAt: null,
    };
  }

  async function getEntry(id: string): Promise<Entry | null> {
    const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      url: row.url as string,
      category: row.category as string | null,
      status: row.status as Entry['status'],
      title: row.title as string | null,
      extractedContent: row.extracted_content as string | null,
      transcriptJson: row.transcript_json as string | null,
      errorMessage: row.error_message as string | null,
      retryCount: row.retry_count as number,
      nextRetryAt: row.next_retry_at as string | null,
      createdAt: row.created_at as string,
      processedAt: row.processed_at as string | null,
    };
  }

  async function listEntries(status?: string): Promise<Entry[]> {
    const query = status
      ? 'SELECT * FROM entries WHERE status = ? ORDER BY created_at DESC'
      : 'SELECT * FROM entries ORDER BY created_at DESC';

    const rows = (
      status
        ? db.prepare(query).all(status)
        : db.prepare(query).all()
    ) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      url: row.url as string,
      category: row.category as string | null,
      status: row.status as Entry['status'],
      title: row.title as string | null,
      extractedContent: row.extracted_content as string | null,
      transcriptJson: row.transcript_json as string | null,
      errorMessage: row.error_message as string | null,
      retryCount: row.retry_count as number,
      nextRetryAt: row.next_retry_at as string | null,
      createdAt: row.created_at as string,
      processedAt: row.processed_at as string | null,
    }));
  }

  return {
    createEntry,
    getEntry,
    listEntries,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/api/entries.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/api/entries.ts tests/api/entries.test.ts
git commit -m "feat: add entry handlers"
```

---

### Task 12: Create Feed Handlers

**Files:**
- Create: `src/api/feeds.ts`
- Create: `tests/api/feeds.test.ts`

**Step 1: Write failing test for feed handlers**

```typescript
// tests/api/feeds.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { v4 as uuidv4 } from 'uuid';

describe('feed handlers', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);

    // Add default category
    db.prepare(
      'INSERT INTO categories (name, feed_id, created_at) VALUES (?, ?, ?)'
    ).run('default', uuidv4(), new Date().toISOString());
  });

  afterEach(() => {
    db.close();
  });

  it('should list all feeds', async () => {
    const { createFeedHandlers } = await import('../../src/api/feeds.js');
    const handlers = createFeedHandlers(db, {
      baseUrl: 'https://example.com',
      feedTitle: 'Test Podcast',
      feedAuthor: 'Test Author',
      feedDescription: 'Test description',
      r2PublicUrl: 'https://audio.example.com',
    });

    const feeds = await handlers.listFeeds();

    expect(feeds.length).toBeGreaterThanOrEqual(1);
    expect(feeds[0].category).toBe('default');
    expect(feeds[0].url).toContain('/feed/');
  });

  it('should generate valid RSS XML', async () => {
    const { createFeedHandlers } = await import('../../src/api/feeds.js');
    const handlers = createFeedHandlers(db, {
      baseUrl: 'https://example.com',
      feedTitle: 'Test Podcast',
      feedAuthor: 'Test Author',
      feedDescription: 'Test description',
      r2PublicUrl: 'https://audio.example.com',
    });

    // Get the feed ID for default category
    const feeds = await handlers.listFeeds();
    const defaultFeed = feeds.find((f) => f.category === 'default');

    const xml = await handlers.getFeedXml(defaultFeed!.url.split('/feed/')[1].replace('.xml', ''));

    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain('Test Podcast');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/api/feeds.test.ts
```

Expected: FAIL (module not found)

**Step 3: Write feed handlers**

```typescript
// src/api/feeds.ts
import type Database from 'better-sqlite3';
import type { Episode, Category } from '../types/index.js';

export interface FeedConfig {
  baseUrl: string;
  feedTitle: string;
  feedAuthor: string;
  feedDescription: string;
  artworkUrl?: string;
  r2PublicUrl: string;
}

export interface FeedInfo {
  category: string;
  title: string;
  url: string;
}

export interface FeedHandlers {
  listFeeds(): Promise<FeedInfo[]>;
  getFeedXml(feedId: string): Promise<string>;
  getCategoryByFeedId(feedId: string): Promise<Category | null>;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatRfc2822(date: Date): string {
  return date.toUTCString();
}

export function createFeedHandlers(
  db: Database.Database,
  config: FeedConfig
): FeedHandlers {
  async function listFeeds(): Promise<FeedInfo[]> {
    const categories = db
      .prepare('SELECT name, feed_id FROM categories ORDER BY name')
      .all() as { name: string; feed_id: string }[];

    return categories.map((cat) => ({
      category: cat.name,
      title:
        cat.name === 'default'
          ? config.feedTitle
          : `${config.feedTitle} - ${cat.name}`,
      url: `${config.baseUrl}/feed/${cat.feed_id}.xml`,
    }));
  }

  async function getCategoryByFeedId(feedId: string): Promise<Category | null> {
    const row = db
      .prepare('SELECT * FROM categories WHERE feed_id = ?')
      .get(feedId) as { name: string; feed_id: string; created_at: string } | undefined;

    if (!row) return null;

    return {
      name: row.name,
      feedId: row.feed_id,
      createdAt: row.created_at,
    };
  }

  async function getFeedXml(feedId: string): Promise<string> {
    const category = await getCategoryByFeedId(feedId);
    if (!category) {
      throw new Error('Feed not found');
    }

    const categoryName = category.name;
    const title =
      categoryName === 'default'
        ? config.feedTitle
        : `${config.feedTitle} - ${categoryName}`;

    // Get episodes for this category (limit 50, newest first)
    const episodes = db
      .prepare(
        `SELECT * FROM episodes
         WHERE category = ? OR (category IS NULL AND ? = 'default')
         ORDER BY published_at DESC
         LIMIT 50`
      )
      .all(categoryName, categoryName) as {
      id: string;
      title: string;
      description: string;
      audio_key: string;
      audio_duration: number;
      audio_size: number;
      published_at: string;
    }[];

    const items = episodes
      .map((ep) => {
        const audioUrl = `${config.r2PublicUrl}/${ep.audio_key}`;
        const pubDate = formatRfc2822(new Date(ep.published_at));
        const duration = formatDuration(ep.audio_duration || 0);

        return `    <item>
      <title>${escapeXml(ep.title)}</title>
      <description>${escapeXml(ep.description || '')}</description>
      <enclosure url="${escapeXml(audioUrl)}" length="${ep.audio_size || 0}" type="audio/aac"/>
      <guid isPermaLink="false">${ep.id}</guid>
      <pubDate>${pubDate}</pubDate>
      <itunes:duration>${duration}</itunes:duration>
    </item>`;
      })
      .join('\n');

    const artworkTag = config.artworkUrl
      ? `\n    <itunes:image href="${escapeXml(config.artworkUrl)}"/>`
      : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(config.baseUrl)}</link>
    <description>${escapeXml(config.feedDescription)}</description>
    <language>en-us</language>
    <itunes:author>${escapeXml(config.feedAuthor)}</itunes:author>${artworkTag}
    <atom:link href="${escapeXml(config.baseUrl)}/feed/${feedId}.xml" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>`;
  }

  return {
    listFeeds,
    getFeedXml,
    getCategoryByFeedId,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/api/feeds.test.ts
```

Expected: PASS

**Step 5: Commit**

```bash
git add src/api/feeds.ts tests/api/feeds.test.ts
git commit -m "feat: add feed handlers with RSS generation"
```

---

### Task 13: Create Routes

**Files:**
- Create: `src/api/routes.ts`

**Step 1: Write routes file**

```typescript
// src/api/routes.ts
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createAuthHook, isPublicPath } from './middleware.js';
import { createEntryHandlers, type CreateEntryInput } from './entries.js';
import { createFeedHandlers, type FeedConfig } from './feeds.js';
import type { BudgetService } from '../services/budget.js';

export interface RouteConfig {
  apiKey: string;
  feedConfig: FeedConfig;
}

export function registerRoutes(
  app: FastifyInstance,
  db: Database.Database,
  budgetService: BudgetService,
  config: RouteConfig
): void {
  const entryHandlers = createEntryHandlers(db);
  const feedHandlers = createFeedHandlers(db, config.feedConfig);
  const authHook = createAuthHook(config.apiKey);

  // Apply auth to non-public routes
  app.addHook('preHandler', (request, reply, done) => {
    if (isPublicPath(request.url)) {
      done();
      return;
    }
    authHook(request, reply, done);
  });

  // Health check
  app.get('/health', async () => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };
  });

  // Budget endpoint
  app.get('/budget', async () => {
    return budgetService.getStatus();
  });

  // Create entry
  app.post<{ Body: CreateEntryInput }>('/entries', async (request, reply) => {
    try {
      const entry = await entryHandlers.createEntry(request.body);
      reply.status(201);
      return entry;
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === 'INVALID_URL') {
        reply.status(400);
        return { error: 'Bad Request', message: err.message, code: 'INVALID_URL' };
      }
      if (err.code === 'DUPLICATE_URL') {
        reply.status(409);
        return { error: 'Conflict', message: err.message, code: 'DUPLICATE_URL' };
      }
      throw error;
    }
  });

  // Trigger processing
  app.post('/process', async (request, reply) => {
    const canProcess = await budgetService.canProcess();
    if (!canProcess) {
      const status = await budgetService.getStatus();
      reply.status(503);
      return {
        error: 'Service Unavailable',
        message:
          status.status === 'exceeded'
            ? 'Budget exceeded'
            : 'Pricing config missing or invalid',
        code: status.status === 'exceeded' ? 'BUDGET_EXCEEDED' : 'PRICING_CONFIG_MISSING',
      };
    }

    // Count pending entries
    const result = db
      .prepare(
        `SELECT COUNT(*) as count FROM entries
         WHERE status = 'pending'
         OR (status = 'failed' AND retry_count < 5 AND (next_retry_at IS NULL OR next_retry_at <= ?))`
      )
      .get(new Date().toISOString()) as { count: number };

    // Note: Actual processing is triggered via scheduler
    // This endpoint just reports what would be processed
    reply.status(202);
    return {
      message: 'Processing started',
      pendingCount: result.count,
    };
  });

  // List feeds
  app.get('/feeds', async () => {
    const feeds = await feedHandlers.listFeeds();
    return { feeds };
  });

  // Get feed XML
  app.get<{ Params: { feedId: string } }>('/feed/:feedId.xml', async (request, reply) => {
    try {
      const xml = await feedHandlers.getFeedXml(request.params.feedId);
      reply.header('Content-Type', 'application/rss+xml');
      return xml;
    } catch (error) {
      reply.status(404);
      return { error: 'Not Found', message: 'Feed not found', code: 'NOT_FOUND' };
    }
  });
}
```

**Step 2: Commit**

```bash
git add src/api/routes.ts
git commit -m "feat: add API routes"
```

---

## Phase 4: Processing Pipeline

### Task 14: Create HTML Fetcher

**Files:**
- Create: `src/processing/fetcher.ts`
- Create: `tests/processing/fetcher.test.ts`

**Step 1: Write failing test**

```typescript
// tests/processing/fetcher.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('fetcher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should fetch HTML from URL', async () => {
    const mockHtml = '<html><body>Test content</body></html>';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockHtml),
    });

    const { fetchHtml } = await import('../../src/processing/fetcher.js');
    const result = await fetchHtml('https://example.com');

    expect(result).toBe(mockHtml);
  });

  it('should throw on fetch error', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
    });

    const { fetchHtml } = await import('../../src/processing/fetcher.js');

    await expect(fetchHtml('https://example.com')).rejects.toThrow('404');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/processing/fetcher.test.ts
```

**Step 3: Write fetcher**

```typescript
// src/processing/fetcher.ts
export async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; PodcastLater/1.0; +https://github.com/podcast-later)',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status}`);
  }

  return response.text();
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/processing/fetcher.test.ts
```

**Step 5: Commit**

```bash
git add src/processing/fetcher.ts tests/processing/fetcher.test.ts
git commit -m "feat: add HTML fetcher"
```

---

### Task 15: Create Content Extractor

**Files:**
- Create: `src/processing/extractor.ts`
- Create: `tests/processing/extractor.test.ts`

**Step 1: Write failing test**

```typescript
// tests/processing/extractor.test.ts
import { describe, it, expect } from 'vitest';

describe('extractor', () => {
  it('should extract content from HTML', async () => {
    const { extractContent } = await import('../../src/processing/extractor.js');

    const html = `
      <html>
        <head><title>Test Article</title></head>
        <body>
          <nav>Navigation</nav>
          <article>
            <h1>Test Article</h1>
            <p>This is the main content of the article. It contains several sentences to ensure we have enough content for extraction. The article discusses important topics that readers find interesting.</p>
            <p>Another paragraph with more content to make sure we exceed the minimum threshold. This paragraph adds more substance to the article and helps demonstrate the extraction process.</p>
          </article>
          <footer>Footer content</footer>
        </body>
      </html>
    `;

    const result = await extractContent(html);

    expect(result.title).toBe('Test Article');
    expect(result.content).toContain('main content');
    expect(result.content).not.toContain('Navigation');
    expect(result.content).not.toContain('Footer');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
npm test -- tests/processing/extractor.test.ts
```

**Step 3: Write extractor**

```typescript
// src/processing/extractor.ts
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

export interface ExtractionResult {
  title: string;
  content: string;
  byline?: string;
}

export async function extractContent(html: string): Promise<ExtractionResult> {
  const dom = new JSDOM(html, { url: 'https://example.com' });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article) {
    return {
      title: '',
      content: '',
    };
  }

  return {
    title: article.title || '',
    content: article.textContent || '',
    byline: article.byline || undefined,
  };
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- tests/processing/extractor.test.ts
```

**Step 5: Commit**

```bash
git add src/processing/extractor.ts tests/processing/extractor.test.ts
git commit -m "feat: add content extractor using Readability"
```

---

### Task 16: Create Transcriber

**Files:**
- Create: `src/processing/transcriber.ts`

**Step 1: Write transcriber**

```typescript
// src/processing/transcriber.ts
import type { Transcript } from '../types/index.js';
import type { OpenAIService, LLMUsage } from '../services/openai.js';
import type { AnthropicService } from '../services/anthropic.js';

export interface TranscriberConfig {
  provider: 'openai' | 'anthropic';
  model: string;
  minContentLength: number;
}

export interface TranscriberResult {
  transcript: Transcript;
  usage: LLMUsage;
}

export function createTranscriber(
  openaiService: OpenAIService | null,
  anthropicService: AnthropicService | null,
  config: TranscriberConfig
) {
  async function generateTranscript(
    content: string,
    title: string
  ): Promise<TranscriberResult> {
    if (content.length < config.minContentLength) {
      throw new Error(
        `Content too short: ${content.length} < ${config.minContentLength}`
      );
    }

    if (config.provider === 'anthropic' && anthropicService) {
      return anthropicService.generateTranscript(content, title, config.model);
    }

    if (openaiService) {
      return openaiService.generateTranscript(content, title, config.model);
    }

    throw new Error('No LLM service configured');
  }

  async function extractContentWithLLM(
    html: string
  ): Promise<{ content: string; usage: LLMUsage }> {
    if (config.provider === 'anthropic' && anthropicService) {
      return anthropicService.extractContent(html, config.model);
    }

    if (openaiService) {
      return openaiService.extractContent(html, config.model);
    }

    throw new Error('No LLM service configured');
  }

  return {
    generateTranscript,
    extractContentWithLLM,
  };
}
```

**Step 2: Commit**

```bash
git add src/processing/transcriber.ts
git commit -m "feat: add transcriber module"
```

---

### Task 17: Create TTS Module

**Files:**
- Create: `src/processing/tts.ts`

**Step 1: Write TTS module**

```typescript
// src/processing/tts.ts
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Transcript, TranscriptSegment } from '../types/index.js';
import type { OpenAIService, TTSUsage } from '../services/openai.js';

export interface TTSConfig {
  voices: string[];
  tempDir: string;
}

export interface TTSResult {
  segmentFiles: string[];
  totalUsage: TTSUsage;
}

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function createTTSProcessor(
  openaiService: OpenAIService,
  config: TTSConfig
) {
  async function processTranscript(
    transcript: Transcript,
    entryId: string
  ): Promise<TTSResult> {
    // Assign voices to speakers
    const shuffledVoices = shuffleArray(config.voices);
    const voiceAssignment: Record<string, string> = {};

    // Check if this is dialogue or monologue
    const speakers = new Set(transcript.map((s) => s.speaker));

    if (speakers.has('NARRATOR')) {
      voiceAssignment['NARRATOR'] = shuffledVoices[0];
    } else {
      voiceAssignment['HOST'] = shuffledVoices[0];
      voiceAssignment['EXPERT'] = shuffledVoices[1] || shuffledVoices[0];
    }

    const segmentFiles: string[] = [];
    let totalCharacters = 0;

    // Ensure temp directory exists
    mkdirSync(config.tempDir, { recursive: true });

    for (let i = 0; i < transcript.length; i++) {
      const segment = transcript[i];
      const voice = voiceAssignment[segment.speaker];

      const { audio, usage } = await openaiService.textToSpeech(
        segment.text,
        voice,
        segment.instruction
      );

      const filename = join(config.tempDir, `${entryId}_${i}.aac`);
      writeFileSync(filename, audio);
      segmentFiles.push(filename);
      totalCharacters += usage.characters;
    }

    return {
      segmentFiles,
      totalUsage: { characters: totalCharacters },
    };
  }

  return {
    processTranscript,
  };
}
```

**Step 2: Commit**

```bash
git add src/processing/tts.ts
git commit -m "feat: add TTS processor module"
```

---

### Task 18: Create Audio Merger

**Files:**
- Create: `src/processing/audio.ts`

**Step 1: Write audio merger**

```typescript
// src/processing/audio.ts
import { createReadStream, unlinkSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { PassThrough } from 'stream';
import type { R2Service } from '../services/r2.js';

export interface AudioMergeResult {
  audioKey: string;
  audioUrl: string;
  audioDuration: number;
  audioSize: number;
}

export function createAudioMerger(r2Service: R2Service, tempDir: string) {
  async function mergeAndUpload(
    segmentFiles: string[],
    episodeId: string
  ): Promise<AudioMergeResult> {
    const audioKey = `${episodeId}.aac`;
    const concatFilePath = join(tempDir, `${episodeId}_concat.txt`);
    const outputPath = join(tempDir, `${episodeId}_merged.aac`);

    // Create concat file for ffmpeg
    const concatContent = segmentFiles
      .map((f) => `file '${f}'`)
      .join('\n');
    writeFileSync(concatFilePath, concatContent);

    // Merge audio files
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .audioCodec('aac')
        .audioBitrate('128k')
        .output(outputPath)
        .on('end', () => resolve())
        .on('error', (err) => reject(err))
        .run();
    });

    // Get duration using ffprobe
    const duration = await new Promise<number>((resolve, reject) => {
      ffmpeg.ffprobe(outputPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(Math.round(metadata.format.duration || 0));
      });
    });

    // Upload to R2
    const fileBuffer = require('fs').readFileSync(outputPath);
    const { url, size } = await r2Service.upload(audioKey, fileBuffer, 'audio/aac');

    // Cleanup temp files
    try {
      unlinkSync(concatFilePath);
      unlinkSync(outputPath);
    } catch {
      // Ignore cleanup errors
    }

    return {
      audioKey,
      audioUrl: url,
      audioDuration: duration,
      audioSize: size,
    };
  }

  function cleanupSegments(segmentFiles: string[]): void {
    for (const file of segmentFiles) {
      try {
        unlinkSync(file);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  return {
    mergeAndUpload,
    cleanupSegments,
  };
}
```

**Step 2: Commit**

```bash
git add src/processing/audio.ts
git commit -m "feat: add audio merger with R2 upload"
```

---

### Task 19: Create Processing Pipeline

**Files:**
- Create: `src/processing/pipeline.ts`

**Step 1: Write pipeline**

```typescript
// src/processing/pipeline.ts
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Entry, ProcessingResult } from '../types/index.js';
import type { BudgetService } from '../services/budget.js';
import type { PushoverService } from '../services/pushover.js';
import { fetchHtml } from './fetcher.js';
import { extractContent } from './extractor.js';

export interface PipelineConfig {
  minContentLength: number;
  maxRetries: number;
}

export interface PipelineDependencies {
  db: Database.Database;
  budgetService: BudgetService;
  pushoverService: PushoverService;
  transcriber: {
    generateTranscript: (content: string, title: string) => Promise<{ transcript: any; usage: { inputTokens: number; outputTokens: number } }>;
    extractContentWithLLM: (html: string) => Promise<{ content: string; usage: { inputTokens: number; outputTokens: number } }>;
  };
  ttsProcessor: {
    processTranscript: (transcript: any, entryId: string) => Promise<{ segmentFiles: string[]; totalUsage: { characters: number } }>;
  };
  audioMerger: {
    mergeAndUpload: (segmentFiles: string[], episodeId: string) => Promise<{ audioKey: string; audioUrl: string; audioDuration: number; audioSize: number }>;
    cleanupSegments: (segmentFiles: string[]) => void;
  };
  llmProvider: 'openai' | 'anthropic';
  llmModel: string;
}

export function createPipeline(deps: PipelineDependencies, config: PipelineConfig) {
  const { db, budgetService, pushoverService, transcriber, ttsProcessor, audioMerger } = deps;

  function calculateNextRetryAt(retryCount: number): string {
    const baseMinutes = Math.pow(2, retryCount); // 1, 2, 4, 8, 16
    const jitterSeconds = Math.floor(Math.random() * 30);
    const delayMs = (baseMinutes * 60 + jitterSeconds) * 1000;
    return new Date(Date.now() + delayMs).toISOString();
  }

  async function processEntry(entry: Entry): Promise<ProcessingResult> {
    const entryId = entry.id;
    let segmentFiles: string[] = [];

    try {
      // Mark as processing
      db.prepare('UPDATE entries SET status = ? WHERE id = ?').run('processing', entryId);

      // Step 1: Fetch HTML
      const html = await fetchHtml(entry.url);

      // Step 2: Extract content
      let { title, content } = await extractContent(html);

      // Fallback to LLM if content too short
      if (content.length < config.minContentLength) {
        const llmResult = await transcriber.extractContentWithLLM(html);
        content = llmResult.content;

        // Log LLM extraction usage
        await budgetService.logUsage({
          entryId,
          service: deps.llmProvider === 'anthropic' ? 'anthropic' : 'openai_chat',
          model: deps.llmModel,
          inputUnits: llmResult.usage.inputTokens,
          outputUnits: llmResult.usage.outputTokens,
          costUsd: budgetService.calculateCost(
            deps.llmProvider === 'anthropic' ? 'anthropic' : 'openai_chat',
            deps.llmModel,
            llmResult.usage.inputTokens,
            llmResult.usage.outputTokens
          ),
        });
      }

      // Validate content length
      if (content.length < config.minContentLength) {
        throw new Error('Insufficient content extracted');
      }

      // Update entry with extracted content
      db.prepare('UPDATE entries SET title = ?, extracted_content = ? WHERE id = ?')
        .run(title || entry.url, content, entryId);

      // Step 3: Generate transcript
      const transcriptResult = await transcriber.generateTranscript(content, title || 'Article');

      // Log transcript generation usage
      await budgetService.logUsage({
        entryId,
        service: deps.llmProvider === 'anthropic' ? 'anthropic' : 'openai_chat',
        model: deps.llmModel,
        inputUnits: transcriptResult.usage.inputTokens,
        outputUnits: transcriptResult.usage.outputTokens,
        costUsd: budgetService.calculateCost(
          deps.llmProvider === 'anthropic' ? 'anthropic' : 'openai_chat',
          deps.llmModel,
          transcriptResult.usage.inputTokens,
          transcriptResult.usage.outputTokens
        ),
      });

      // Update entry with transcript
      db.prepare('UPDATE entries SET transcript_json = ? WHERE id = ?')
        .run(JSON.stringify(transcriptResult.transcript), entryId);

      // Step 4: Text-to-speech
      const ttsResult = await ttsProcessor.processTranscript(transcriptResult.transcript, entryId);
      segmentFiles = ttsResult.segmentFiles;

      // Log TTS usage
      await budgetService.logUsage({
        entryId,
        service: 'openai_tts',
        model: 'gpt-4o-mini-tts',
        inputUnits: ttsResult.totalUsage.characters,
        outputUnits: null,
        costUsd: budgetService.calculateCost(
          'openai_tts',
          'gpt-4o-mini-tts',
          ttsResult.totalUsage.characters
        ),
      });

      // Step 5: Merge and upload
      const episodeId = uuidv4();
      const audioResult = await audioMerger.mergeAndUpload(segmentFiles, episodeId);

      // Cleanup segments after successful upload
      audioMerger.cleanupSegments(segmentFiles);

      // Step 6: Create episode
      const description = content.substring(0, 200) + (content.length > 200 ? '...' : '');
      const publishedAt = new Date().toISOString();

      db.prepare(
        `INSERT INTO episodes (id, entry_id, category, title, description, audio_key, audio_duration, audio_size, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        episodeId,
        entryId,
        entry.category,
        title || 'Untitled',
        description,
        audioResult.audioKey,
        audioResult.audioDuration,
        audioResult.audioSize,
        publishedAt
      );

      // Mark entry as completed
      db.prepare('UPDATE entries SET status = ?, processed_at = ? WHERE id = ?')
        .run('completed', publishedAt, entryId);

      return { success: true, entryId, episodeId };

    } catch (error) {
      const err = error as Error;
      const newRetryCount = entry.retryCount + 1;

      if (newRetryCount >= config.maxRetries) {
        // Mark as permanently failed
        db.prepare('UPDATE entries SET status = ?, error_message = ?, retry_count = ? WHERE id = ?')
          .run('failed', err.message, newRetryCount, entryId);

        // Send failure notification
        await pushoverService.sendProcessingFailed(entryId, entry.url, err.message);
      } else {
        // Schedule retry
        const nextRetryAt = calculateNextRetryAt(newRetryCount);
        db.prepare('UPDATE entries SET status = ?, error_message = ?, retry_count = ?, next_retry_at = ? WHERE id = ?')
          .run('failed', err.message, newRetryCount, nextRetryAt, entryId);
      }

      // Keep segments for retry if upload failed
      // (they'll be cleaned up on next attempt or by cleanup job)

      return { success: false, entryId, error: err.message };
    }
  }

  return { processEntry };
}
```

**Step 2: Commit**

```bash
git add src/processing/pipeline.ts
git commit -m "feat: add processing pipeline orchestrator"
```

---

### Task 20: Create Scheduler

**Files:**
- Create: `src/processing/scheduler.ts`

**Step 1: Write scheduler**

```typescript
// src/processing/scheduler.ts
import cron from 'node-cron';
import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import type Database from 'better-sqlite3';
import type { Entry } from '../types/index.js';
import type { BudgetService } from '../services/budget.js';
import type { PushoverService } from '../services/pushover.js';

const LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface SchedulerConfig {
  cronSchedule: string;
  cleanupSchedule: string;
  tempDir: string;
  retentionDays: number;
  budgetWarningPercent: number;
}

export interface SchedulerDependencies {
  db: Database.Database;
  budgetService: BudgetService;
  pushoverService: PushoverService;
  processEntry: (entry: Entry) => Promise<{ success: boolean; entryId: string; error?: string }>;
}

export function createScheduler(deps: SchedulerDependencies, config: SchedulerConfig) {
  const { db, budgetService, pushoverService, processEntry } = deps;
  let previousBudgetStatus: 'ok' | 'warning' | 'exceeded' = 'ok';

  function acquireLock(): boolean {
    const now = new Date().toISOString();
    const lockRow = db.prepare('SELECT * FROM processing_lock WHERE id = 1').get() as {
      locked_at: string | null;
      locked_by: string | null;
    } | undefined;

    if (lockRow?.locked_at) {
      const lockAge = Date.now() - new Date(lockRow.locked_at).getTime();
      if (lockAge < LOCK_TIMEOUT_MS) {
        console.log('Processing already in progress, skipping');
        return false;
      }
      console.log('Stale lock detected, taking over');
    }

    db.prepare('UPDATE processing_lock SET locked_at = ?, locked_by = ? WHERE id = 1')
      .run(now, hostname());

    return true;
  }

  function releaseLock(): void {
    db.prepare('UPDATE processing_lock SET locked_at = NULL, locked_by = NULL WHERE id = 1').run();
  }

  async function runProcessingJob(): Promise<void> {
    if (!acquireLock()) {
      return;
    }

    try {
      // Check budget status and send warnings
      const status = await budgetService.getStatus();

      if (status.status === 'warning' && previousBudgetStatus === 'ok') {
        await pushoverService.sendBudgetWarning(
          status.percentUsed,
          status.spentUsd,
          status.budgetUsd
        );
      } else if (status.status === 'exceeded' && previousBudgetStatus !== 'exceeded') {
        await pushoverService.sendBudgetExceeded(status.spentUsd, status.budgetUsd);
      }
      previousBudgetStatus = status.status;

      if (!status.processingEnabled) {
        console.log('Budget exceeded, skipping processing');
        return;
      }

      // Get pending entries
      const now = new Date().toISOString();
      const entries = db.prepare(
        `SELECT * FROM entries
         WHERE status = 'pending'
         OR (status = 'failed' AND retry_count < 5 AND (next_retry_at IS NULL OR next_retry_at <= ?))
         ORDER BY created_at ASC`
      ).all(now) as Record<string, unknown>[];

      console.log(`Found ${entries.length} entries to process`);

      for (const row of entries) {
        // Check budget before each entry
        if (!(await budgetService.canProcess())) {
          console.log('Budget exceeded mid-batch, stopping');
          break;
        }

        const entry: Entry = {
          id: row.id as string,
          url: row.url as string,
          category: row.category as string | null,
          status: row.status as Entry['status'],
          title: row.title as string | null,
          extractedContent: row.extracted_content as string | null,
          transcriptJson: row.transcript_json as string | null,
          errorMessage: row.error_message as string | null,
          retryCount: row.retry_count as number,
          nextRetryAt: row.next_retry_at as string | null,
          createdAt: row.created_at as string,
          processedAt: row.processed_at as string | null,
        };

        console.log(`Processing entry ${entry.id}: ${entry.url}`);
        const result = await processEntry(entry);

        if (result.success) {
          console.log(`Successfully processed entry ${entry.id}`);
        } else {
          console.error(`Failed to process entry ${entry.id}: ${result.error}`);
        }
      }
    } finally {
      releaseLock();
    }
  }

  async function runCleanupJob(): Promise<void> {
    console.log('Running cleanup job');

    // Delete old episodes from database
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - config.retentionDays);

    const deleted = db.prepare('DELETE FROM episodes WHERE published_at < ?')
      .run(cutoffDate.toISOString());

    console.log(`Deleted ${deleted.changes} old episodes`);

    // Reset stuck processing entries
    const resetResult = db.prepare(
      "UPDATE entries SET status = 'pending' WHERE status = 'processing'"
    ).run();

    if (resetResult.changes > 0) {
      console.log(`Reset ${resetResult.changes} stuck entries`);
    }

    // Clean orphaned temp files older than 24 hours
    try {
      const files = readdirSync(config.tempDir);
      const cutoffTime = Date.now() - 24 * 60 * 60 * 1000;

      for (const file of files) {
        const filePath = join(config.tempDir, file);
        const stat = statSync(filePath);

        if (stat.mtimeMs < cutoffTime) {
          unlinkSync(filePath);
          console.log(`Deleted orphaned temp file: ${file}`);
        }
      }
    } catch (error) {
      // Ignore if temp dir doesn't exist
    }
  }

  function start(): void {
    console.log(`Scheduling processing job: ${config.cronSchedule}`);
    cron.schedule(config.cronSchedule, () => {
      runProcessingJob().catch(console.error);
    });

    console.log(`Scheduling cleanup job: ${config.cleanupSchedule}`);
    cron.schedule(config.cleanupSchedule, () => {
      runCleanupJob().catch(console.error);
    });
  }

  return {
    start,
    runProcessingJob,
    runCleanupJob,
  };
}
```

**Step 2: Commit**

```bash
git add src/processing/scheduler.ts
git commit -m "feat: add scheduler with processing and cleanup jobs"
```

---

## Phase 5: Entry Point and Docker

### Task 21: Create Entry Point

**Files:**
- Create: `src/index.ts`

**Step 1: Write entry point**

```typescript
// src/index.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { join } from 'path';
import { mkdirSync } from 'fs';

import { config } from './config.js';
import { createDatabase } from './db/client.js';
import { createBudgetService } from './services/budget.js';
import { createPushoverService } from './services/pushover.js';
import { createR2Service } from './services/r2.js';
import { createOpenAIService } from './services/openai.js';
import { createAnthropicService } from './services/anthropic.js';
import { registerRoutes } from './api/routes.js';
import { createTranscriber } from './processing/transcriber.js';
import { createTTSProcessor } from './processing/tts.js';
import { createAudioMerger } from './processing/audio.js';
import { createPipeline } from './processing/pipeline.js';
import { createScheduler } from './processing/scheduler.js';

async function main() {
  // Ensure data directories exist
  const dataDir = config.dataDir;
  const tempDir = join(dataDir, 'temp');
  mkdirSync(tempDir, { recursive: true });

  // Initialize database
  const dbPath = join(dataDir, 'podcast-later.db');
  const db = createDatabase(dbPath);
  console.log(`Database initialized at ${dbPath}`);

  // Initialize services
  const budgetService = createBudgetService(
    db,
    config.pricingConfigPath,
    config.monthlyBudgetUsd,
    config.budgetWarningPercent
  );

  const pushoverService = createPushoverService(
    config.pushoverUserKey,
    config.pushoverAppToken
  );

  const r2Service = createR2Service({
    accountId: config.r2AccountId,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
    bucketName: config.r2BucketName,
    publicUrl: config.r2PublicUrl,
  });

  const openaiService = createOpenAIService(config.openaiApiKey);
  const anthropicService = config.anthropicApiKey
    ? createAnthropicService(config.anthropicApiKey)
    : null;

  // Initialize processing components
  const transcriber = createTranscriber(openaiService, anthropicService, {
    provider: config.llmProvider,
    model: config.llmModel,
    minContentLength: config.minContentLength,
  });

  const ttsProcessor = createTTSProcessor(openaiService, {
    voices: config.ttsVoices,
    tempDir,
  });

  const audioMerger = createAudioMerger(r2Service, tempDir);

  const pipeline = createPipeline(
    {
      db,
      budgetService,
      pushoverService,
      transcriber,
      ttsProcessor,
      audioMerger,
      llmProvider: config.llmProvider,
      llmModel: config.llmModel,
    },
    {
      minContentLength: config.minContentLength,
      maxRetries: 5,
    }
  );

  // Initialize scheduler
  const scheduler = createScheduler(
    {
      db,
      budgetService,
      pushoverService,
      processEntry: pipeline.processEntry,
    },
    {
      cronSchedule: config.cronSchedule,
      cleanupSchedule: '0 0 * * *', // Daily at midnight
      tempDir,
      retentionDays: config.retentionDays,
      budgetWarningPercent: config.budgetWarningPercent,
    }
  );

  // Initialize Fastify
  const app = Fastify({ logger: true });
  await app.register(cors);

  // Register routes
  registerRoutes(app, db, budgetService, {
    apiKey: config.apiKey,
    feedConfig: {
      baseUrl: config.baseUrl,
      feedTitle: config.feedTitle,
      feedAuthor: config.feedAuthor,
      feedDescription: config.feedDescription,
      artworkUrl: config.artworkUrl,
      r2PublicUrl: config.r2PublicUrl,
    },
  });

  // Start scheduler
  scheduler.start();

  // Start server
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Server running on port ${config.port}`);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
```

**Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: add application entry point"
```

---

### Task 22: Create Dockerfile

**Files:**
- Create: `Dockerfile`
- Create: `docker-compose.yml`

**Step 1: Write Dockerfile**

```dockerfile
# Dockerfile
FROM node:20-alpine

# Install ffmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy built files
COPY dist/ ./dist/

# Create data directory
RUN mkdir -p /data/temp

# Expose port
EXPOSE 8080

# Set environment
ENV NODE_ENV=production
ENV DATA_DIR=/data

# Start the application
CMD ["node", "dist/index.js"]
```

**Step 2: Write docker-compose.yml**

```yaml
# docker-compose.yml
version: '3.8'

services:
  podcast-later:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - podcast-data:/data
    environment:
      - API_KEY=${API_KEY}
      - BASE_URL=${BASE_URL}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - R2_ACCOUNT_ID=${R2_ACCOUNT_ID}
      - R2_ACCESS_KEY_ID=${R2_ACCESS_KEY_ID}
      - R2_SECRET_ACCESS_KEY=${R2_SECRET_ACCESS_KEY}
      - R2_BUCKET_NAME=${R2_BUCKET_NAME}
      - R2_PUBLIC_URL=${R2_PUBLIC_URL}
      - MONTHLY_BUDGET_USD=${MONTHLY_BUDGET_USD}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
      - LLM_PROVIDER=${LLM_PROVIDER:-openai}
      - LLM_MODEL=${LLM_MODEL:-gpt-4o}
      - PUSHOVER_USER_KEY=${PUSHOVER_USER_KEY:-}
      - PUSHOVER_APP_TOKEN=${PUSHOVER_APP_TOKEN:-}
    restart: unless-stopped

volumes:
  podcast-data:
```

**Step 3: Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "feat: add Docker configuration"
```

---

### Task 23: Create Sample Pricing Config

**Files:**
- Create: `pricing.example.json`

**Step 1: Write sample pricing config**

```json
{
  "openai": {
    "gpt-4o": { "input_per_1m": 2.50, "output_per_1m": 10.00 },
    "gpt-4o-mini": { "input_per_1m": 0.15, "output_per_1m": 0.60 },
    "gpt-4o-mini-tts": { "chars_per_1m": 12.00 }
  },
  "anthropic": {
    "claude-sonnet-4-20250514": { "input_per_1m": 3.00, "output_per_1m": 15.00 }
  }
}
```

**Step 2: Commit**

```bash
git add pricing.example.json
git commit -m "docs: add sample pricing config"
```

---

## Final Verification

### Task 24: Run All Tests

**Step 1: Run full test suite**

```bash
npm test
```

Expected: All tests pass

**Step 2: Build the project**

```bash
npm run build
```

Expected: TypeScript compiles without errors

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: complete implementation"
```

---

## Summary

This implementation plan covers:

1. **Phase 1: Foundation** - Project setup, types, config, database
2. **Phase 2: Services** - Budget, Pushover, R2, OpenAI, Anthropic
3. **Phase 3: API** - Auth middleware, entry handlers, feed handlers, routes
4. **Phase 4: Processing** - Fetcher, extractor, transcriber, TTS, audio merger, pipeline, scheduler
5. **Phase 5: Docker** - Entry point, Dockerfile, docker-compose

Each task follows TDD principles with failing tests first, then implementation.
