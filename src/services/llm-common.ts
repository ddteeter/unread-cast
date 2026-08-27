// src/services/llm-common.ts
// Shared utilities and prompts for LLM services (OpenAI and Anthropic)

import { z } from 'zod';
import type { TranscriptSegment } from '../types/index.js';

/**
 * The single source of truth for transcript shape.
 *
 * Both providers constrain their output against this schema - OpenAI via
 * `zodResponseFormat` on Chat Completions, Anthropic via `zodOutputFormat` on
 * `messages.parse`. Deriving both from one Zod object matters more than saving the
 * duplication: the whole point of the per-stage model config is head-to-head A/B
 * testing, and a provider whose request is shaped differently is not a fair comparison.
 */
export const TranscriptSchema = z.object({
  transcript: z.array(
    z.object({
      speaker: z.enum(['HOST', 'AUTHOR', 'NARRATOR']),
      text: z.string(),
      instruction: z.string(),
    })
  ),
});

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
   - HOST: An interviewer who asks questions to draw out the article's content
   - AUTHOR: The article's author who explains and discusses their own work
   - Create natural interview flow with back-and-forth exchanges
   - Include reactions, follow-up questions, and natural transitions
   - HOST may invent questions and transitions to facilitate conversational flow, but must NOT introduce new facts, information, or examples not present in the article. AUTHOR must only explain and elaborate on content explicitly stated in the source material.
   - Maintain consistent voice character: Each speaker should have a baseline delivery style used for most segments
   - Strategic emotional moments: Vary energy only at key points (major findings, surprises, complex concepts)
   - HOST should display authentic reactions to genuinely interesting points, while maintaining baseline enthusiasm
   - Avoid emotional rollercoaster: Don't change tone every segment - consistency creates professionalism

3. For single-speaker format:
   - Use NARRATOR as the speaker
   - Maintain engaging, conversational tone as if speaking directly to listener

4. Output MUST be valid JSON array with this exact structure:
[
  {
    "speaker": "HOST" | "AUTHOR" | "NARRATOR",
    "text": "The spoken content for this segment",
    "instruction": "Speaking style instruction for TTS"
  }
]

5. Instructions should be SHORT and CONSISTENT (2-4 words preferred):
   - Focus on primary tone/emotion: "Enthusiastic", "Curious and excited", "Thoughtful", "Surprised"
   - Avoid long descriptive phrases - the TTS model works best with simple, clear direction
   - IMPORTANT: Use the same baseline instruction for most segments of each speaker to maintain consistent voice character
   - Only vary instructions strategically at key moments:
     * Introduce excitement/surprise for major findings or unexpected results
     * Shift to thoughtfulness for particularly complex concepts
     * Show appropriate gravity for serious implications
   - Baseline examples (use for most segments):
     * HOST: "Enthusiastic and curious"
     * AUTHOR: "Knowledgeable and engaged"
     * NARRATOR: "Clear and engaging"
   - Strategic variations (use sparingly):
     * "Surprised and intrigued" (for unexpected findings)
     * "Thoughtful and serious" (for complex/serious topics)
     * "Excited" (for particularly interesting points)
   - IMPORTANT: When a speaker's tone needs to change mid-thought, create a NEW segment with the new instruction rather than forcing one tone across varied content. This allows strategic shifts within a single speaker's turn (e.g., AUTHOR explains baseline concept [segment 1: "Knowledgeable and engaged"], then reveals exciting finding [segment 2: "Excited"])

6. Segment length flexibility for natural conversation:
   - Keep segments between 1-5 sentences depending on context
   - HOST segments can be shorter (questions, reactions, transitions)
   - AUTHOR segments can be longer when explaining concepts from the article
   - Maintain natural conversational rhythm and pacing

7. Begin with a brief introduction of the topic, end with a concise summary or takeaway.`;

export const EXTRACT_SYSTEM_PROMPT = `Extract the main article content from the following HTML. Remove all navigation, ads, footers, comments, author bios, newsletter signups, and other non-article content. Return only the article text, preserving paragraph structure.`;

// Control characters that should never appear in text destined for TTS. Excludes
// tab/newline/carriage-return, which are harmless.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const REPLACEMENT_CHAR = /\uFFFD/;

// Anything outside Latin + common punctuation/symbol ranges.
const NON_LATIN = /[^\u0000-\u024F\u2000-\u206F\u20A0-\u20CF\s]/g;

/**
 * Guards against structurally-valid but semantically corrupt model output.
 *
 * Schema validation alone is not enough here. There is an open report of
 * gpt-5.6-luna emitting degenerate tokens (foreign scripts, leaked reasoning) inside
 * string values while the JSON stays schema-valid under `strict: true` - which means
 * it would pass every structural check we have and then be read aloud by TTS.
 *
 * Hard-fails only on characters that are unambiguously wrong; suspected corruption
 * is logged rather than thrown, so a legitimately non-English article is never
 * blocked by a heuristic.
 */
function validateSegmentText(text: string, index: number): void {
  if (text.trim().length === 0) {
    throw new Error(`Transcript segment ${index} has empty or whitespace-only text`);
  }
  if (REPLACEMENT_CHAR.test(text)) {
    throw new Error(`Transcript segment ${index} contains Unicode replacement characters`);
  }
  if (CONTROL_CHARS.test(text)) {
    throw new Error(`Transcript segment ${index} contains control characters`);
  }

  const nonLatin = text.match(NON_LATIN);
  if (!nonLatin) return;

  // A genuinely non-English article is *mostly* non-Latin. A corrupted tail is a
  // small minority embedded in otherwise-Latin text, which is the reported signature.
  const ratio = nonLatin.length / text.length;
  if (ratio < 0.1) {
    console.warn(
      `Transcript segment ${index}: ${nonLatin.length} non-Latin character(s) in otherwise-Latin text ` +
        `- possible model output corruption. Tail: ${JSON.stringify(text.slice(-60))}`
    );
  }
}

/**
 * Parses and validates a transcript JSON string into TranscriptSegment array.
 * Supports both array format and object-with-array format.
 * Handles markdown code blocks and extra whitespace from LLM responses.
 *
 * Both providers now constrain output against `TranscriptSchema`, so the fence
 * stripping and dual-shape handling below should never fire on a default deployment.
 * They are kept because `LLM_MODEL` accepts an arbitrary string: an operator can pin a
 * model whose schema support is partial or absent, and a fence-wrapped response is a
 * recoverable failure that should not cost an entry a retry.
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

  return validateTranscriptSegments(segments);
}

/**
 * Shape and content validation for an already-decoded transcript.
 *
 * Split out from `parseAndValidateTranscript` because the Anthropic path now goes
 * through `messages.parse`, which hands back a decoded object rather than a JSON
 * string. Schema enforcement guarantees the *shape*; these checks are about whether
 * the strings inside it are safe to hand to TTS, which no schema can express.
 */
export function validateTranscriptSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment.speaker || !segment.text || !segment.instruction) {
      console.error(`Invalid segment at index ${i}:`, segment);
      throw new Error(`Invalid transcript segment structure at index ${i}`);
    }
    validateSegmentText(segment.text, i);
  }

  console.log(`Successfully parsed ${segments.length} transcript segments`);
  return segments;
}
