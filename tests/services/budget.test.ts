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
      entry_id: null,
      service: 'openai_chat',
      model: 'gpt-4o',
      input_units: 1000000, // $2.50
      output_units: 100000, // $1.00
      cost_usd: 3.5,
    });

    const status = await service.getStatus();
    expect(status.spent_usd).toBeCloseTo(3.5, 2);
    expect(status.budget_usd).toBe(20);
    expect(status.remaining_usd).toBeCloseTo(16.5, 2);
    expect(status.percent_used).toBeCloseTo(17.5, 1);
    expect(status.status).toBe('ok');
    expect(status.processing_enabled).toBe(true);
  });

  it('should block processing when budget exceeded', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(
      db,
      join(tempDir, 'pricing.json'),
      10
    );

    await service.logUsage({
      entry_id: null,
      service: 'openai_chat',
      model: 'gpt-4o',
      input_units: 1000000,
      output_units: 1000000,
      cost_usd: 12.5, // Over budget
    });

    const canProcess = await service.canProcess();
    expect(canProcess).toBe(false);

    const status = await service.getStatus();
    expect(status.status).toBe('exceeded');
    expect(status.processing_enabled).toBe(false);
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
