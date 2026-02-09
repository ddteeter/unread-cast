// tests/processing/pipeline-resume.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { v4 as uuidv4 } from 'uuid';
import type { Entry } from '../../src/types/index.js';

describe('pipeline resume capability', () => {
  let tempDir: string;
  let db: Database.Database;
  let entryId: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'unread-cast-test-'));
    db = new Database(':memory:');
    initializeSchema(db);

    // Create pricing config
    writeFileSync(
      join(tempDir, 'pricing.json'),
      JSON.stringify({
        openai: {
          'gpt-4o': { input_per_1m: 2.5, output_per_1m: 10.0 },
          'gpt-4o-mini-tts': { chars_per_1m: 15.0 },
        },
        anthropic: {
          'claude-sonnet-4-5-20250929': { input_per_1m: 3.0, output_per_1m: 15.0 },
        },
      })
    );

    // Create default category
    db.prepare('INSERT INTO categories (name, feed_id, created_at) VALUES (?, ?, ?)').run(
      'default',
      uuidv4(),
      new Date().toISOString()
    );

    // Create test entry with resume fields
    entryId = uuidv4();
    db.prepare(
      `INSERT INTO entries (id, url, category, status, title, created_at, force_reprocess, expected_segment_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      entryId,
      'https://example.com/article',
      'default',
      'failed',
      null,
      new Date().toISOString(),
      0,
      null
    );
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function createMockServices() {
    return {
      fetchHtml: vi.fn().mockResolvedValue('<html><body>Article content</body></html>'),
      extractContent: vi.fn().mockResolvedValue({
        title: 'Test Article',
        content: 'This is a long enough article content that should pass validation. '.repeat(50),
      }),
      transcriber: {
        generateTranscript: vi.fn().mockResolvedValue({
          transcript: [
            {
              speaker: 'NARRATOR',
              text: 'Welcome to the podcast',
              instruction: 'Clear and engaging',
            },
            {
              speaker: 'NARRATOR',
              text: 'This is the main content',
              instruction: 'Clear and engaging',
            },
          ],
          usage: { inputTokens: 1000, outputTokens: 500 },
          provider: 'anthropic' as const,
          model: 'claude-sonnet-4-5-20250929',
        }),
        extractContentWithLLM: vi.fn().mockResolvedValue({
          content: 'Extracted content. '.repeat(50),
          usage: { inputTokens: 500, outputTokens: 200 },
          provider: 'anthropic' as const,
          model: 'claude-sonnet-4-5-20250929',
        }),
      },
      ttsProcessor: {
        processTranscript: vi.fn().mockResolvedValue({
          segmentFiles: [join(tempDir, `${entryId}_0.aac`), join(tempDir, `${entryId}_1.aac`)],
          totalUsage: { characters: 1000 },
        }),
      },
      audioMerger: {
        mergeAndUpload: vi.fn().mockResolvedValue({
          audioKey: 'episode.aac',
          audioUrl: 'https://r2.example.com/episode.aac',
          audioDuration: 120,
          audioSize: 1024000,
        }),
        cleanupSegments: vi.fn(),
      },
      budgetService: {
        calculateCost: vi.fn().mockReturnValue(0.05),
        logUsage: vi.fn().mockResolvedValue(undefined),
      },
      pushoverService: {
        sendProcessingFailed: vi.fn().mockResolvedValue(undefined),
      },
    };
  }

  it('should resume from TTS when extracted_content and transcript_json exist', async () => {
    const mocks = createMockServices();

    // Setup: entry has extracted content and transcript
    const transcript = [
      { speaker: 'NARRATOR', text: 'Segment 1', instruction: 'Clear' },
      { speaker: 'NARRATOR', text: 'Segment 2', instruction: 'Clear' },
    ];

    db.prepare(
      `UPDATE entries SET
        extracted_content = ?,
        transcript_json = ?,
        title = ?
       WHERE id = ?`
    ).run('Cached content. '.repeat(50), JSON.stringify(transcript), 'Cached Title', entryId);

    // Create segment files
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'fake audio 0');
    writeFileSync(join(tempDir, `${entryId}_1.aac`), 'fake audio 1');

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mocks.budgetService as any,
      mocks.pushoverService as any,
      mocks.fetchHtml,
      mocks.extractContent,
      mocks.transcriber as any,
      mocks.ttsProcessor as any,
      mocks.audioMerger as any,
      {
        minContentLength: 500,
        maxRetries: 3,
        tempDir,
      }
    );

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    const result = await pipeline.processEntry(entry);

    // Should succeed
    expect(result.success).toBe(true);

    // Should NOT call fetch, extract, or transcript generation
    expect(mocks.fetchHtml).not.toHaveBeenCalled();
    expect(mocks.extractContent).not.toHaveBeenCalled();
    expect(mocks.transcriber.generateTranscript).not.toHaveBeenCalled();

    // Should generate TTS (no segments saved yet)
    expect(mocks.ttsProcessor.processTranscript).toHaveBeenCalled();

    // Should log only TTS cost (no LLM costs)
    expect(mocks.budgetService.logUsage).toHaveBeenCalledTimes(1);
    expect(mocks.budgetService.logUsage).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'openai_tts' })
    );
  });

  it('should resume from merge when all segments are valid', async () => {
    const mocks = createMockServices();

    // Setup: entry has everything including segment count
    const transcript = [
      { speaker: 'NARRATOR', text: 'Segment 1', instruction: 'Clear' },
      { speaker: 'NARRATOR', text: 'Segment 2', instruction: 'Clear' },
    ];

    db.prepare(
      `UPDATE entries SET
        extracted_content = ?,
        transcript_json = ?,
        title = ?,
        expected_segment_count = ?
       WHERE id = ?`
    ).run('Cached content. '.repeat(50), JSON.stringify(transcript), 'Cached Title', 2, entryId);

    // Create all expected segment files
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'fake audio 0');
    writeFileSync(join(tempDir, `${entryId}_1.aac`), 'fake audio 1');

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mocks.budgetService as any,
      mocks.pushoverService as any,
      mocks.fetchHtml,
      mocks.extractContent,
      mocks.transcriber as any,
      mocks.ttsProcessor as any,
      mocks.audioMerger as any,
      {
        minContentLength: 500,
        maxRetries: 3,
        tempDir,
      }
    );

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    const result = await pipeline.processEntry(entry);

    // Should succeed
    expect(result.success).toBe(true);

    // Should NOT call ANY expensive operations
    expect(mocks.fetchHtml).not.toHaveBeenCalled();
    expect(mocks.extractContent).not.toHaveBeenCalled();
    expect(mocks.transcriber.generateTranscript).not.toHaveBeenCalled();
    expect(mocks.ttsProcessor.processTranscript).not.toHaveBeenCalled();

    // Should ONLY call merge
    expect(mocks.audioMerger.mergeAndUpload).toHaveBeenCalled();

    // Should NOT log any usage (no LLM or TTS calls)
    expect(mocks.budgetService.logUsage).not.toHaveBeenCalled();
  });

  it('should regenerate TTS when segments are incomplete', async () => {
    const mocks = createMockServices();

    // Setup: entry has transcript and expected 2 segments, but only 1 exists
    const transcript = [
      { speaker: 'NARRATOR', text: 'Segment 1', instruction: 'Clear' },
      { speaker: 'NARRATOR', text: 'Segment 2', instruction: 'Clear' },
    ];

    db.prepare(
      `UPDATE entries SET
        extracted_content = ?,
        transcript_json = ?,
        title = ?,
        expected_segment_count = ?
       WHERE id = ?`
    ).run('Cached content. '.repeat(50), JSON.stringify(transcript), 'Cached Title', 2, entryId);

    // Create only one segment (missing segment 1) - validation will fail
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'fake audio 0');
    // Intentionally NOT creating ${entryId}_1.aac

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mocks.budgetService as any,
      mocks.pushoverService as any,
      mocks.fetchHtml,
      mocks.extractContent,
      mocks.transcriber as any,
      mocks.ttsProcessor as any,
      mocks.audioMerger as any,
      {
        minContentLength: 500,
        maxRetries: 3,
        tempDir,
      }
    );

    // The mock TTS processor will return new segment files
    // These need to exist for the merge step to work
    mocks.ttsProcessor.processTranscript = vi.fn().mockImplementation(async () => {
      // Create the segment files as part of the mock
      writeFileSync(join(tempDir, `${entryId}_0.aac`), 'new audio 0');
      writeFileSync(join(tempDir, `${entryId}_1.aac`), 'new audio 1');
      return {
        segmentFiles: [join(tempDir, `${entryId}_0.aac`), join(tempDir, `${entryId}_1.aac`)],
        totalUsage: { characters: 1000 },
      };
    });

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    const result = await pipeline.processEntry(entry);

    // Should succeed
    expect(result.success).toBe(true);

    // Should NOT call fetch, extract, transcript
    expect(mocks.fetchHtml).not.toHaveBeenCalled();
    expect(mocks.extractContent).not.toHaveBeenCalled();
    expect(mocks.transcriber.generateTranscript).not.toHaveBeenCalled();

    // Should regenerate TTS
    expect(mocks.ttsProcessor.processTranscript).toHaveBeenCalled();

    // Should log TTS cost
    expect(mocks.budgetService.logUsage).toHaveBeenCalledTimes(1);
    expect(mocks.budgetService.logUsage).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'openai_tts' })
    );
  });

  it('should run full pipeline when force_reprocess is set', async () => {
    const mocks = createMockServices();

    // Setup: entry has cached data BUT force_reprocess is enabled
    const transcript = [{ speaker: 'NARRATOR', text: 'Old transcript', instruction: 'Clear' }];

    db.prepare(
      `UPDATE entries SET
        extracted_content = ?,
        transcript_json = ?,
        title = ?,
        expected_segment_count = ?,
        force_reprocess = ?
       WHERE id = ?`
    ).run('Old content. '.repeat(50), JSON.stringify(transcript), 'Old Title', 1, 1, entryId);

    // Create old segment
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'old audio');

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mocks.budgetService as any,
      mocks.pushoverService as any,
      mocks.fetchHtml,
      mocks.extractContent,
      mocks.transcriber as any,
      mocks.ttsProcessor as any,
      mocks.audioMerger as any,
      {
        minContentLength: 500,
        maxRetries: 3,
        tempDir,
      }
    );

    // Create new segment files for TTS mock
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'new audio 0');
    writeFileSync(join(tempDir, `${entryId}_1.aac`), 'new audio 1');

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    const result = await pipeline.processEntry(entry);

    // Should succeed
    expect(result.success).toBe(true);

    // Should call ALL steps (full pipeline)
    expect(mocks.fetchHtml).toHaveBeenCalled();
    expect(mocks.extractContent).toHaveBeenCalled();
    expect(mocks.transcriber.generateTranscript).toHaveBeenCalled();
    expect(mocks.ttsProcessor.processTranscript).toHaveBeenCalled();
    expect(mocks.audioMerger.mergeAndUpload).toHaveBeenCalled();

    // Should log both LLM and TTS costs
    expect(mocks.budgetService.logUsage).toHaveBeenCalledTimes(2);

    // force_reprocess flag should be cleared
    const updatedEntry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    expect(updatedEntry.force_reprocess).toBe(0);

    // Old cached data should be cleared
    const freshEntry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    expect(freshEntry.extracted_content).not.toBe('Old content. '.repeat(50));
    expect(freshEntry.title).toBe('Test Article'); // New title from mock
  });

  it('should handle corrupted transcript JSON gracefully', async () => {
    const mocks = createMockServices();

    // Setup: entry has extracted content but corrupted transcript JSON
    db.prepare(
      `UPDATE entries SET
        extracted_content = ?,
        transcript_json = ?,
        title = ?
       WHERE id = ?`
    ).run(
      'Cached content. '.repeat(50),
      '{"invalid": json}', // Corrupted JSON
      'Cached Title',
      entryId
    );

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mocks.budgetService as any,
      mocks.pushoverService as any,
      mocks.fetchHtml,
      mocks.extractContent,
      mocks.transcriber as any,
      mocks.ttsProcessor as any,
      mocks.audioMerger as any,
      {
        minContentLength: 500,
        maxRetries: 3,
        tempDir,
      }
    );

    // Create segment files for TTS
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'audio 0');
    writeFileSync(join(tempDir, `${entryId}_1.aac`), 'audio 1');

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    const result = await pipeline.processEntry(entry);

    // Should succeed
    expect(result.success).toBe(true);

    // Should NOT call fetch/extract (has cached content)
    expect(mocks.fetchHtml).not.toHaveBeenCalled();
    expect(mocks.extractContent).not.toHaveBeenCalled();

    // Should regenerate transcript due to corruption
    expect(mocks.transcriber.generateTranscript).toHaveBeenCalled();

    // Should also generate TTS
    expect(mocks.ttsProcessor.processTranscript).toHaveBeenCalled();

    // Should log both LLM and TTS costs
    expect(mocks.budgetService.logUsage).toHaveBeenCalledTimes(2);
  });

  it('should run full pipeline for backward compatibility (NULL resume fields)', async () => {
    const mocks = createMockServices();

    // Entry with NULL resume fields (old schema or fresh entry)
    // force_reprocess and expected_segment_count are already NULL by default

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mocks.budgetService as any,
      mocks.pushoverService as any,
      mocks.fetchHtml,
      mocks.extractContent,
      mocks.transcriber as any,
      mocks.ttsProcessor as any,
      mocks.audioMerger as any,
      {
        minContentLength: 500,
        maxRetries: 3,
        tempDir,
      }
    );

    // Create segment files for TTS
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'audio 0');
    writeFileSync(join(tempDir, `${entryId}_1.aac`), 'audio 1');

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    const result = await pipeline.processEntry(entry);

    // Should succeed
    expect(result.success).toBe(true);

    // Should run full pipeline (no cached state)
    expect(mocks.fetchHtml).toHaveBeenCalled();
    expect(mocks.extractContent).toHaveBeenCalled();
    expect(mocks.transcriber.generateTranscript).toHaveBeenCalled();
    expect(mocks.ttsProcessor.processTranscript).toHaveBeenCalled();

    // Should log both costs
    expect(mocks.budgetService.logUsage).toHaveBeenCalledTimes(2);
  });

  it('should resume from transcript when only extracted_content exists', async () => {
    const mocks = createMockServices();

    // Setup: only extracted content, no transcript
    db.prepare(
      `UPDATE entries SET
        extracted_content = ?,
        title = ?
       WHERE id = ?`
    ).run('Cached content. '.repeat(50), 'Cached Title', entryId);

    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mocks.budgetService as any,
      mocks.pushoverService as any,
      mocks.fetchHtml,
      mocks.extractContent,
      mocks.transcriber as any,
      mocks.ttsProcessor as any,
      mocks.audioMerger as any,
      {
        minContentLength: 500,
        maxRetries: 3,
        tempDir,
      }
    );

    // Create segment files for TTS
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'audio 0');
    writeFileSync(join(tempDir, `${entryId}_1.aac`), 'audio 1');

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    const result = await pipeline.processEntry(entry);

    // Should succeed
    expect(result.success).toBe(true);

    // Should NOT call fetch/extract
    expect(mocks.fetchHtml).not.toHaveBeenCalled();
    expect(mocks.extractContent).not.toHaveBeenCalled();

    // Should call transcript generation and TTS
    expect(mocks.transcriber.generateTranscript).toHaveBeenCalled();
    expect(mocks.ttsProcessor.processTranscript).toHaveBeenCalled();

    // Should log both costs
    expect(mocks.budgetService.logUsage).toHaveBeenCalledTimes(2);
  });

  it('should save expected_segment_count after TTS generation', async () => {
    const mocks = createMockServices();

    // Fresh entry, no cached data
    const { createProcessingPipeline } = await import('../../src/processing/pipeline.js');
    const pipeline = createProcessingPipeline(
      db,
      mocks.budgetService as any,
      mocks.pushoverService as any,
      mocks.fetchHtml,
      mocks.extractContent,
      mocks.transcriber as any,
      mocks.ttsProcessor as any,
      mocks.audioMerger as any,
      {
        minContentLength: 500,
        maxRetries: 3,
        tempDir,
      }
    );

    // Create segment files for TTS
    writeFileSync(join(tempDir, `${entryId}_0.aac`), 'audio 0');
    writeFileSync(join(tempDir, `${entryId}_1.aac`), 'audio 1');

    const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    await pipeline.processEntry(entry);

    // Check that expected_segment_count was saved
    const updatedEntry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as Entry;
    expect(updatedEntry.expected_segment_count).toBe(2); // Mock returns 2 segments
  });
});
