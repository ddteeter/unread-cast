import { describe, it, expect, vi } from 'vitest';
import { createTranscriber } from '../../src/processing/transcriber.js';

const usage = { inputTokens: 10, outputTokens: 20 };
const transcript = [{ speaker: 'NARRATOR' as const, text: 'Hi', instruction: 'Clear' }];

function mockServices() {
  const openai = {
    generateTranscript: vi.fn().mockResolvedValue({ transcript, usage }),
    extractContent: vi.fn().mockResolvedValue({ content: 'article', usage }),
    textToSpeech: vi.fn(),
  };
  const anthropic = {
    generateTranscript: vi.fn().mockResolvedValue({ transcript, usage }),
    extractContent: vi.fn().mockResolvedValue({ content: 'article', usage }),
  };
  return { openai, anthropic };
}

const LONG_CONTENT = 'a'.repeat(1000);

describe('transcriber model routing', () => {
  // Transcript generation (short input, long output) and HTML extraction (very long
  // input, short output) have different cost and capability profiles, so they can be
  // pointed at different models.
  it('routes each stage to its own model on the anthropic path', async () => {
    const { openai, anthropic } = mockServices();
    const transcriber = createTranscriber(openai, anthropic, {
      provider: 'anthropic',
      transcriptModel: 'claude-sonnet-4-5-20250929',
      extractionModel: 'claude-haiku-4-5',
      minContentLength: 500,
    });

    await transcriber.generateTranscript(LONG_CONTENT, 'Title');
    await transcriber.extractContentWithLLM('<html></html>');

    expect(anthropic.generateTranscript).toHaveBeenCalledWith(
      LONG_CONTENT,
      'Title',
      'claude-sonnet-4-5-20250929'
    );
    expect(anthropic.extractContent).toHaveBeenCalledWith('<html></html>', 'claude-haiku-4-5');
  });

  it('routes each stage to its own model on the openai path', async () => {
    const { openai, anthropic } = mockServices();
    const transcriber = createTranscriber(openai, anthropic, {
      provider: 'openai',
      transcriptModel: 'gpt-5.6-terra',
      extractionModel: 'gpt-5.6-luna',
      minContentLength: 500,
    });

    await transcriber.generateTranscript(LONG_CONTENT, 'Title');
    await transcriber.extractContentWithLLM('<html></html>');

    expect(openai.generateTranscript).toHaveBeenCalledWith(LONG_CONTENT, 'Title', 'gpt-5.6-terra');
    expect(openai.extractContent).toHaveBeenCalledWith('<html></html>', 'gpt-5.6-luna');
  });

  it('reports the model actually used, so usage is costed against the right rate', async () => {
    const { openai, anthropic } = mockServices();
    const transcriber = createTranscriber(openai, anthropic, {
      provider: 'anthropic',
      transcriptModel: 'claude-sonnet-4-5-20250929',
      extractionModel: 'claude-haiku-4-5',
      minContentLength: 500,
    });

    const transcriptResult = await transcriber.generateTranscript(LONG_CONTENT, 'Title');
    const extractionResult = await transcriber.extractContentWithLLM('<html></html>');

    expect(transcriptResult.model).toBe('claude-sonnet-4-5-20250929');
    expect(extractionResult.model).toBe('claude-haiku-4-5');
  });

  it('still rejects content below the minimum length', async () => {
    const { openai, anthropic } = mockServices();
    const transcriber = createTranscriber(openai, anthropic, {
      provider: 'anthropic',
      transcriptModel: 'm',
      extractionModel: 'm',
      minContentLength: 500,
    });

    await expect(transcriber.generateTranscript('short', 'Title')).rejects.toThrow(
      /Content too short/
    );
  });
});
