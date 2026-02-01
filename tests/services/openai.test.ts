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
