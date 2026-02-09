// src/processing/pipeline.ts
import { v4 as uuidv4 } from 'uuid';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import type { ProcessingResult, Entry, Transcript } from '../types/index.js';
import type { BudgetService } from '../services/budget.js';
import type { PushoverService } from '../services/pushover.js';
import type { ExtractionResult } from './extractor.js';
import type { LLMUsage } from '../services/openai.js';

export interface PipelineConfig {
  minContentLength: number;
  maxRetries: number;
  tempDir: string;
}

export interface ProcessingPipeline {
  processEntry(entry: Entry): Promise<ProcessingResult>;
}

// Type definitions for processing modules
interface FetchHtmlFn {
  (url: string): Promise<string>;
}

interface ExtractContentFn {
  (html: string): Promise<ExtractionResult>;
}

interface Transcriber {
  generateTranscript(
    content: string,
    title: string
  ): Promise<{
    transcript: Transcript;
    usage: LLMUsage;
    provider: 'openai' | 'anthropic';
    model: string;
  }>;
  extractContentWithLLM(
    html: string
  ): Promise<{ content: string; usage: LLMUsage; provider: 'openai' | 'anthropic'; model: string }>;
}

interface TTSProcessor {
  processTranscript(
    transcript: Transcript,
    entryId: string
  ): Promise<{ segmentFiles: string[]; totalUsage: { characters: number } }>;
}

interface AudioMerger {
  mergeAndUpload(
    segmentFiles: string[],
    episodeId: string
  ): Promise<{
    audioKey: string;
    audioUrl: string;
    audioDuration: number;
    audioSize: number;
  }>;
  cleanupSegments(segmentFiles: string[]): void;
}

export function createProcessingPipeline(
  db: Database.Database,
  budgetService: BudgetService,
  pushoverService: PushoverService,
  fetchHtml: FetchHtmlFn,
  extractContent: ExtractContentFn,
  transcriber: Transcriber,
  ttsProcessor: TTSProcessor,
  audioMerger: AudioMerger,
  config: PipelineConfig
): ProcessingPipeline {
  function calculateNextRetryAt(retryCount: number): string {
    // retryCount is the number of times we've already tried (and failed)
    // For first retry (retryCount=0), use 2^0=1 minute
    const baseMinutes = Math.pow(2, retryCount); // 1, 2, 4, 8, 16
    const jitterSeconds = Math.floor(Math.random() * 30);
    const delayMs = (baseMinutes * 60 + jitterSeconds) * 1000;
    return new Date(Date.now() + delayMs).toISOString();
  }

  function validateSegments(entryId: string, expectedCount: number, tempDir: string): boolean {
    // Check if all expected segment files exist
    for (let i = 0; i < expectedCount; i++) {
      const segmentPath = join(tempDir, `${entryId}_${i}.aac`);
      if (!existsSync(segmentPath)) {
        console.log(`[Resume] Entry ${entryId}: Missing segment ${i} at ${segmentPath}`);
        return false;
      }
    }
    console.log(`[Resume] Entry ${entryId}: All ${expectedCount} segments validated`);
    return true;
  }

  async function processEntry(entry: Entry): Promise<ProcessingResult> {
    const entryId = entry.id;
    let segmentFiles: string[] = [];

    try {
      // Mark as processing
      db.prepare('UPDATE entries SET status = ? WHERE id = ?').run('processing', entryId);

      // Step 0: Determine resume point based on existing state
      const shouldResume = !entry.force_reprocess;
      let resumeFrom: 'fetch' | 'extract' | 'transcript' | 'tts' | 'merge' = 'fetch';

      if (shouldResume) {
        // Check what we can skip based on persisted state
        if (entry.extracted_content && entry.transcript_json && entry.expected_segment_count) {
          // Have transcript, check if segments exist and are valid
          const segmentsValid = validateSegments(
            entryId,
            entry.expected_segment_count,
            config.tempDir
          );
          if (segmentsValid) {
            resumeFrom = 'merge';
            console.log(`[Resume] Entry ${entryId}: Resuming from merge (all segments valid)`);
          } else {
            resumeFrom = 'tts';
            console.log(`[Resume] Entry ${entryId}: Resuming from TTS (segments incomplete)`);
          }
        } else if (entry.extracted_content && entry.transcript_json) {
          resumeFrom = 'tts';
          console.log(`[Resume] Entry ${entryId}: Resuming from TTS (transcript exists)`);
        } else if (entry.extracted_content) {
          resumeFrom = 'transcript';
          console.log(`[Resume] Entry ${entryId}: Resuming from transcript (content extracted)`);
        }
      } else {
        console.log(`[Resume] Entry ${entryId}: Force reprocess enabled - running full pipeline`);
        // Clear all intermediate state for fresh run
        db.prepare(
          'UPDATE entries SET extracted_content = NULL, transcript_json = NULL, ' +
            'expected_segment_count = NULL, title = NULL WHERE id = ?'
        ).run(entryId);
      }

      // Clear force_reprocess flag after using it
      if (entry.force_reprocess) {
        db.prepare('UPDATE entries SET force_reprocess = 0 WHERE id = ?').run(entryId);
      }

      // Step 1: Fetch HTML
      let html: string;
      if (resumeFrom === 'fetch') {
        html = await fetchHtml(entry.url);
      } else {
        html = ''; // Not needed when resuming
      }

      // Step 2: Extract content
      let title: string;
      let content: string;

      if (resumeFrom === 'fetch') {
        // Run extraction as normal
        let useLLMFallback = false;
        title = ''; // Initialize to empty
        content = ''; // Initialize to empty

        try {
          const result = await extractContent(html);
          title = result.title;
          content = result.content;

          // Check if content is too short
          if (content.length < config.minContentLength) {
            useLLMFallback = true;
          }
        } catch (_error) {
          // Readability failed - fall back to LLM
          useLLMFallback = true;
        }

        // Fallback to LLM if extraction failed or content too short
        if (useLLMFallback) {
          const llmResult = await transcriber.extractContentWithLLM(html);
          content = llmResult.content;

          // Log LLM extraction usage
          const service = llmResult.provider === 'anthropic' ? 'anthropic_chat' : 'openai_chat';
          await budgetService.logUsage({
            entry_id: entryId,
            service,
            model: llmResult.model,
            input_units: llmResult.usage.inputTokens,
            output_units: llmResult.usage.outputTokens,
            cost_usd: budgetService.calculateCost(
              service,
              llmResult.model,
              llmResult.usage.inputTokens,
              llmResult.usage.outputTokens
            ),
          });
        }

        // Validate content length
        if (content.length < config.minContentLength) {
          throw new Error('Insufficient content extracted');
        }

        // Update entry with extracted content
        db.prepare('UPDATE entries SET title = ?, extracted_content = ? WHERE id = ?').run(
          title || 'Untitled',
          content,
          entryId
        );
      } else {
        // Resume: Load from DB
        title = entry.title || 'Untitled';
        content = entry.extracted_content!;
        console.log(`[Resume] Entry ${entryId}: Using cached content (${content.length} chars)`);
      }

      // Step 3: Generate transcript
      let transcript: Transcript;

      if (resumeFrom === 'fetch' || resumeFrom === 'transcript') {
        // Generate transcript as normal
        const transcriptResult = await transcriber.generateTranscript(content, title);

        // Log transcript usage
        const transcriptService =
          transcriptResult.provider === 'anthropic' ? 'anthropic_chat' : 'openai_chat';
        await budgetService.logUsage({
          entry_id: entryId,
          service: transcriptService,
          model: transcriptResult.model,
          input_units: transcriptResult.usage.inputTokens,
          output_units: transcriptResult.usage.outputTokens,
          cost_usd: budgetService.calculateCost(
            transcriptService,
            transcriptResult.model,
            transcriptResult.usage.inputTokens,
            transcriptResult.usage.outputTokens
          ),
        });

        transcript = transcriptResult.transcript;

        // Update entry with transcript
        db.prepare('UPDATE entries SET transcript_json = ? WHERE id = ?').run(
          JSON.stringify(transcript),
          entryId
        );
      } else {
        // Resume: Load from DB
        try {
          transcript = JSON.parse(entry.transcript_json!) as Transcript;
          console.log(
            `[Resume] Entry ${entryId}: Using cached transcript (${transcript.length} segments)`
          );
        } catch (_err) {
          // Corrupted transcript - regenerate
          console.log(`[Resume] Entry ${entryId}: Corrupted transcript JSON, regenerating`);
          const transcriptResult = await transcriber.generateTranscript(content, title);
          transcript = transcriptResult.transcript;

          // Log usage
          const transcriptService =
            transcriptResult.provider === 'anthropic' ? 'anthropic_chat' : 'openai_chat';
          await budgetService.logUsage({
            entry_id: entryId,
            service: transcriptService,
            model: transcriptResult.model,
            input_units: transcriptResult.usage.inputTokens,
            output_units: transcriptResult.usage.outputTokens,
            cost_usd: budgetService.calculateCost(
              transcriptService,
              transcriptResult.model,
              transcriptResult.usage.inputTokens,
              transcriptResult.usage.outputTokens
            ),
          });

          // Save to DB
          db.prepare('UPDATE entries SET transcript_json = ? WHERE id = ?').run(
            JSON.stringify(transcript),
            entryId
          );
        }
      }

      // Step 4: Generate TTS
      if (resumeFrom !== 'merge') {
        // Clean up any partial/old segments before regenerating
        if (entry.expected_segment_count) {
          for (let i = 0; i < entry.expected_segment_count; i++) {
            const oldSegment = join(config.tempDir, `${entryId}_${i}.aac`);
            try {
              unlinkSync(oldSegment);
            } catch {
              // Ignore if file doesn't exist
            }
          }
        }

        // Generate new segments
        const { segmentFiles: audioSegments, totalUsage: ttsUsage } =
          await ttsProcessor.processTranscript(transcript, entryId);

        segmentFiles = audioSegments;

        // Log TTS usage
        await budgetService.logUsage({
          entry_id: entryId,
          service: 'openai_tts',
          model: 'gpt-4o-mini-tts',
          input_units: ttsUsage.characters,
          output_units: null,
          cost_usd: budgetService.calculateCost(
            'openai_tts',
            'gpt-4o-mini-tts',
            ttsUsage.characters
          ),
        });

        // Save segment count to DB
        db.prepare('UPDATE entries SET expected_segment_count = ? WHERE id = ?').run(
          segmentFiles.length,
          entryId
        );
      } else {
        // Resume: Reconstruct segment file paths from transcript
        segmentFiles = [];
        for (let i = 0; i < transcript.length; i++) {
          segmentFiles.push(join(config.tempDir, `${entryId}_${i}.aac`));
        }
        console.log(`[Resume] Entry ${entryId}: Reusing ${segmentFiles.length} TTS segments`);
      }

      // Step 5: Merge and upload
      const episodeId = uuidv4();
      const audioResult = await audioMerger.mergeAndUpload(segmentFiles, episodeId);

      // Cleanup segments after successful upload
      audioMerger.cleanupSegments(segmentFiles);

      // Step 6: Create episode
      const description = content.substring(0, 200) + (content.length > 200 ? '...' : '');
      const publishedAt = new Date().toISOString();

      db.prepare(
        `INSERT INTO episodes (id, entry_id, category, title, description, audio_key, audio_duration, audio_size, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        episodeId,
        entryId,
        entry.category,
        title || 'Untitled',
        description,
        audioResult.audioKey,
        audioResult.audioDuration,
        audioResult.audioSize,
        publishedAt
      );

      // Mark entry as completed
      db.prepare('UPDATE entries SET status = ?, processed_at = ? WHERE id = ?').run(
        'completed',
        publishedAt,
        entryId
      );

      return { success: true, entry_id: entryId, episode_id: episodeId };
    } catch (error) {
      const err = error as Error;
      // Get current retry count from database (in case entry object is stale)
      const dbEntry = db.prepare('SELECT retry_count FROM entries WHERE id = ?').get(entryId) as
        | { retry_count: number }
        | undefined;
      const currentRetryCount = dbEntry?.retry_count ?? 0;
      const newRetryCount = currentRetryCount + 1;

      if (newRetryCount >= config.maxRetries) {
        // Mark as permanently failed
        db.prepare(
          'UPDATE entries SET status = ?, error_message = ?, retry_count = ? WHERE id = ?'
        ).run('failed', err.message, newRetryCount, entryId);

        // Send failure notification
        await pushoverService.sendProcessingFailed(entryId, entry.url, err.message);
      } else {
        // Schedule retry
        // Use current retry count (before increment) as the exponent
        // First retry (currentRetryCount=0): 2^0 = 1 minute
        // Second retry (currentRetryCount=1): 2^1 = 2 minutes
        const nextRetryAt = calculateNextRetryAt(currentRetryCount);
        db.prepare(
          'UPDATE entries SET status = ?, error_message = ?, retry_count = ?, next_retry_at = ? WHERE id = ?'
        ).run('failed', err.message, newRetryCount, nextRetryAt, entryId);
      }

      // Keep segments for retry if upload failed
      // (they'll be cleaned up on next attempt or by cleanup job)

      return { success: false, entry_id: entryId, error: err.message };
    }
  }

  return { processEntry };
}
