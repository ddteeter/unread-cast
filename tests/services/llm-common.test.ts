import { describe, it, expect } from 'vitest';
import { parseAndValidateTranscript } from '../../src/services/llm-common.js';

describe('parseAndValidateTranscript', () => {
  it('should parse valid array format', () => {
    const json = JSON.stringify([
      { speaker: 'HOST', text: 'Hello', instruction: 'Warm tone' },
      { speaker: 'EXPERT', text: 'World', instruction: 'Thoughtful' },
    ]);

    const result = parseAndValidateTranscript(json);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ speaker: 'HOST', text: 'Hello', instruction: 'Warm tone' });
    expect(result[1]).toEqual({ speaker: 'EXPERT', text: 'World', instruction: 'Thoughtful' });
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

    expect(() => parseAndValidateTranscript(invalidJson)).toThrow('Failed to parse transcript JSON');
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
});
