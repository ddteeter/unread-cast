// tests/config.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
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
