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

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

/**
 * The gpt-5 family (including the GPT-5.6 Sol/Terra/Luna tiers) and the o-series are
 * reasoning models. They differ from the gpt-4 generation in two ways that break a
 * naive request:
 *
 *   - `temperature` / `top_p` are rejected or silently ignored.
 *   - `max_tokens` is replaced by `max_completion_tokens`.
 *
 * They also accept `reasoning_effort`. Reasoning tokens are billed as output tokens,
 * so effort is a cost lever as well as a quality one.
 */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o[1-9])/i.test(model);
}

/**
 * Builds the token-limit and sampling half of a chat completion request for whichever
 * model family we are talking to.
 *
 * `temperature` is deliberately dropped for reasoning models rather than passed as a
 * default: sending it is an error on that family, and there is no equivalent knob.
 */
function buildModelParams(
  model: string,
  maxTokens: number,
  temperature: number,
  reasoningEffort?: ReasoningEffort
): Record<string, unknown> {
  if (isReasoningModel(model)) {
    return {
      max_completion_tokens: maxTokens,
      ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    };
  }
  return { max_tokens: maxTokens, temperature };
}

/**
 * Strict schema for the podcast transcript.
 *
 * This replaces the older `response_format: { type: 'json_object' }`, which only
 * guaranteed *some* JSON and left us stripping markdown fences and guessing at shape.
 *
 * We deliberately stay on Chat Completions rather than migrating to the Responses API:
 * as of 2026-08 there is an open report of gpt-5.6-luna emitting degenerate tokens
 * (foreign scripts, leaked reasoning) inside string values under Responses API +
 * structured outputs, while the identical request via Chat Completions is clean. The
 * corrupted output stays schema-valid, so it would pass validation and be spoken aloud.
 */
const TRANSCRIPT_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'podcast_transcript',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        transcript: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              speaker: { type: 'string', enum: ['HOST', 'AUTHOR', 'NARRATOR'] },
              text: { type: 'string' },
              instruction: { type: 'string' },
            },
            required: ['speaker', 'text', 'instruction'],
            additionalProperties: false,
          },
        },
      },
      required: ['transcript'],
      additionalProperties: false,
    },
  },
};

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
    instruction: string,
    model: string
  ): Promise<{ audio: Buffer; usage: TTSUsage }>;
}

export function createOpenAIService(
  apiKey: string,
  maxTranscriptTokens: number = 16000,
  maxExtractionTokens: number = 8000,
  reasoningEffort?: ReasoningEffort
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
        ...buildModelParams(model, maxTranscriptTokens, 0.7, reasoningEffort),
        messages: [
          { role: 'system', content: TRANSCRIPT_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Article Title: ${title}\n\nArticle Content:\n${content}`,
          },
        ],
        response_format: TRANSCRIPT_RESPONSE_FORMAT,
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
        ...buildModelParams(model, maxExtractionTokens, 0, reasoningEffort),
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
    instruction: string,
    model: string
  ): Promise<{ audio: Buffer; usage: TTSUsage }> {
    const response = await client.audio.speech.create({
      model,
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
