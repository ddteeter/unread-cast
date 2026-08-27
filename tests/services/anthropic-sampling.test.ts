import { describe, it, expect, vi, beforeEach } from 'vitest';

const createMessage = vi.fn();
const parseMessage = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: createMessage, parse: parseMessage };
  }
  return {
    default: MockAnthropic,
    APIError: class APIError extends Error {
      status = 500;
    },
  };
});

// The transcript path goes through messages.parse and reads parsed_output; extraction
// stays on messages.create and reads a text block.
vi.mock('@anthropic-ai/sdk/helpers/zod', () => ({
  zodOutputFormat: vi.fn(() => ({ type: 'json_schema' })),
}));

function messageResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

const SEGMENTS = [{ speaker: 'NARRATOR', text: 'Hello world.', instruction: 'Clear' }];

function parsedResponse() {
  return {
    content: [{ type: 'text', text: JSON.stringify({ transcript: SEGMENTS }) }],
    parsed_output: { transcript: SEGMENTS },
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe('anthropic sampling parameter handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMessage.mockResolvedValue(messageResponse('article text'));
    parseMessage.mockResolvedValue(parsedResponse());
  });

  // Sampling parameters still work on these, so dropping them would be a silent
  // behaviour change.
  it.each(['claude-sonnet-4-5-20250929', 'claude-opus-4-6', 'claude-haiku-4-5'])(
    'sends temperature for %s',
    async (model) => {
      const { createAnthropicService } = await import('../../src/services/anthropic.js');
      const service = createAnthropicService('sk-ant-test');

      await service.generateTranscript('content', 'Title', model);

      expect(parseMessage.mock.calls[0][0].temperature).toBe(0.7);
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

    expect(parseMessage.mock.calls[0][0]).not.toHaveProperty('temperature');
  });

  it('applies the same rule to extraction', async () => {
    const { createAnthropicService } = await import('../../src/services/anthropic.js');
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

    expect(parseMessage.mock.calls[0][0].temperature).toBe(0.7);
  });
});

describe('anthropic thinking parameter handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMessage.mockResolvedValue(messageResponse('article text'));
    parseMessage.mockResolvedValue(parsedResponse());
  });

  // These think when `thinking` is omitted. Thinking tokens bill as output and are
  // drawn from max_tokens, so leaving it unset both inflates cost and risks truncating
  // a long transcript.
  it.each(['claude-sonnet-5', 'claude-opus-5'])('disables thinking for %s', async (model) => {
    const { createAnthropicService } = await import('../../src/services/anthropic.js');
    const service = createAnthropicService('sk-ant-test');

    await service.generateTranscript('content', 'Title', model);

    expect(parseMessage.mock.calls[0][0].thinking).toEqual({ type: 'disabled' });
  });

  // Sending `thinking` to a model that does not think by default is a needless request
  // change, so these keep the historical shape.
  it.each(['claude-sonnet-4-5-20250929', 'claude-haiku-4-5', 'claude-something-new'])(
    'sends no thinking parameter for %s',
    async (model) => {
      const { createAnthropicService } = await import('../../src/services/anthropic.js');
      const service = createAnthropicService('sk-ant-test');

      await service.generateTranscript('content', 'Title', model);

      expect(parseMessage.mock.calls[0][0]).not.toHaveProperty('thinking');
    }
  );

  // Fable and Mythos always think - `{ type: 'disabled' }` is a 400 there.
  it.each(['claude-fable-5', 'claude-mythos-5'])(
    'omits thinking rather than disabling it for %s',
    async (model) => {
      const { createAnthropicService } = await import('../../src/services/anthropic.js');
      const service = createAnthropicService('sk-ant-test');

      await service.generateTranscript('content', 'Title', model);

      expect(parseMessage.mock.calls[0][0]).not.toHaveProperty('thinking');
    }
  );

  it('disables thinking on the extraction path too', async () => {
    const { createAnthropicService } = await import('../../src/services/anthropic.js');
    const service = createAnthropicService('sk-ant-test');

    await service.extractContent('<html></html>', 'claude-sonnet-5');

    expect(createMessage.mock.calls[0][0].thinking).toEqual({ type: 'disabled' });
  });
});

describe('anthropic structured output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createMessage.mockResolvedValue(messageResponse('article text'));
    parseMessage.mockResolvedValue(parsedResponse());
  });

  it('constrains the transcript with output_config.format', async () => {
    const { createAnthropicService } = await import('../../src/services/anthropic.js');
    const service = createAnthropicService('sk-ant-test');

    const { transcript } = await service.generateTranscript('content', 'Title', 'claude-sonnet-5');

    expect(parseMessage.mock.calls[0][0].output_config.format).toBeDefined();
    expect(transcript).toEqual(SEGMENTS);
  });

  // LLM_MODEL takes an arbitrary string, so an operator can pin a model whose schema
  // support is partial. A fence-wrapped array is recoverable and should not cost a retry.
  it('falls back to text parsing when parsed_output is null', async () => {
    const { createAnthropicService } = await import('../../src/services/anthropic.js');
    parseMessage.mockResolvedValue({
      content: [{ type: 'text', text: '```json\n' + JSON.stringify(SEGMENTS) + '\n```' }],
      parsed_output: null,
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const service = createAnthropicService('sk-ant-test');

    const { transcript } = await service.generateTranscript('content', 'Title', 'claude-legacy');

    expect(transcript).toEqual(SEGMENTS);
  });

  // Schema enforcement guarantees shape, not that the strings are safe to speak.
  it('still applies content guards to schema-valid output', async () => {
    const { createAnthropicService } = await import('../../src/services/anthropic.js');
    parseMessage.mockResolvedValue({
      content: [],
      parsed_output: {
        transcript: [{ speaker: 'NARRATOR', text: 'Hello\uFFFD', instruction: 'Clear' }],
      },
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    const service = createAnthropicService('sk-ant-test');

    await expect(service.generateTranscript('content', 'Title', 'claude-sonnet-5')).rejects.toThrow(
      /replacement characters/
    );
  });
});
