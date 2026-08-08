// src/processing/transcriber.ts
import type { Transcript } from '../types/index.js';
import type { OpenAIService, LLMUsage } from '../services/openai.js';
import type { AnthropicService } from '../services/anthropic.js';

export interface TranscriberConfig {
  provider: 'openai' | 'anthropic';
  /** Model for turning an extracted article into a podcast script. */
  transcriptModel: string;
  /** Model for the LLM fallback that pulls article text out of raw HTML. */
  extractionModel: string;
  minContentLength: number;
}

export interface TranscriberResult {
  transcript: Transcript;
  usage: LLMUsage;
  provider: 'openai' | 'anthropic';
  model: string;
}

export function createTranscriber(
  openaiService: OpenAIService | null,
  anthropicService: AnthropicService | null,
  config: TranscriberConfig
) {
  async function generateTranscript(content: string, title: string): Promise<TranscriberResult> {
    if (content.length < config.minContentLength) {
      throw new Error(`Content too short: ${content.length} < ${config.minContentLength}`);
    }

    if (config.provider === 'anthropic' && anthropicService) {
      const result = await anthropicService.generateTranscript(
        content,
        title,
        config.transcriptModel
      );
      return {
        ...result,
        provider: 'anthropic',
        model: config.transcriptModel,
      };
    }

    if (openaiService) {
      const result = await openaiService.generateTranscript(content, title, config.transcriptModel);
      return {
        ...result,
        provider: 'openai',
        model: config.transcriptModel,
      };
    }

    throw new Error('No LLM service configured');
  }

  async function extractContentWithLLM(html: string): Promise<{
    content: string;
    usage: LLMUsage;
    provider: 'openai' | 'anthropic';
    model: string;
  }> {
    if (config.provider === 'anthropic' && anthropicService) {
      const result = await anthropicService.extractContent(html, config.extractionModel);
      return {
        ...result,
        provider: 'anthropic',
        model: config.extractionModel,
      };
    }

    if (openaiService) {
      const result = await openaiService.extractContent(html, config.extractionModel);
      return {
        ...result,
        provider: 'openai',
        model: config.extractionModel,
      };
    }

    throw new Error('No LLM service configured');
  }

  return {
    generateTranscript,
    extractContentWithLLM,
  };
}
