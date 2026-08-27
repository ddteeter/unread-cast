import Anthropic from '@anthropic-ai/sdk';
import { APIError } from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Transcript } from '../types/index.js';
import {
  parseAndValidateTranscript,
  validateTranscriptSegments,
  TranscriptSchema,
  TRANSCRIPT_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  type LLMUsage,
} from './llm-common.js';

/**
 * Sampling parameters (`temperature`, `top_p`, `top_k`) were removed from the Claude
 * Opus 4.7+ / Sonnet 5 / Fable 5 generations and return a 400 if sent. Older models
 * (Sonnet 4.5, Opus 4.6, Haiku 4.5) still accept them.
 *
 * This is an explicit deny-list rather than an allow-list: an unrecognised model keeps
 * the historical behaviour instead of silently losing its temperature setting.
 */
const SAMPLING_UNSUPPORTED = [
  /^claude-opus-5/,
  /^claude-opus-4-[789]/,
  /^claude-sonnet-5/,
  /^claude-fable-5/,
  /^claude-mythos-5/,
];

function supportsSampling(model: string): boolean {
  return !SAMPLING_UNSUPPORTED.some((pattern) => pattern.test(model));
}

/**
 * Models that run adaptive thinking when the `thinking` parameter is omitted.
 *
 * This matters for cost *and* for correctness. Thinking tokens bill as output, and
 * they are drawn from the same `max_tokens` budget as the response - so on a long
 * article, thinking can both inflate the bill and crowd out the transcript itself,
 * truncating it mid-generation. This pipeline renders an article faithfully rather
 * than reasoning about it, so thinking earns nothing here.
 *
 * Deny-list style, matching SAMPLING_UNSUPPORTED: an unrecognised model keeps the
 * historical behaviour of sending nothing.
 */
const THINKING_ON_BY_DEFAULT = [
  /^claude-opus-5/,
  /^claude-sonnet-5/,
  /^claude-fable-5/,
  /^claude-mythos-5/,
];

/**
 * Fable and Mythos always think - `{ type: 'disabled' }` is a 400 there, so the only
 * option is to omit the parameter and pay for it. Neither is a sensible choice for
 * this pipeline, but LLM_MODEL accepts any string, so don't hand back a hard error.
 */
const THINKING_NOT_DISABLEABLE = [/^claude-fable-5/, /^claude-mythos-5/];

function thinkingParams(model: string): { thinking?: { type: 'disabled' } } {
  if (!THINKING_ON_BY_DEFAULT.some((pattern) => pattern.test(model))) return {};
  if (THINKING_NOT_DISABLEABLE.some((pattern) => pattern.test(model))) return {};
  return { thinking: { type: 'disabled' } };
}

export interface AnthropicService {
  generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }>;
  extractContent(html: string, model: string): Promise<{ content: string; usage: LLMUsage }>;
}

export function createAnthropicService(
  apiKey: string,
  maxTranscriptTokens: number = 16000,
  maxExtractionTokens: number = 8000
): AnthropicService {
  const client = new Anthropic({ apiKey });

  async function generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }> {
    try {
      // `parse` rather than `create`: it attaches `output_config.format` so the model
      // is constrained to TranscriptSchema, and decodes the result for us. This is the
      // non-beta path - no beta header required.
      const response = await client.messages.parse({
        model,
        max_tokens: maxTranscriptTokens,
        ...(supportsSampling(model) ? { temperature: 0.7 } : {}),
        ...thinkingParams(model),
        output_config: { format: zodOutputFormat(TranscriptSchema) },
        system: TRANSCRIPT_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Article Title: ${title}\n\nArticle Content:\n${content}`,
          },
        ],
      });

      // parsed_output is null when the model returned something the schema could not
      // decode. Fall back to the text block so a recoverable response (a fence-wrapped
      // array from an operator-pinned model) does not cost the entry a retry.
      const segments = response.parsed_output
        ? validateTranscriptSegments(response.parsed_output.transcript)
        : parseAndValidateTranscript(
            response.content.find((block) => block.type === 'text')?.text ?? '[]'
          );

      return {
        transcript: segments,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      if (error instanceof APIError && error.status === 429) {
        // Check message to differentiate quota vs rate limit
        if (error.message.includes('credit') || error.message.includes('quota')) {
          throw new Error('Anthropic API quota exceeded - please add credits');
        }
        throw new Error('Anthropic rate limit - will retry automatically');
      }
      throw error;
    }
  }

  async function extractContent(
    html: string,
    model: string
  ): Promise<{ content: string; usage: LLMUsage }> {
    try {
      const response = await client.messages.create({
        model,
        max_tokens: maxExtractionTokens,
        ...(supportsSampling(model) ? { temperature: 0 } : {}),
        ...thinkingParams(model),
        system: EXTRACT_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: html }],
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      const content = textBlock?.type === 'text' ? textBlock.text : '';

      return {
        content,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
      };
    } catch (error) {
      if (error instanceof APIError && error.status === 429) {
        if (error.message.includes('credit') || error.message.includes('quota')) {
          throw new Error('Anthropic API quota exceeded - please add credits');
        }
        throw new Error('Anthropic rate limit - will retry automatically');
      }
      throw error;
    }
  }

  return {
    generateTranscript,
    extractContent,
  };
}
