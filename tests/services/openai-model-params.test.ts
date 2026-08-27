import { describe, it, expect, vi, beforeEach } from 'vitest';

// Captures the request bodies the service builds, so we can assert on the shape sent
// to each model family without hitting the network.
const createCompletion = vi.fn();
const createSpeech = vi.fn();

vi.mock('openai', () => ({
  default: class MockOpenAI {
    chat = { completions: { create: createCompletion } };
    audio = { speech: { create: createSpeech } };
  },
}));

const VALID_TRANSCRIPT = JSON.stringify({
  transcript: [{ speaker: 'NARRATOR', text: 'Hello world.', instruction: 'Clear' }],
});

function chatResponse(content: string) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

describe('openai request shaping by model family', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createCompletion.mockResolvedValue(chatResponse(VALID_TRANSCRIPT));
  });

  describe('gpt-4 generation', () => {
    it('sends max_tokens and temperature', async () => {
      const { createOpenAIService } = await import('../../src/services/openai.js');
      const service = createOpenAIService('sk-test', 16000, 8000);

      await service.generateTranscript('content', 'Title', 'gpt-4o');

      const body = createCompletion.mock.calls[0][0];
      expect(body.max_tokens).toBe(16000);
      expect(body.temperature).toBe(0.7);
      expect(body).not.toHaveProperty('max_completion_tokens');
      expect(body).not.toHaveProperty('reasoning_effort');
    });
  });

  describe('gpt-5 reasoning generation', () => {
    // Sending temperature to these models is an error, and max_tokens is not the
    // parameter they accept.
    it.each(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-5.2'])(
      'sends max_completion_tokens and omits temperature for %s',
      async (model) => {
        const { createOpenAIService } = await import('../../src/services/openai.js');
        const service = createOpenAIService('sk-test', 16000, 8000);

        await service.generateTranscript('content', 'Title', model);

        const body = createCompletion.mock.calls[0][0];
        expect(body.max_completion_tokens).toBe(16000);
        expect(body).not.toHaveProperty('temperature');
        expect(body).not.toHaveProperty('max_tokens');
      }
    );

    it('passes reasoning_effort when configured', async () => {
      const { createOpenAIService } = await import('../../src/services/openai.js');
      const service = createOpenAIService('sk-test', 16000, 8000, 'low');

      await service.generateTranscript('content', 'Title', 'gpt-5.6-luna');

      expect(createCompletion.mock.calls[0][0].reasoning_effort).toBe('low');
    });

    it('omits reasoning_effort when not configured', async () => {
      const { createOpenAIService } = await import('../../src/services/openai.js');
      const service = createOpenAIService('sk-test', 16000, 8000);

      await service.generateTranscript('content', 'Title', 'gpt-5.6-luna');

      expect(createCompletion.mock.calls[0][0]).not.toHaveProperty('reasoning_effort');
    });

    it('applies the same shaping to the extraction call', async () => {
      const { createOpenAIService } = await import('../../src/services/openai.js');
      createCompletion.mockResolvedValue(chatResponse('extracted article text'));
      const service = createOpenAIService('sk-test', 16000, 8000);

      await service.extractContent('<html></html>', 'gpt-5.6-terra');

      const body = createCompletion.mock.calls[0][0];
      expect(body.max_completion_tokens).toBe(8000);
      expect(body).not.toHaveProperty('temperature');
    });
  });

  describe('structured outputs', () => {
    it('requests a strict json_schema rather than a bare json_object', async () => {
      const { createOpenAIService } = await import('../../src/services/openai.js');
      const service = createOpenAIService('sk-test');

      await service.generateTranscript('content', 'Title', 'gpt-5.6-terra');

      const format = createCompletion.mock.calls[0][0].response_format;
      expect(format.type).toBe('json_schema');
      expect(format.json_schema.strict).toBe(true);
      expect(format.json_schema.schema.properties.transcript.items.properties.speaker.enum).toEqual(
        ['HOST', 'AUTHOR', 'NARRATOR']
      );
    });

    it('still parses the wrapped transcript object into segments', async () => {
      const { createOpenAIService } = await import('../../src/services/openai.js');
      const service = createOpenAIService('sk-test');

      const { transcript, usage } = await service.generateTranscript('c', 'T', 'gpt-5.6-terra');

      expect(transcript).toHaveLength(1);
      expect(transcript[0].speaker).toBe('NARRATOR');
      expect(usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });
  });

  describe('text to speech', () => {
    it('uses the model it is given rather than a hardcoded one', async () => {
      const { createOpenAIService } = await import('../../src/services/openai.js');
      createSpeech.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(8) });
      const service = createOpenAIService('sk-test');

      await service.textToSpeech('Hello', 'nova', 'Warm', 'gpt-4o-mini-tts-2025-12-15');

      const body = createSpeech.mock.calls[0][0];
      expect(body.model).toBe('gpt-4o-mini-tts-2025-12-15');
      expect(body.voice).toBe('nova');
      expect(body.response_format).toBe('aac');
    });
  });
});
