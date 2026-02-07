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

  async function processEntry(entry: Entry): Promise<ProcessingResult> {
    const entryId = entry.id;
    let segmentFiles: string[] = [];

    try {
      // Mark as processing
      db.prepare('UPDATE entries SET status = ? WHERE id = ?').run('processing', entryId);

      // Step 1: Fetch HTML
      const html = await fetchHtml(entry.url);

      // Step 2: Extract content
      const { title, content: extractedContent } = await extractContent(html);
      let content = extractedContent;

      // Fallback to LLM if content too short
      if (content.length < config.minContentLength) {
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

      // Step 3: Generate transcript
      const transcriptResult = await transcriber.generateTranscript(content, title || 'Untitled');

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

      // Update entry with transcript
      db.prepare('UPDATE entries SET transcript_json = ? WHERE id = ?').run(
        JSON.stringify(transcriptResult.transcript),
        entryId
      );

      // Step 4: Generate TTS
      const { segmentFiles: audioSegments, totalUsage: ttsUsage } =
        await ttsProcessor.processTranscript(transcriptResult.transcript, entryId);

      segmentFiles = audioSegments;

      // Log TTS usage
      await budgetService.logUsage({
        entry_id: entryId,
        service: 'openai_tts',
        model: 'gpt-4o-mini-tts',
        input_units: ttsUsage.characters,
        output_units: null,
        cost_usd: budgetService.calculateCost('openai_tts', 'gpt-4o-mini-tts', ttsUsage.characters),
      });

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
