import OpenAI from 'openai';
import { APIError, RateLimitError } from 'openai/error.mjs';
import type { Transcript } from '../types/index.js';
import {
  parseAndValidateTranscript,
  TRANSCRIPT_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  type LLMUsage,
  type TTSUsage,
} from './llm-common.js';

// Re-export types for backward compatibility
export type { LLMUsage, TTSUsage };

export interface OpenAIService {
  generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }>;
  extractContent(html: string, model: string): Promise<{ content: string; usage: LLMUsage }>;
  textToSpeech(
    text: string,
    voice: string,
    instruction: string
  ): Promise<{ audio: Buffer; usage: TTSUsage }>;
}

export function createOpenAIService(
  apiKey: string,
  maxTranscriptTokens: number = 16000,
  maxExtractionTokens: number = 8000
): OpenAIService {
  const client = new OpenAI({ apiKey });

  async function generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }> {
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0.7,
        max_tokens: maxTranscriptTokens,
        messages: [
          { role: 'system', content: TRANSCRIPT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Article Title: ${title}\n\nArticle Content:\n${content}`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const text = response.choices[0]?.message?.content ?? '[]';
      const segments = parseAndValidateTranscript(text);

      return {
        transcript: segments,
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      // Detect specific error types
      if (error instanceof RateLimitError) {
        // Check message to differentiate quota vs rate limit
        if (error.message.includes('quota') || error.message.includes('insufficient_quota')) {
          throw new Error('OpenAI API quota exceeded - please add credits to your account');
        }
        throw new Error('OpenAI rate limit - will retry automatically');
      } else if (error instanceof APIError) {
        throw new Error(`OpenAI API error (${error.status}): ${error.message}`);
      }
      // Re-throw unknown errors
      throw error;
    }
  }

  async function extractContent(
    html: string,
    model: string
  ): Promise<{ content: string; usage: LLMUsage }> {
    try {
      const response = await client.chat.completions.create({
        model,
        temperature: 0,
        max_tokens: maxExtractionTokens,
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
          { role: 'user', content: html },
        ],
      });

      return {
        content: response.choices[0]?.message?.content ?? '',
        usage: {
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
        },
      };
    } catch (error) {
      if (error instanceof RateLimitError) {
        if (error.message.includes('quota') || error.message.includes('insufficient_quota')) {
          throw new Error('OpenAI API quota exceeded - please add credits to your account');
        }
        throw new Error('OpenAI rate limit - will retry automatically');
      } else if (error instanceof APIError) {
        throw new Error(`OpenAI API error (${error.status}): ${error.message}`);
      }
      throw error;
    }
  }

  async function textToSpeech(
    text: string,
    voice: string,
    instruction: string
  ): Promise<{ audio: Buffer; usage: TTSUsage }> {
    const response = await client.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: voice as
        | 'alloy'
        | 'ash'
        | 'ballad'
        | 'coral'
        | 'echo'
        | 'fable'
        | 'nova'
        | 'onyx'
        | 'sage'
        | 'shimmer'
        | 'verse',
      input: text,
      instructions: instruction,
      response_format: 'aac',
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    return {
      audio: buffer,
      usage: { characters: text.length },
    };
  }

  return {
    generateTranscript,
    extractContent,
    textToSpeech,
  };
}
