import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMessage = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: createMessage };
  }
  return {
    default: MockAnthropic,
    APIError: class APIError extends Error {
      status = 500;
    },
  };
});

function messageResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const VALID_TRANSCRIPT = JSON.stringify([
  { speaker: 'NARRATOR', text: 'Hello world.', instruction: 'Clear' },
]);

describe('anthropic sampling parameter handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMessage.mockResolvedValue(messageResponse(VALID_TRANSCRIPT));
  });

  // Sampling parameters still work on these, so dropping them would be a silent
  // behaviour change.
  it.each(['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5'])(
    'sends temperature for %s',
    async (model) => {
      const { createAnthropicService } = await import('../../src/services/anthropic.js');
      const service = createAnthropicService('sk-ant-test');

      await service.generateTranscript('content', 'Title', model);

      expect(createMessage.mock.calls[0][0].temperature).toBe(0.7);
    }
  );

  // These generations removed sampling parameters entirely and return a 400 if sent.
  it.each([
    'claude-opus-5',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-sonnet-5',
    'claude-fable-5',
  ])('omits temperature for %s', async (model) => {
    const { createAnthropicService } = await import('../../src/services/anthropic.js');
    const service = createAnthropicService('sk-ant-test');

    await service.generateTranscript('content', 'Title', model);

    expect(createMessage.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('applies the same rule to extraction', async () => {
    const { createAnthropicService } = await import('../../src/services/anthropic.js');
    createMessage.mockResolvedValue(messageResponse('article text'));
    const service = createAnthropicService('sk-ant-test');

    await service.extractContent('<html></html>', 'claude-opus-5');
    expect(createMessage.mock.calls[0][0]).not.toHaveProperty('temperature');

    await service.extractContent('<html></html>', 'claude-sonnet-4-5-20250929');
    expect(createMessage.mock.calls[1][0].temperature).toBe(0);
  });

  it('defaults an unrecognised model to the historical behaviour', async () => {
    const { createAnthropicService } = await import('../../src/services/anthropic.js');
    const service = createAnthropicService('sk-ant-test');

    await service.generateTranscript('content', 'Title', 'claude-something-new');

    expect(createMessage.mock.calls[0][0].temperature).toBe(0.7);
  });
});
