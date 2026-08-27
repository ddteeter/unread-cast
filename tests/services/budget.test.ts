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
    tempDir = mkdtempSync(join(tmpdir(), 'unread-cast-test-'));
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
    const service = createBudgetService(db, join(tempDir, 'pricing.json'), 100);

    // 1000 input tokens, 500 output tokens at gpt-4o rates
    const cost = service.calculateCost('openai_chat', 'gpt-4o', 1000, 500);
    // (1000/1_000_000 * 2.5) + (500/1_000_000 * 10.0) = 0.0025 + 0.005 = 0.0075
    expect(cost).toBeCloseTo(0.0075, 6);
  });

  it('should calculate cost for TTS using the legacy chars_per_1m rate', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(db, join(tempDir, 'pricing.json'), 100);

    // 10000 characters at gpt-4o-mini-tts rates
    const cost = service.calculateCost('openai_tts', 'gpt-4o-mini-tts', 10000);
    // 10000/1_000_000 * 12.0 = 0.12
    expect(cost).toBeCloseTo(0.12, 6);
  });

  describe('token-based TTS pricing', () => {
    const tokenPricing = {
      openai: {
        'gpt-4o-mini-tts-2025-12-15': {
          text_input_per_1m: 0.6,
          audio_output_per_1m: 12.0,
          est_audio_tokens_per_char: 1.39,
          est_text_tokens_per_char: 0.25,
        },
      },
    };

    beforeEach(() => {
      writeFileSync(join(tempDir, 'tokens.json'), JSON.stringify(tokenPricing));
    });

    it('should price a typical episode close to the published per-minute rate', async () => {
      const { createBudgetService } = await import('../../src/services/budget.js');
      const service = createBudgetService(db, join(tempDir, 'tokens.json'), 100);

      // ~15 minutes of speech at ~900 chars/min.
      const cost = service.calculateCost('openai_tts', 'gpt-4o-mini-tts-2025-12-15', 13500);

      // OpenAI publishes ~$0.015/min, so 15 min should land near $0.225.
      expect(cost).toBeCloseTo(0.225, 2);
    });

    it('should charge more than the legacy per-character model it replaces', async () => {
      const { createBudgetService } = await import('../../src/services/budget.js');
      const tokenService = createBudgetService(db, join(tempDir, 'tokens.json'), 100);
      const legacyService = createBudgetService(db, join(tempDir, 'pricing.json'), 100);

      const tokenCost = tokenService.calculateCost(
        'openai_tts',
        'gpt-4o-mini-tts-2025-12-15',
        13500
      );
      const legacyCost = legacyService.calculateCost('openai_tts', 'gpt-4o-mini-tts', 13500);

      // The legacy flat rate under-counted real spend by roughly 40%, which let
      // actual cost run past MONTHLY_BUDGET_USD before canProcess() would block.
      expect(tokenCost).toBeGreaterThan(legacyCost);
      expect(legacyCost / tokenCost).toBeCloseTo(0.72, 1);
    });

    it('should fall back to built-in estimates when the entry omits them', async () => {
      const { createBudgetService } = await import('../../src/services/budget.js');
      const { TTS_TOKEN_ESTIMATES } = await import('../../src/services/budget.js');

      writeFileSync(
        join(tempDir, 'minimal.json'),
        JSON.stringify({
          openai: {
            'gpt-4o-mini-tts-2025-12-15': {
              text_input_per_1m: 0.6,
              audio_output_per_1m: 12.0,
            },
          },
        })
      );
      const service = createBudgetService(db, join(tempDir, 'minimal.json'), 100);

      const cost = service.calculateCost('openai_tts', 'gpt-4o-mini-tts-2025-12-15', 10000);
      const expected =
        (10000 * TTS_TOKEN_ESTIMATES.audioTokensPerChar * 12.0) / 1_000_000 +
        (10000 * TTS_TOKEN_ESTIMATES.textTokensPerChar * 0.6) / 1_000_000;

      expect(cost).toBeCloseTo(expected, 6);
    });

    it('should still throw for a model missing from the pricing config', async () => {
      const { createBudgetService } = await import('../../src/services/budget.js');
      const service = createBudgetService(db, join(tempDir, 'tokens.json'), 100);

      expect(() => service.calculateCost('openai_tts', 'gpt-4o-mini-tts', 1000)).toThrow(
        /PRICING_CONFIG_MISSING/
      );
    });
  });

  it('should return correct budget status', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(db, join(tempDir, 'pricing.json'), 20);

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
    const service = createBudgetService(db, join(tempDir, 'pricing.json'), 10);

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
    const service = createBudgetService(db, join(tempDir, 'pricing.json'), 100);

    expect(() => service.calculateCost('openai_chat', 'unknown-model', 1000, 500)).toThrow(
      'PRICING_CONFIG_MISSING'
    );
  });

  it('should prevent processing when budget is at exactly 100%', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(db, join(tempDir, 'pricing.json'), 10);

    // Log usage that exactly meets the budget
    await service.logUsage({
      entry_id: null,
      service: 'openai_chat',
      model: 'gpt-4o',
      input_units: 4000000, // $10.00 exactly
      output_units: 0,
      cost_usd: 10.0,
    });

    const canProcess = await service.canProcess();
    expect(canProcess).toBe(false);

    const status = await service.getStatus();
    expect(status.status).toBe('exceeded');
    expect(status.percent_used).toBeCloseTo(100, 1);
  });

  it('should show warning status at 80% threshold', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(
      db,
      join(tempDir, 'pricing.json'),
      100, // $100 budget
      80 // 80% warning threshold
    );

    // Log usage at exactly 80%
    await service.logUsage({
      entry_id: null,
      service: 'openai_chat',
      model: 'gpt-4o',
      input_units: 32000000, // $80.00 (80%)
      output_units: 0,
      cost_usd: 80.0,
    });

    const status = await service.getStatus();
    expect(status.status).toBe('warning');
    expect(status.percent_used).toBeCloseTo(80, 1);
    expect(status.processing_enabled).toBe(true); // Still enabled at warning level
  });

  it('should allow processing just below 100% threshold', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(db, join(tempDir, 'pricing.json'), 10);

    // Log usage at 99.9%
    await service.logUsage({
      entry_id: null,
      service: 'openai_chat',
      model: 'gpt-4o',
      input_units: 3996000, // $9.99 (99.9%)
      output_units: 0,
      cost_usd: 9.99,
    });

    const canProcess = await service.canProcess();
    expect(canProcess).toBe(true);

    const status = await service.getStatus();
    expect(status.status).toBe('warning'); // At warning level but not exceeded
    expect(status.processing_enabled).toBe(true);
  });

  it('should calculate costs for Anthropic models', async () => {
    // Update pricing config to include Anthropic
    writeFileSync(
      join(tempDir, 'pricing.json'),
      JSON.stringify({
        openai: {
          'gpt-4o': { input_per_1m: 2.5, output_per_1m: 10.0 },
          'gpt-4o-mini-tts': { chars_per_1m: 12.0 },
        },
        anthropic: {
          'claude-3-5-sonnet-20241022': { input_per_1m: 3.0, output_per_1m: 15.0 },
        },
      })
    );

    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(db, join(tempDir, 'pricing.json'), 100);

    // Test Anthropic cost calculation
    const cost = service.calculateCost('anthropic_chat', 'claude-3-5-sonnet-20241022', 1000, 500);
    // (1000/1_000_000 * 3.0) + (500/1_000_000 * 15.0) = 0.003 + 0.0075 = 0.0105
    expect(cost).toBeCloseTo(0.0105, 6);
  });

  it('should return false from canProcess when pricing config is missing', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(
      db,
      join(tempDir, 'nonexistent-pricing.json'), // Invalid path
      100
    );

    const canProcess = await service.canProcess();
    expect(canProcess).toBe(false);
  });

  it('should track usage across multiple entries', async () => {
    const { createBudgetService } = await import('../../src/services/budget.js');
    const service = createBudgetService(db, join(tempDir, 'pricing.json'), 50);

    // Create entries in database (required for foreign key constraint)
    const now = new Date().toISOString();
    db.prepare('INSERT INTO entries (id, url, status, created_at) VALUES (?, ?, ?, ?)').run(
      'entry-1',
      'https://example.com/1',
      'pending',
      now
    );
    db.prepare('INSERT INTO entries (id, url, status, created_at) VALUES (?, ?, ?, ?)').run(
      'entry-2',
      'https://example.com/2',
      'pending',
      now
    );
    db.prepare('INSERT INTO entries (id, url, status, created_at) VALUES (?, ?, ?, ?)').run(
      'entry-3',
      'https://example.com/3',
      'pending',
      now
    );

    // Log multiple usage entries
    await service.logUsage({
      entry_id: 'entry-1',
      service: 'openai_chat',
      model: 'gpt-4o',
      input_units: 1000000,
      output_units: 500000,
      cost_usd: 7.5,
    });

    await service.logUsage({
      entry_id: 'entry-2',
      service: 'openai_tts',
      model: 'gpt-4o-mini-tts',
      input_units: 100000,
      output_units: 0,
      cost_usd: 1.2,
    });

    await service.logUsage({
      entry_id: 'entry-3',
      service: 'openai_chat',
      model: 'gpt-4o',
      input_units: 2000000,
      output_units: 1000000,
      cost_usd: 15.0,
    });

    const status = await service.getStatus();
    expect(status.spent_usd).toBeCloseTo(23.7, 2);
    expect(status.percent_used).toBeCloseTo(47.4, 1);
    expect(status.status).toBe('ok');
  });
});
