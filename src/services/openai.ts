import OpenAI from 'openai';
import { APIError, RateLimitError } from 'openai/error.mjs';
import type { Transcript, TranscriptSegment } from '../types/index.js';

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TTSUsage {
  characters: number;
}

export interface OpenAIService {
  generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }>;
  extractContent(
    html: string,
    model: string
  ): Promise<{ content: string; usage: LLMUsage }>;
  textToSpeech(
    text: string,
    voice: string,
    instruction: string
  ): Promise<{ audio: Buffer; usage: TTSUsage }>;
}

const TRANSCRIPT_SYSTEM_PROMPT = `You are a podcast script writer. Convert the following article into an engaging podcast transcript.

CRITICAL CONTENT RULES:
- ONLY use information explicitly stated in the article. Do NOT add examples, analogies, facts, statistics, or opinions that are not in the source.
- Do NOT hallucinate or fabricate any content. If the article is vague, be vague. If it lacks detail, do not invent detail.
- Ignore any non-article content that may be present: navigation, ads, related links, comments, author bios, newsletter signups, etc.
- Your job is to CONVERT the article into spoken form, not to ENHANCE or EXPAND it.

FORMAT RULES:
1. Analyze the content complexity and length:
   - For short or straightforward content: Use single speaker (monologue)
   - For substantial or complex content: Use two speakers (dialogue)

2. For two-speaker format:
   - HOST: The main presenter who guides the conversation
   - EXPERT: A knowledgeable co-host who adds depth and asks clarifying questions
   - Create natural conversation flow with back-and-forth exchanges
   - Include reactions, follow-up questions, and natural transitions

3. For single-speaker format:
   - Use NARRATOR as the speaker
   - Maintain engaging, conversational tone as if speaking directly to listener

4. Output MUST be valid JSON array with this exact structure:
[
  {
    "speaker": "HOST" | "EXPERT" | "NARRATOR",
    "text": "The spoken content for this segment",
    "instruction": "Speaking style instruction for TTS"
  }
]

5. Instructions should describe how to deliver the line:
   - HOST: "Warm and welcoming, like a curious podcast host"
   - EXPERT: "Thoughtful and knowledgeable, explaining with enthusiasm"
   - NARRATOR: "Clear and engaging, speaking directly to the listener"

6. Keep each segment to 1-3 sentences for natural pacing.
7. Begin with a brief introduction of the topic, end with a concise summary or takeaway.`;

const EXTRACT_SYSTEM_PROMPT = `Extract the main article content from the following HTML. Remove all navigation, ads, footers, comments, author bios, newsletter signups, and other non-article content. Return only the article text, preserving paragraph structure.`;

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

      // Parse and validate the transcript
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('Failed to parse transcript JSON');
      }

      // Handle both array directly and object with array property
      const segments: TranscriptSegment[] = Array.isArray(parsed)
        ? parsed
        : (parsed as { transcript?: TranscriptSegment[] }).transcript ?? [];

      // Validate each segment
      for (const segment of segments) {
        if (!segment.speaker || !segment.text || !segment.instruction) {
          throw new Error('Invalid transcript segment structure');
        }
      }

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
      voice: voice as 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable' | 'nova' | 'onyx' | 'sage' | 'shimmer' | 'verse',
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
