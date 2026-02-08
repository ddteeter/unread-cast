import Anthropic from '@anthropic-ai/sdk';
import { APIError } from '@anthropic-ai/sdk';
import type { Transcript } from '../types/index.js';
import {
  parseAndValidateTranscript,
  TRANSCRIPT_SYSTEM_PROMPT,
  EXTRACT_SYSTEM_PROMPT,
  type LLMUsage,
} from './llm-common.js';

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
      const response = await client.messages.create({
        model,
        max_tokens: maxTranscriptTokens,
        temperature: 0.7,
        system: TRANSCRIPT_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Article Title: ${title}\n\nArticle Content:\n${content}`,
          },
        ],
      });

      const textBlock = response.content.find((block) => block.type === 'text');
      const text = textBlock?.type === 'text' ? textBlock.text : '[]';
      const segments = parseAndValidateTranscript(text);

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
        temperature: 0,
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
