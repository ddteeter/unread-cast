// tests/processing/scheduler.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { initializeSchema } from '../../src/db/schema.js';
import { v4 as uuidv4 } from 'uuid';
import { createScheduler } from '../../src/processing/scheduler.js';
import type { Entry } from '../../src/types/index.js';

// Mock node-cron
vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((_schedule: string, _callback: () => void) => {
      return { start: vi.fn(), stop: vi.fn() };
    }),
  },
}));

describe('scheduler', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initializeSchema(db);
    // Note: processing_lock is automatically initialized by schema
  });

  afterEach(() => {
    db.close();
  });

  describe('lock management', () => {
    it('should fail to acquire lock when lock row does not exist', async () => {
      // Delete the lock row
      db.prepare('DELETE FROM processing_lock WHERE id = 1').run();

      const mockProcessEntry = vi.fn();
      const mockBudgetService = { getStatus: vi.fn(), canProcess: vi.fn() };
      const mockPushoverService = { sendBudgetWarning: vi.fn(), sendBudgetExceeded: vi.fn() };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should not process anything
      expect(mockBudgetService.getStatus).not.toHaveBeenCalled();
      expect(mockProcessEntry).not.toHaveBeenCalled();

      // Re-initialize lock row for other tests
      db.prepare('INSERT INTO processing_lock (id) VALUES (1)').run();
    });

    it('should acquire lock when available', async () => {
      const mockProcessEntry = vi.fn().mockResolvedValue({ success: true, entryId: 'test-id' });
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'ok',
          processing_enabled: true,
          percent_used: 50,
          spent_usd: 5,
          budget_usd: 10,
        }),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Lock should be acquired and released
      const lock = db.prepare('SELECT * FROM processing_lock WHERE id = 1').get() as any;
      expect(lock.locked_at).toBeNull();
      expect(lock.locked_by).toBeNull();
    });

    it('should not process when lock is held', async () => {
      // Set lock to be held
      const now = new Date().toISOString();
      db.prepare('UPDATE processing_lock SET locked_at = ?, locked_by = ? WHERE id = 1').run(
        now,
        'test-host'
      );

      const mockProcessEntry = vi.fn();
      const mockBudgetService = {
        getStatus: vi.fn(),
        canProcess: vi.fn(),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should not have called budget service or processEntry
      expect(mockBudgetService.getStatus).not.toHaveBeenCalled();
      expect(mockProcessEntry).not.toHaveBeenCalled();

      // Lock should still be held
      const lock = db.prepare('SELECT * FROM processing_lock WHERE id = 1').get() as any;
      expect(lock.locked_at).toBe(now);
      expect(lock.locked_by).toBe('test-host');
    });

    it('should take over stale lock (older than 30 minutes)', async () => {
      // Set lock to be stale (31 minutes ago)
      const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
      db.prepare('UPDATE processing_lock SET locked_at = ?, locked_by = ? WHERE id = 1').run(
        staleTime,
        'old-host'
      );

      const mockProcessEntry = vi.fn().mockResolvedValue({ success: true, entryId: 'test-id' });
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'ok',
          processing_enabled: true,
        }),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should have taken over the lock and processed
      expect(mockBudgetService.getStatus).toHaveBeenCalled();

      // Lock should be released after processing
      const lock = db.prepare('SELECT * FROM processing_lock WHERE id = 1').get() as any;
      expect(lock.locked_at).toBeNull();
      expect(lock.locked_by).toBeNull();
    });
  });

  describe('entry selection and processing', () => {
    it('should select and process pending entries', async () => {
      // Create pending entry
      const entryId = uuidv4();
      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(entryId, 'https://example.com/article', 'default', 'pending', new Date().toISOString());

      const mockProcessEntry = vi.fn().mockResolvedValue({ success: true, entryId });
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'ok',
          processing_enabled: true,
        }),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should have processed the entry
      expect(mockProcessEntry).toHaveBeenCalledTimes(1);
      expect(mockProcessEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          id: entryId,
          url: 'https://example.com/article',
          status: 'pending',
        })
      );
    });

    it('should select failed entries eligible for retry', async () => {
      // Create failed entry with retry scheduled for the past
      const entryId = uuidv4();
      const pastTime = new Date(Date.now() - 60 * 1000).toISOString(); // 1 minute ago
      db.prepare(
        `INSERT INTO entries (id, url, category, status, retry_count, next_retry_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entryId,
        'https://example.com/article',
        'default',
        'failed',
        1,
        pastTime,
        new Date().toISOString()
      );

      const mockProcessEntry = vi.fn().mockResolvedValue({ success: true, entryId });
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'ok',
          processing_enabled: true,
        }),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should have processed the entry
      expect(mockProcessEntry).toHaveBeenCalledTimes(1);
      expect(mockProcessEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          id: entryId,
          status: 'failed',
          retry_count: 1,
        })
      );
    });

    it('should not select failed entries not yet ready for retry', async () => {
      // Create failed entry with retry scheduled for the future
      const entryId = uuidv4();
      const futureTime = new Date(Date.now() + 60 * 1000).toISOString(); // 1 minute from now
      db.prepare(
        `INSERT INTO entries (id, url, category, status, retry_count, next_retry_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        entryId,
        'https://example.com/article',
        'default',
        'failed',
        1,
        futureTime,
        new Date().toISOString()
      );

      const mockProcessEntry = vi.fn();
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'ok',
          processing_enabled: true,
        }),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should not have processed any entries
      expect(mockProcessEntry).not.toHaveBeenCalled();
    });

    it('should not select failed entries with max retries reached', async () => {
      // Create failed entry with retry_count >= 5
      const entryId = uuidv4();
      db.prepare(
        `INSERT INTO entries (id, url, category, status, retry_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        entryId,
        'https://example.com/article',
        'default',
        'failed',
        5,
        new Date().toISOString()
      );

      const mockProcessEntry = vi.fn();
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'ok',
          processing_enabled: true,
        }),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should not have processed any entries
      expect(mockProcessEntry).not.toHaveBeenCalled();
    });

    it('should process entries sequentially', async () => {
      // Create multiple pending entries
      const entry1Id = uuidv4();
      const entry2Id = uuidv4();
      const entry3Id = uuidv4();

      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        entry1Id,
        'https://example.com/article1',
        'default',
        'pending',
        new Date().toISOString()
      );

      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        entry2Id,
        'https://example.com/article2',
        'default',
        'pending',
        new Date().toISOString()
      );

      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        entry3Id,
        'https://example.com/article3',
        'default',
        'pending',
        new Date().toISOString()
      );

      const processedOrder: string[] = [];
      const mockProcessEntry = vi.fn().mockImplementation(async (entry: Entry) => {
        processedOrder.push(entry.id);
        return { success: true, entryId: entry.id };
      });

      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'ok',
          processing_enabled: true,
        }),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should have processed all 3 entries in order
      expect(mockProcessEntry).toHaveBeenCalledTimes(3);
      expect(processedOrder).toEqual([entry1Id, entry2Id, entry3Id]);
    });
  });

  describe('budget checking', () => {
    it('should skip processing when budget exceeded', async () => {
      const entryId = uuidv4();
      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(entryId, 'https://example.com/article', 'default', 'pending', new Date().toISOString());

      const mockProcessEntry = vi.fn();
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'exceeded',
          processing_enabled: false,
          percent_used: 105,
          spent_usd: 10.5,
          budget_usd: 10,
        }),
        canProcess: vi.fn().mockResolvedValue(false),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should not have processed any entries
      expect(mockProcessEntry).not.toHaveBeenCalled();
    });

    it('should stop processing mid-batch when budget exceeded', async () => {
      // Create multiple pending entries
      const entry1Id = uuidv4();
      const entry2Id = uuidv4();
      const entry3Id = uuidv4();

      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        entry1Id,
        'https://example.com/article1',
        'default',
        'pending',
        new Date().toISOString()
      );

      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        entry2Id,
        'https://example.com/article2',
        'default',
        'pending',
        new Date().toISOString()
      );

      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        entry3Id,
        'https://example.com/article3',
        'default',
        'pending',
        new Date().toISOString()
      );

      const mockProcessEntry = vi.fn().mockResolvedValue({ success: true, entryId: 'test' });

      // Budget is OK initially but exceeded after first entry
      let callCount = 0;
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'ok',
          processing_enabled: true,
        }),
        canProcess: vi.fn().mockImplementation(async () => {
          callCount++;
          return callCount === 1; // First call returns true, second returns false
        }),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should have processed only 1 entry (stopped when budget exceeded)
      expect(mockProcessEntry).toHaveBeenCalledTimes(1);
      expect(mockBudgetService.canProcess).toHaveBeenCalledTimes(2); // Once for first entry, once for second
    });

    it('should send budget warning notification when threshold crossed', async () => {
      const mockProcessEntry = vi.fn();
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'warning',
          processing_enabled: true,
          percent_used: 85,
          spent_usd: 8.5,
          budget_usd: 10,
        }),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should have sent warning notification
      expect(mockPushoverService.sendBudgetWarning).toHaveBeenCalledWith(85, 8.5, 10);
      expect(mockPushoverService.sendBudgetExceeded).not.toHaveBeenCalled();
    });

    it('should send budget exceeded notification when budget exceeded', async () => {
      const mockProcessEntry = vi.fn();
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'exceeded',
          processing_enabled: false,
          percent_used: 105,
          spent_usd: 10.5,
          budget_usd: 10,
        }),
        canProcess: vi.fn().mockResolvedValue(false),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should have sent exceeded notification
      expect(mockPushoverService.sendBudgetExceeded).toHaveBeenCalledWith(10.5, 10);
      expect(mockPushoverService.sendBudgetWarning).not.toHaveBeenCalled();
    });

    it('should handle budget service errors gracefully', async () => {
      const mockProcessEntry = vi.fn();
      const mockBudgetService = {
        getStatus: vi.fn().mockRejectedValue(new Error('Budget service unavailable')),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should not crash, should continue processing
      expect(mockBudgetService.getStatus).toHaveBeenCalled();
      expect(mockPushoverService.sendBudgetWarning).not.toHaveBeenCalled();
      expect(mockPushoverService.sendBudgetExceeded).not.toHaveBeenCalled();
    });

    it('should handle pushover notification failures gracefully', async () => {
      const mockProcessEntry = vi.fn();
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'warning',
          processing_enabled: true,
          percent_used: 85,
          spent_usd: 8.5,
          budget_usd: 10,
        }),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockRejectedValue(new Error('Pushover API failed')),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runProcessingJob();

      // Should not crash despite notification failure
      expect(mockPushoverService.sendBudgetWarning).toHaveBeenCalled();
      expect(mockBudgetService.getStatus).toHaveBeenCalled();
    });

    it('should only send budget notifications on status transitions', async () => {
      const mockProcessEntry = vi.fn();
      const mockBudgetService = {
        getStatus: vi.fn().mockResolvedValue({
          status: 'warning',
          processing_enabled: true,
          percent_used: 85,
          spent_usd: 8.5,
          budget_usd: 10,
        }),
        canProcess: vi.fn().mockResolvedValue(true),
      };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      // First run - should send notification
      await scheduler.runProcessingJob();
      expect(mockPushoverService.sendBudgetWarning).toHaveBeenCalledTimes(1);

      // Second run - should NOT send notification again (still in warning state)
      await scheduler.runProcessingJob();
      expect(mockPushoverService.sendBudgetWarning).toHaveBeenCalledTimes(1); // Still 1
    });
  });

  describe('cleanup job', () => {
    it('should delete old episodes', async () => {
      // Create entry for foreign key constraint
      const entryId = uuidv4();
      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        entryId,
        'https://example.com/article',
        'default',
        'completed',
        new Date().toISOString()
      );

      // Create old episode (91 days ago)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 91);

      db.prepare(
        `INSERT INTO episodes (id, entry_id, title, audio_key, audio_duration, audio_size, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(uuidv4(), entryId, 'Old Episode', 'old.aac', 120, 1024, oldDate.toISOString());

      // Create recent episode (30 days ago)
      const recentDate = new Date();
      recentDate.setDate(recentDate.getDate() - 30);

      db.prepare(
        `INSERT INTO episodes (id, entry_id, title, audio_key, audio_duration, audio_size, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(uuidv4(), entryId, 'Recent Episode', 'recent.aac', 120, 1024, recentDate.toISOString());

      const mockProcessEntry = vi.fn();
      const mockBudgetService = { getStatus: vi.fn(), canProcess: vi.fn() };
      const mockPushoverService = { sendBudgetWarning: vi.fn(), sendBudgetExceeded: vi.fn() };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runCleanupJob();

      // Should have deleted old episode but kept recent one
      const episodes = db.prepare('SELECT * FROM episodes').all();
      expect(episodes).toHaveLength(1);
      expect((episodes[0] as any).title).toBe('Recent Episode');
    });

    it('should skip stuck entry reset when processing job is running', async () => {
      // Create stuck entry
      const entryId = uuidv4();
      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        entryId,
        'https://example.com/article',
        'default',
        'processing',
        new Date().toISOString()
      );

      // Acquire lock to simulate processing job running
      const now = new Date().toISOString();
      db.prepare('UPDATE processing_lock SET locked_at = ?, locked_by = ? WHERE id = 1').run(
        now,
        'test-host'
      );

      const mockProcessEntry = vi.fn();
      const mockBudgetService = { getStatus: vi.fn(), canProcess: vi.fn() };
      const mockPushoverService = {
        sendBudgetWarning: vi.fn().mockResolvedValue(undefined),
        sendBudgetExceeded: vi.fn().mockResolvedValue(undefined),
      };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runCleanupJob();

      // Should NOT have reset entry (lock is held)
      const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
      expect(entry.status).toBe('processing'); // Still processing

      // Release lock for other tests
      db.prepare(
        'UPDATE processing_lock SET locked_at = NULL, locked_by = NULL WHERE id = 1'
      ).run();
    });

    it('should reset stuck processing entries', async () => {
      // Create stuck entry
      const entryId = uuidv4();
      db.prepare(
        `INSERT INTO entries (id, url, category, status, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        entryId,
        'https://example.com/article',
        'default',
        'processing',
        new Date().toISOString()
      );

      const mockProcessEntry = vi.fn();
      const mockBudgetService = { getStatus: vi.fn(), canProcess: vi.fn() };
      const mockPushoverService = { sendBudgetWarning: vi.fn(), sendBudgetExceeded: vi.fn() };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      await scheduler.runCleanupJob();

      // Should have reset entry to pending
      const entry = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as any;
      expect(entry.status).toBe('pending');
    });
  });

  describe('cron scheduling', () => {
    it('should schedule both processing and cleanup jobs', async () => {
      const cron = await import('node-cron');
      const scheduleSpy = vi.spyOn(cron.default, 'schedule');

      const mockProcessEntry = vi.fn();
      const mockBudgetService = { getStatus: vi.fn(), canProcess: vi.fn() };
      const mockPushoverService = { sendBudgetWarning: vi.fn(), sendBudgetExceeded: vi.fn() };

      const scheduler = createScheduler(
        {
          db,
          budgetService: mockBudgetService as any,
          pushoverService: mockPushoverService as any,
          processEntry: mockProcessEntry,
        },
        {
          cronSchedule: '0 */6 * * *',
          cleanupSchedule: '0 0 * * *',
          tempDir: '/tmp',
          retentionDays: 90,
          budgetWarningPercent: 80,
        }
      );

      scheduler.start();

      // Should have scheduled both jobs
      expect(scheduleSpy).toHaveBeenCalledTimes(2);
      expect(scheduleSpy).toHaveBeenCalledWith('0 */6 * * *', expect.any(Function));
      expect(scheduleSpy).toHaveBeenCalledWith('0 0 * * *', expect.any(Function));
    });
  });
});
