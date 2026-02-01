// src/processing/pipeline.ts
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { ProcessingResult, Entry, Transcript } from '../types/index.js';
import type { BudgetService } from '../services/budget.js';
import type { PushoverService } from '../services/pushover.js';
import type { ExtractionResult } from './extractor.js';
import type { LLMUsage } from '../services/openai.js';

export interface PipelineConfig {
  minContentLength: number;
  maxRetries: number;
  baseRetryDelayMs: number;
}

export interface ProcessingPipeline {
  processEntry(entryId: string): Promise<ProcessingResult>;
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
  ): Promise<{ transcript: Transcript; usage: LLMUsage }>;
  extractContentWithLLM(html: string): Promise<{ content: string; usage: LLMUsage }>;
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
  async function processEntry(entryId: string): Promise<ProcessingResult> {
    let segmentFiles: string[] = [];

    try {
      // Step 1: Check budget
      const canProcess = await budgetService.canProcess();
      if (!canProcess) {
        return {
          success: false,
          entryId,
          error: 'Budget exceeded - processing paused',
        };
      }

      // Get entry
      const entry = db
        .prepare('SELECT * FROM entries WHERE id = ?')
        .get(entryId) as Entry | undefined;

      if (!entry) {
        return {
          success: false,
          entryId,
          error: 'Entry not found',
        };
      }

      // Step 2: Set entry status to processing
      db.prepare('UPDATE entries SET status = ? WHERE id = ?').run('processing', entryId);

      // Step 3: Fetch HTML
      const html = await fetchHtml(entry.url);

      // Step 4: Extract content (Readability + LLM fallback if needed)
      let extractedTitle = '';
      let extractedContent = '';
      let extractionUsage: LLMUsage | null = null;

      const readabilityResult = await extractContent(html);

      if (
        !readabilityResult.content ||
        readabilityResult.content.length < config.minContentLength
      ) {
        // Fallback to LLM extraction
        const llmResult = await transcriber.extractContentWithLLM(html);
        extractedContent = llmResult.content;
        extractedTitle = readabilityResult.title || 'Untitled';
        extractionUsage = llmResult.usage;

        // Log LLM extraction cost
        const extractionCost = budgetService.calculateCost(
          'openai_chat', // Assuming OpenAI for now
          'gpt-4o',
          extractionUsage.inputTokens,
          extractionUsage.outputTokens
        );
        await budgetService.logUsage({
          entryId,
          service: 'openai_chat',
          model: 'gpt-4o',
          inputUnits: extractionUsage.inputTokens,
          outputUnits: extractionUsage.outputTokens,
          costUsd: extractionCost,
        });
      } else {
        extractedTitle = readabilityResult.title;
        extractedContent = readabilityResult.content;
      }

      // Validate content length
      if (extractedContent.length < config.minContentLength) {
        throw new Error(
          `Content too short: ${extractedContent.length} < ${config.minContentLength}`
        );
      }

      // Step 5: Generate transcript via LLM
      const { transcript, usage: transcriptUsage } =
        await transcriber.generateTranscript(extractedContent, extractedTitle);

      // Log transcript generation cost
      const transcriptCost = budgetService.calculateCost(
        'openai_chat',
        'gpt-4o',
        transcriptUsage.inputTokens,
        transcriptUsage.outputTokens
      );
      await budgetService.logUsage({
        entryId,
        service: 'openai_chat',
        model: 'gpt-4o',
        inputUnits: transcriptUsage.inputTokens,
        outputUnits: transcriptUsage.outputTokens,
        costUsd: transcriptCost,
      });

      // Step 6: Generate TTS segments
      const { segmentFiles: audioSegments, totalUsage: ttsUsage } =
        await ttsProcessor.processTranscript(transcript, entryId);

      segmentFiles = audioSegments;

      // Log TTS cost
      const ttsCost = budgetService.calculateCost(
        'openai_tts',
        'tts-1',
        ttsUsage.characters
      );
      await budgetService.logUsage({
        entryId,
        service: 'openai_tts',
        model: 'tts-1',
        inputUnits: ttsUsage.characters,
        outputUnits: null,
        costUsd: ttsCost,
      });

      // Step 7: Merge audio and upload to R2
      const episodeId = uuidv4();
      const { audioKey, audioUrl, audioDuration, audioSize } =
        await audioMerger.mergeAndUpload(audioSegments, episodeId);

      // Step 8: Create episode record
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO episodes (id, entry_id, category, title, description, audio_key, audio_duration, audio_size, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        episodeId,
        entryId,
        entry.category,
        extractedTitle,
        `Podcast episode from: ${entry.url}`,
        audioKey,
        audioDuration,
        audioSize,
        now
      );

      // Step 9: Update entry to completed
      db.prepare(
        `UPDATE entries
         SET status = ?,
             title = ?,
             extracted_content = ?,
             transcript_json = ?,
             processed_at = ?
         WHERE id = ?`
      ).run(
        'completed',
        extractedTitle,
        extractedContent,
        JSON.stringify(transcript),
        now,
        entryId
      );

      // Cleanup temp files
      audioMerger.cleanupSegments(segmentFiles);

      return {
        success: true,
        entryId,
        episodeId,
      };
    } catch (error) {
      // Cleanup temp files on error
      if (segmentFiles.length > 0) {
        audioMerger.cleanupSegments(segmentFiles);
      }

      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      // Get current retry count
      const entry = db
        .prepare('SELECT retry_count FROM entries WHERE id = ?')
        .get(entryId) as { retry_count: number } | undefined;

      const currentRetryCount = entry?.retry_count ?? 0;
      const newRetryCount = currentRetryCount + 1;

      // Calculate next retry time with exponential backoff + jitter
      let nextRetryAt: string | null = null;
      if (newRetryCount < config.maxRetries) {
        // Exponential backoff: baseDelay * 2^(retryCount)
        const baseDelay = config.baseRetryDelayMs * Math.pow(2, currentRetryCount);
        // Add 10% jitter
        const jitter = baseDelay * 0.1 * (Math.random() * 2 - 1);
        const delayMs = baseDelay + jitter;
        const nextRetry = new Date(Date.now() + delayMs);
        nextRetryAt = nextRetry.toISOString();
      }

      // Update entry with error info
      db.prepare(
        `UPDATE entries
         SET status = ?,
             retry_count = ?,
             next_retry_at = ?,
             error_message = ?
         WHERE id = ?`
      ).run('failed', newRetryCount, nextRetryAt, errorMessage, entryId);

      // Send notification if max retries exceeded
      if (newRetryCount >= config.maxRetries) {
        const entry = db
          .prepare('SELECT url FROM entries WHERE id = ?')
          .get(entryId) as { url: string } | undefined;
        if (entry) {
          await pushoverService.sendProcessingFailed(
            entryId,
            entry.url,
            errorMessage
          );
        }
      }

      return {
        success: false,
        entryId,
        error: errorMessage,
      };
    }
  }

  return {
    processEntry,
  };
}
