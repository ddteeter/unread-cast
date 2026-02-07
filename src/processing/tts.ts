// src/processing/tts.ts
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import type { Transcript, TranscriptSegment } from '../types/index.js';
import type { OpenAIService, TTSUsage } from '../services/openai.js';

export interface TTSConfig {
  voices: string[];
  tempDir: string;
}

export interface TTSResult {
  segmentFiles: string[];
  totalUsage: TTSUsage;
}

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function createTTSProcessor(
  openaiService: OpenAIService,
  config: TTSConfig
) {
  async function processTranscript(
    transcript: Transcript,
    entryId: string
  ): Promise<TTSResult> {
    // Assign voices to speakers
    const shuffledVoices = shuffleArray(config.voices);
    const voiceAssignment: Record<string, string> = {};

    // Check if this is dialogue or monologue
    const speakers = new Set(transcript.map((s) => s.speaker));

    if (speakers.has('NARRATOR')) {
      voiceAssignment['NARRATOR'] = shuffledVoices[0];
    } else {
      voiceAssignment['HOST'] = shuffledVoices[0];
      voiceAssignment['EXPERT'] = shuffledVoices[1] || shuffledVoices[0];
    }

    const segmentFiles: string[] = [];
    let totalCharacters = 0;

    // Ensure temp directory exists
    mkdirSync(config.tempDir, { recursive: true });

    for (let i = 0; i < transcript.length; i++) {
      const segment = transcript[i];
      const voice = voiceAssignment[segment.speaker];

      // Truncate instruction if too long (OpenAI TTS instruction limit is ~500 chars)
      const MAX_INSTRUCTION_LENGTH = 400;
      const instruction = segment.instruction.length > MAX_INSTRUCTION_LENGTH
        ? segment.instruction.substring(0, MAX_INSTRUCTION_LENGTH)
        : segment.instruction;

      const { audio, usage } = await openaiService.textToSpeech(
        segment.text,
        voice,
        instruction
      );

      const filename = join(config.tempDir, `${entryId}_${i}.aac`);
      writeFileSync(filename, audio);
      segmentFiles.push(filename);
      totalCharacters += usage.characters;
    }

    return {
      segmentFiles,
      totalUsage: { characters: totalCharacters },
    };
  }

  return {
    processTranscript,
  };
}
