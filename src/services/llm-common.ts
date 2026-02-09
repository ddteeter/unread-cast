// src/services/llm-common.ts
// Shared utilities and prompts for LLM services (OpenAI and Anthropic)

import type { TranscriptSegment } from '../types/index.js';

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TTSUsage {
  characters: number;
}

export const TRANSCRIPT_SYSTEM_PROMPT = `You are a podcast script writer. Convert the following article into an engaging podcast transcript.

CRITICAL CONTENT RULES:
- Your job is to FAITHFULLY RENDER the article as audio, staying as close as possible to the original text. This is not a summary - users expect to hear the full article content.
- ONLY use information explicitly stated in the article. Do NOT add examples, analogies, facts, statistics, or opinions that are not in the source.
- Do NOT hallucinate or fabricate any content. If the article is vague, be vague. If it lacks detail, do not invent detail.
- Ignore any non-article content that may be present: navigation, ads, related links, comments, author bios, newsletter signups, etc.
- Your job is to CONVERT the article into spoken form, not to ENHANCE or EXPAND it.
- Preserve the article's original sequential order. Output segments must follow the article's natural flow from beginning to end. Do not reorder sections or topics for dramatic effect.

FORMAT RULES:
1. Analyze the content complexity and length:
   - For short or straightforward content: Use single speaker (monologue)
   - For substantial or complex content: Use two speakers (dialogue)

2. For two-speaker format:
   - HOST: The main presenter who guides the conversation
   - EXPERT: A knowledgeable co-host who adds depth and asks clarifying questions
   - Create natural conversation flow with back-and-forth exchanges
   - Include reactions, follow-up questions, and natural transitions
   - HOST may invent questions and transitions to facilitate conversational flow, but must NOT introduce new facts, information, or examples not present in the article. EXPERT must only explain and elaborate on content explicitly stated in the source material.

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

6. Segment length flexibility for natural conversation:
   - Keep segments between 1-5 sentences depending on context
   - HOST segments can be shorter (questions, reactions, transitions)
   - EXPERT segments can be longer when explaining concepts from the article
   - Maintain natural conversational rhythm and pacing

7. Begin with a brief introduction of the topic, end with a concise summary or takeaway.`;

export const EXTRACT_SYSTEM_PROMPT = `Extract the main article content from the following HTML. Remove all navigation, ads, footers, comments, author bios, newsletter signups, and other non-article content. Return only the article text, preserving paragraph structure.`;

/**
 * Parses and validates a transcript JSON string into TranscriptSegment array.
 * Supports both array format and object-with-array format.
 * Handles markdown code blocks and extra whitespace from LLM responses.
 */
export function parseAndValidateTranscript(jsonText: string): TranscriptSegment[] {
  // Log the raw response for debugging
  console.log('Raw LLM transcript response (first 500 chars):', jsonText.substring(0, 500));

  // Strip markdown code blocks if present (```json ... ``` or ``` ... ```)
  let cleanedText = jsonText.trim();
  const codeBlockMatch = cleanedText.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/);
  if (codeBlockMatch) {
    cleanedText = codeBlockMatch[1].trim();
    console.log('Stripped markdown code blocks from LLM response');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleanedText);
  } catch (error) {
    console.error('Failed to parse transcript JSON:', error);
    console.error('Cleaned text (first 1000 chars):', cleanedText.substring(0, 1000));
    throw new Error(
      `Failed to parse transcript JSON: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  // Handle both array directly and object with array property
  const segments: TranscriptSegment[] = Array.isArray(parsed)
    ? (parsed as TranscriptSegment[])
    : ((parsed as { transcript?: TranscriptSegment[] }).transcript ?? []);

  // Validate each segment
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment.speaker || !segment.text || !segment.instruction) {
      console.error(`Invalid segment at index ${i}:`, segment);
      throw new Error(`Invalid transcript segment structure at index ${i}`);
    }
  }

  console.log(`Successfully parsed ${segments.length} transcript segments`);
  return segments;
}
