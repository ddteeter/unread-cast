import { describe, it, expect, vi } from 'vitest';
import { parseAndValidateTranscript } from '../../src/services/llm-common.js';

describe('parseAndValidateTranscript', () => {
  it('should parse valid array format', () => {
    const json = JSON.stringify([
      { speaker: 'HOST', text: 'Hello', instruction: 'Warm tone' },
      { speaker: 'AUTHOR', text: 'World', instruction: 'Thoughtful' },
    ]);

    const result = parseAndValidateTranscript(json);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ speaker: 'HOST', text: 'Hello', instruction: 'Warm tone' });
    expect(result[1]).toEqual({ speaker: 'AUTHOR', text: 'World', instruction: 'Thoughtful' });
  });

  it('should parse valid object-with-array format', () => {
    const json = JSON.stringify({
      transcript: [
        { speaker: 'NARRATOR', text: 'Story begins', instruction: 'Clear and engaging' },
      ],
    });

    const result = parseAndValidateTranscript(json);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      speaker: 'NARRATOR',
      text: 'Story begins',
      instruction: 'Clear and engaging',
    });
  });

  it('should throw on invalid JSON', () => {
    const invalidJson = 'not valid json';

    expect(() => parseAndValidateTranscript(invalidJson)).toThrow(
      'Failed to parse transcript JSON'
    );
  });

  it('should throw on missing speaker field', () => {
    const json = JSON.stringify([{ text: 'Hello', instruction: 'Warm' }]);

    expect(() => parseAndValidateTranscript(json)).toThrow('Invalid transcript segment structure');
  });

  it('should throw on missing text field', () => {
    const json = JSON.stringify([{ speaker: 'HOST', instruction: 'Warm' }]);

    expect(() => parseAndValidateTranscript(json)).toThrow('Invalid transcript segment structure');
  });

  it('should throw on missing instruction field', () => {
    const json = JSON.stringify([{ speaker: 'HOST', text: 'Hello' }]);

    expect(() => parseAndValidateTranscript(json)).toThrow('Invalid transcript segment structure');
  });

  it('should throw on empty arrays', () => {
    const json = JSON.stringify([]);

    // Empty array is technically valid, but let's verify it returns empty
    const result = parseAndValidateTranscript(json);
    expect(result).toHaveLength(0);
  });

  it('should throw on object without transcript property', () => {
    const json = JSON.stringify({ other: 'property' });

    const result = parseAndValidateTranscript(json);
    expect(result).toHaveLength(0); // Should default to empty array
  });

  // Structural validation alone cannot catch schema-valid-but-corrupt model output.
  // gpt-5.6-luna has been reported emitting degenerate tokens inside string values
  // while the JSON stays valid under strict mode, which would reach TTS and be spoken.
  describe('content corruption guards', () => {
    const segment = (text: string) =>
      JSON.stringify([{ speaker: 'HOST', text, instruction: 'Warm' }]);

    it('should reject whitespace-only text', () => {
      expect(() => parseAndValidateTranscript(segment('   \n  '))).toThrow(/empty or whitespace/);
    });

    it('should reject Unicode replacement characters', () => {
      expect(() => parseAndValidateTranscript(segment('Hello there\uFFFD'))).toThrow(
        /replacement characters/
      );
    });

    it('should reject control characters', () => {
      expect(() => parseAndValidateTranscript(segment('Hello\u0007 there'))).toThrow(
        /control characters/
      );
    });

    it('should allow ordinary punctuation and newlines', () => {
      const text = 'Hello there — "quoted", and a line\nbreak. Costs $5 (or €4).';
      const result = parseAndValidateTranscript(segment(text));
      expect(result[0].text).toBe(text);
    });

    it('should warn but not throw on a small non-Latin run in Latin text', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const text = `${'This is a normal English sentence. '.repeat(10)}你好`;

      const result = parseAndValidateTranscript(segment(text));

      expect(result).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('possible model output corruption')
      );
      warn.mockRestore();
    });

    it('should not warn on legitimately non-Latin content', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = parseAndValidateTranscript(segment('你好，世界。'.repeat(10)));

      expect(result).toHaveLength(1);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
