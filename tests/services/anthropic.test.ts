import { describe, it, expect } from 'vitest';

describe('anthropic service', () => {
  it('should create Anthropic client', async () => {
    const { createAnthropicService } = await import('../../src/services/anthropic.js');

    const service = createAnthropicService('test-key');

    expect(service).toBeDefined();
    expect(service.generateTranscript).toBeDefined();
    expect(service.extractContent).toBeDefined();
  });
});
