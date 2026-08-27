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

  describe('per-stage model resolution', () => {
    function setRequiredEnv() {
      process.env.API_KEY = 'test-key';
      process.env.BASE_URL = 'https://example.com';
      process.env.OPENAI_API_KEY = 'sk-test';
      process.env.R2_ACCOUNT_ID = 'account123';
      process.env.R2_ACCESS_KEY_ID = 'access123';
      process.env.R2_SECRET_ACCESS_KEY = 'secret123';
      process.env.R2_BUCKET_NAME = 'podcast-audio';
      process.env.R2_PUBLIC_URL = 'https://audio.example.com';
      process.env.MONTHLY_BUDGET_USD = '20';
    }

    it('falls back to LLM_MODEL when no per-stage override is set', async () => {
      setRequiredEnv();
      process.env.LLM_MODEL = 'claude-sonnet-4-5-20250929';

      const { config } = await import('../src/config.js');

      expect(config.llmTranscriptModel).toBe('claude-sonnet-4-5-20250929');
      expect(config.llmExtractionModel).toBe('claude-sonnet-4-5-20250929');
    });

    // With nothing pinned we pick the recommended pair rather than one model for both:
    // the two stages have opposite cost profiles and extraction does not need Sonnet.
    it('applies the recommended per-stage pair when LLM_MODEL is unset', async () => {
      setRequiredEnv();

      const { config } = await import('../src/config.js');

      expect(config.llmTranscriptModel).toBe('claude-sonnet-5');
      expect(config.llmExtractionModel).toBe('claude-haiku-4-5');
    });

    // Pinning LLM_MODEL means the operator owns every stage. Leaving extraction on the
    // recommended default here would route half the pipeline to a model they did not
    // choose - and, if they also set LLM_PROVIDER=openai, to one the client cannot call.
    it('does not apply the extraction default when LLM_MODEL is pinned', async () => {
      setRequiredEnv();
      process.env.LLM_MODEL = 'gpt-5.6-terra';

      const { config } = await import('../src/config.js');

      expect(config.llmTranscriptModel).toBe('gpt-5.6-terra');
      expect(config.llmExtractionModel).toBe('gpt-5.6-terra');
    });

    it('lets each stage be overridden independently', async () => {
      setRequiredEnv();
      process.env.LLM_MODEL = 'claude-sonnet-4-5-20250929';
      process.env.LLM_EXTRACTION_MODEL = 'claude-haiku-4-5';

      const { config } = await import('../src/config.js');

      expect(config.llmTranscriptModel).toBe('claude-sonnet-4-5-20250929');
      expect(config.llmExtractionModel).toBe('claude-haiku-4-5');
    });

    it('defaults the TTS model to the pinned snapshot', async () => {
      setRequiredEnv();

      const { config } = await import('../src/config.js');

      expect(config.ttsModel).toBe('gpt-4o-mini-tts-2025-12-15');
    });

    it('allows the TTS model to be overridden for A/B testing', async () => {
      setRequiredEnv();
      process.env.TTS_MODEL = 'gpt-4o-mini-tts';

      const { config } = await import('../src/config.js');

      expect(config.ttsModel).toBe('gpt-4o-mini-tts');
    });
  });
});
