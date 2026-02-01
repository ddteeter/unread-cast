import Anthropic from '@anthropic-ai/sdk';
import type { Transcript, TranscriptSegment } from '../types/index.js';
import type { LLMUsage } from './openai.js';

export interface AnthropicService {
  generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }>;
  extractContent(
    html: string,
    model: string
  ): Promise<{ content: string; usage: LLMUsage }>;
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
7. Begin with a brief introduction of the topic, end with a concise summary or takeaway.

Respond with ONLY the JSON array, no other text.`;

const EXTRACT_SYSTEM_PROMPT = `Extract the main article content from the following HTML. Remove all navigation, ads, footers, comments, author bios, newsletter signups, and other non-article content. Return only the article text, preserving paragraph structure.`;

export function createAnthropicService(apiKey: string): AnthropicService {
  const client = new Anthropic({ apiKey });

  async function generateTranscript(
    content: string,
    title: string,
    model: string
  ): Promise<{ transcript: Transcript; usage: LLMUsage }> {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
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

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Failed to parse transcript JSON');
    }

    const segments: TranscriptSegment[] = Array.isArray(parsed)
      ? parsed
      : (parsed as { transcript?: TranscriptSegment[] }).transcript ?? [];

    for (const segment of segments) {
      if (!segment.speaker || !segment.text || !segment.instruction) {
        throw new Error('Invalid transcript segment structure');
      }
    }

    return {
      transcript: segments,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  async function extractContent(
    html: string,
    model: string
  ): Promise<{ content: string; usage: LLMUsage }> {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
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
  }

  return {
    generateTranscript,
    extractContent,
  };
}
