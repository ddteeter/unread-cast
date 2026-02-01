// tests/processing/pipeline.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { v4 as uuidv4 } from 'uuid';

describe('processing pipeline', () => {
  let tempDir: string;
  let db: Database.Database;
  let entryId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'podcast-later-test-'));
    db = new Database(':memory:');
    initializeSchema(db);

    // Create pricing config
    writeFileSync(
      join(tempDir, 'pricing.json'),
      JSON.stringify({
        openai: {
          'gpt-4o': { input_per_1m: 2.5, output_per_1m: 10.0 },
          'tts-1': { chars_per_1m: 15.0 },
        },
        anthropic: {
          'claude-3-5-sonnet-20241022': { input_per_1m: 3.0, output_per_1m: 15.0 },
        },
      })
    );

    // Create default category
    db.prepare(
      'INSERT INTO categories (name, feed_id, created_at) VALUES (?, ?, ?)'
    ).run('default', uuidv4(), new Date().toISOString());

    // Create test entry
    entryId = uuidv4();
    db.prepare(
      `INSERT INTO entries (id, url, category, status, title, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      entryId,
      'https://example.com/article',
      'default',
      'pending',
      null,
      new Date().toISOString()
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('should successfully process entry through complete pipeline', async () => {
    // Mock all external dependencies
    const mockFetchHtml = vi.fn().mockResolvedValue('<html><body>Article content</body></html>');
    const mockExtractContent = vi.fn().mockResolvedValue({
      title: 'Test Article',
      content: 'This is a long enough article content that should pass validation. '.repeat(50),
    });
    const mockTranscriber = {
      generateTranscript: vi.fn().mockResolvedValue({
        transcript: [
          { speaker: 'NARRATOR', text: 'Welcome to the podcast', instruction: 'Clear and engaging' },
          { speaker: 'NARRATOR', text: 'This is the main content', instruction: 'Clear and engaging' },
        ],
        usage: { inputTokens: 1000, outputTokens: 500 },
      }),
    };
    const mockTTSProcessor = {
      processTranscript: vi.fn().mockResolvedValue({
        segmentFiles: [
          join(tempDir, `${entryId}_0.aac`),
          join(tempDir, `${entryId}_1.aac`),
        ],
        totalUsage: { characters: 1000 },
      }),
    };
    const mockAudioMerger = {
      mergeAndUpload: vi.fn().mockResolvedValue({
        audioKey: 'episode.aac',
        audioUrl: 'https://r2.example.com/episode.aac',
        audioDuration: 120,
        audioSize: 1024000,
      }),
      cleanupSegments: vi.fn(),
    };
    const mockBudgetService = {
      calculateCost: vi.fn().mockReturnValue(0.05),
      logUsage: vi.fn().mockResolvedValue(undefined),
    };
    const mockPushoverService = {
      sendProcessingFailed: vi.fn().mockResolvedValue(undefined),
    };

    // Create segment files for cleanup testing
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'fake audio data');
    writeFileSync(join(tempDir, `${entryId}_1.aac`), 'fake audio data');

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mockBudgetService as any,
      mockPushoverService as any,
      mockFetchHtml,
      mockExtractContent,
      mockTranscriber as any,
      mockTTSProcessor as any,
      mockAudioMerger as any,
      {
        minContentLength: 500,
        maxRetries: 3,
      }
    );

    // Get entry object to pass to processEntry
    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
    const result = await pipeline.processEntry(entry);

    // Verify success
    expect(result.success).toBe(true);
    expect(result.entry_id).toBe(entryId);
    expect(result.episode_id).toBeDefined();

    // Verify all steps were called in order
    expect(mockFetchHtml).toHaveBeenCalledWith('https://example.com/article');
    expect(mockExtractContent).toHaveBeenCalled();
    expect(mockTranscriber.generateTranscript).toHaveBeenCalled();
    expect(mockTTSProcessor.processTranscript).toHaveBeenCalled();
    expect(mockAudioMerger.mergeAndUpload).toHaveBeenCalled();
    expect(mockAudioMerger.cleanupSegments).toHaveBeenCalled();

    // Verify costs were logged
    expect(mockBudgetService.logUsage).toHaveBeenCalledTimes(2); // transcript + TTS

    // Verify entry was updated to completed
    const updatedEntry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
    expect(updatedEntry.status).toBe('completed');
    expect(updatedEntry.title).toBe('Test Article');
    expect(updatedEntry.extracted_content).toContain('This is a long enough');
    expect(updatedEntry.transcript_json).toBeDefined();
    expect(updatedEntry.processed_at).toBeDefined();

    // Verify episode was created
    const episode = db.prepare('SELECT * FROM episodes WHERE entry_id = ?').get(entryId) as any;
    expect(episode).toBeDefined();
    expect(episode.title).toBe('Test Article');
    expect(episode.audio_key).toBe('episode.aac');
    expect(episode.audio_duration).toBe(120);
    expect(episode.audio_size).toBe(1024000);
  });

  it('should not cleanup segments on failure', async () => {
    const mockFetchHtml = vi.fn().mockResolvedValue('<html><body>Article</body></html>');
    const mockExtractContent = vi.fn().mockResolvedValue({
      title: 'Test',
      content: 'Content '.repeat(100),
    });
    const mockTranscriber = {
      generateTranscript: vi.fn().mockResolvedValue({
        transcript: [{ speaker: 'NARRATOR', text: 'Text', instruction: 'Clear' }],
        usage: { inputTokens: 1000, outputTokens: 500 },
      }),
    };
    const mockTTSProcessor = {
      processTranscript: vi.fn().mockResolvedValue({
        segmentFiles: [join(tempDir, `${entryId}_0.aac`)],
        totalUsage: { characters: 1000 },
      }),
    };
    const mockAudioMerger = {
      mergeAndUpload: vi.fn().mockRejectedValue(new Error('Upload failed')),
      cleanupSegments: vi.fn(),
    };
    const mockBudgetService = {
      calculateCost: vi.fn().mockReturnValue(0.05),
      logUsage: vi.fn().mockResolvedValue(undefined),
    };
    const mockPushoverService = {
      sendProcessingFailed: vi.fn(),
    };

    // Create segment file
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'fake audio');

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mockBudgetService as any,
      mockPushoverService as any,
      mockFetchHtml,
      mockExtractContent,
      mockTranscriber as any,
      mockTTSProcessor as any,
      mockAudioMerger as any,
      { minContentLength: 500, maxRetries: 3 }
    );

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
    const result = await pipeline.processEntry(entry);

    expect(result.success).toBe(false);
    // Segments should NOT be cleaned up on failure - kept for retry
    expect(mockAudioMerger.cleanupSegments).not.toHaveBeenCalled();
  });

  it('should handle failures with retry logic', async () => {
    const mockFetchHtml = vi.fn().mockRejectedValue(new Error('Network error'));
    const mockBudgetService = {
      calculateCost: vi.fn(),
      logUsage: vi.fn(),
    };
    const mockPushoverService = {
      sendProcessingFailed: vi.fn().mockResolvedValue(undefined),
    };

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mockBudgetService as any,
      mockPushoverService as any,
      mockFetchHtml,
      vi.fn() as any,
      {} as any,
      {} as any,
      {} as any,
      { minContentLength: 500, maxRetries: 3 }
    );

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
    const result = await pipeline.processEntry(entry);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Network error');

    // Verify entry was updated with retry info
    const updatedEntry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
    expect(updatedEntry.status).toBe('failed');
    expect(updatedEntry.retry_count).toBe(1);
    expect(updatedEntry.next_retry_at).toBeDefined();
    expect(updatedEntry.error_message).toBe('Network error');

    // Calculate expected retry time with exponential backoff
    // First retry (retryCount=0): baseMinutes = 2^0 = 1 minute = 60 seconds
    // Plus 0-30 seconds jitter
    const nextRetry = new Date(updatedEntry.next_retry_at).getTime();
    const now = Date.now();
    const baseDelayMs = 1 * 60 * 1000; // 1 minute in ms
    const maxJitterMs = 30 * 1000; // 30 seconds in ms
    expect(nextRetry).toBeGreaterThanOrEqual(now + baseDelayMs);
    expect(nextRetry).toBeLessThan(now + baseDelayMs + maxJitterMs);
  });

  it('should send notification after max retries exceeded', async () => {
    // Setup entry that has already failed twice
    db.prepare('UPDATE entries SET retry_count = ? WHERE id = ?').run(2, entryId);

    const mockFetchHtml = vi.fn().mockRejectedValue(new Error('Persistent error'));
    const mockBudgetService = {
      calculateCost: vi.fn(),
      logUsage: vi.fn(),
    };
    const mockPushoverService = {
      sendProcessingFailed: vi.fn().mockResolvedValue(undefined),
    };

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mockBudgetService as any,
      mockPushoverService as any,
      mockFetchHtml,
      vi.fn() as any,
      {} as any,
      {} as any,
      {} as any,
      { minContentLength: 500, maxRetries: 3 }
    );

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
    const result = await pipeline.processEntry(entry);

    expect(result.success).toBe(false);

    // Verify retry count was incremented to max
    const updatedEntry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
    expect(updatedEntry.retry_count).toBe(3);
    expect(updatedEntry.next_retry_at).toBeNull(); // No more retries

    // Verify notification was sent
    expect(mockPushoverService.sendProcessingFailed).toHaveBeenCalledWith(
      entryId,
      'https://example.com/article',
      'Persistent error'
    );
  });

  it('should cleanup segments only on success', async () => {
    const mockFetchHtml = vi.fn().mockResolvedValue('<html><body>Article content</body></html>');
    const mockExtractContent = vi.fn().mockResolvedValue({
      title: 'Test Article',
      content: 'This is a long enough article content that should pass validation. '.repeat(50),
    });
    const mockTranscriber = {
      generateTranscript: vi.fn().mockResolvedValue({
        transcript: [
          { speaker: 'NARRATOR', text: 'Welcome to the podcast', instruction: 'Clear and engaging' },
        ],
        usage: { inputTokens: 1000, outputTokens: 500 },
      }),
    };
    const mockTTSProcessor = {
      processTranscript: vi.fn().mockResolvedValue({
        segmentFiles: [join(tempDir, `${entryId}_0.aac`)],
        totalUsage: { characters: 1000 },
      }),
    };
    const mockAudioMerger = {
      mergeAndUpload: vi.fn().mockResolvedValue({
        audioKey: 'episode.aac',
        audioUrl: 'https://r2.example.com/episode.aac',
        audioDuration: 120,
        audioSize: 1024000,
      }),
      cleanupSegments: vi.fn(),
    };
    const mockBudgetService = {
      calculateCost: vi.fn().mockReturnValue(0.05),
      logUsage: vi.fn().mockResolvedValue(undefined),
    };
    const mockPushoverService = {
      sendProcessingFailed: vi.fn(),
    };

    // Create segment file
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'fake audio');

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mockBudgetService as any,
      mockPushoverService as any,
      mockFetchHtml,
      mockExtractContent,
      mockTranscriber as any,
      mockTTSProcessor as any,
      mockAudioMerger as any,
      { minContentLength: 500, maxRetries: 3 }
    );

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
    const result = await pipeline.processEntry(entry);

    expect(result.success).toBe(true);
    // Segments should be cleaned up on success
    expect(mockAudioMerger.cleanupSegments).toHaveBeenCalled();
  });

  it('should use LLM extraction fallback when readability fails', async () => {
    const mockFetchHtml = vi.fn().mockResolvedValue('<html><body>Content</body></html>');
    const mockExtractContent = vi.fn().mockResolvedValue({
      title: '',
      content: '', // Empty indicates failure
    });
    const mockTranscriber = {
      extractContentWithLLM: vi.fn().mockResolvedValue({
        content: 'LLM extracted content '.repeat(50),
        usage: { inputTokens: 500, outputTokens: 200 },
      }),
      generateTranscript: vi.fn().mockResolvedValue({
        transcript: [{ speaker: 'NARRATOR', text: 'Text', instruction: 'Clear' }],
        usage: { inputTokens: 1000, outputTokens: 500 },
      }),
    };
    const mockTTSProcessor = {
      processTranscript: vi.fn().mockResolvedValue({
        segmentFiles: [join(tempDir, `${entryId}_0.aac`)],
        totalUsage: { characters: 1000 },
      }),
    };
    const mockAudioMerger = {
      mergeAndUpload: vi.fn().mockResolvedValue({
        audioKey: 'episode.aac',
        audioUrl: 'https://r2.example.com/episode.aac',
        audioDuration: 120,
        audioSize: 1024000,
      }),
      cleanupSegments: vi.fn(),
    };
    const mockBudgetService = {
      calculateCost: vi.fn().mockReturnValue(0.05),
      logUsage: vi.fn().mockResolvedValue(undefined),
    };
    const mockPushoverService = {
      sendProcessingFailed: vi.fn(),
    };

    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'fake audio');

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mockBudgetService as any,
      mockPushoverService as any,
      mockFetchHtml,
      mockExtractContent,
      mockTranscriber as any,
      mockTTSProcessor as any,
      mockAudioMerger as any,
      { minContentLength: 500, maxRetries: 3 }
    );

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
    const result = await pipeline.processEntry(entry);

    expect(result.success).toBe(true);
    expect(mockTranscriber.extractContentWithLLM).toHaveBeenCalled();
    expect(mockBudgetService.logUsage).toHaveBeenCalledTimes(3); // extraction + transcript + TTS
  });
});
