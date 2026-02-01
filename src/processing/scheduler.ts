// src/processing/scheduler.ts
import cron from 'node-cron';
import { readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';
import type Database from 'better-sqlite3';
import type { Entry } from '../types/index.js';
import type { BudgetService } from '../services/budget.js';
import type { PushoverService } from '../services/pushover.js';

const LOCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface SchedulerConfig {
  cronSchedule: string;
  cleanupSchedule: string;
  tempDir: string;
  retentionDays: number;
  budgetWarningPercent: number;
}

export interface SchedulerDependencies {
  db: Database.Database;
  budgetService: BudgetService;
  pushoverService: PushoverService;
  processEntry: (entry: Entry) => Promise<{ success: boolean; entryId: string; error?: string }>;
}

export function createScheduler(deps: SchedulerDependencies, config: SchedulerConfig) {
  const { db, budgetService, pushoverService, processEntry } = deps;
  let previousBudgetStatus: 'ok' | 'warning' | 'exceeded' = 'ok';

  function acquireLock(): boolean {
    const now = new Date().toISOString();
    const lockRow = db.prepare('SELECT * FROM processing_lock WHERE id = 1').get() as {
      locked_at: string | null;
      locked_by: string | null;
    } | undefined;

    if (lockRow?.locked_at) {
      const lockAge = Date.now() - new Date(lockRow.locked_at).getTime();
      if (lockAge < LOCK_TIMEOUT_MS) {
        console.log('Processing already in progress, skipping');
        return false;
      }
      console.log('Stale lock detected, taking over');
    }

    db.prepare('UPDATE processing_lock SET locked_at = ?, locked_by = ? WHERE id = 1')
      .run(now, hostname());

    return true;
  }

  function releaseLock(): void {
    db.prepare('UPDATE processing_lock SET locked_at = NULL, locked_by = NULL WHERE id = 1').run();
  }

  async function runProcessingJob(): Promise<void> {
    if (!acquireLock()) {
      return;
    }

    try {
      // Check budget status and send warnings
      const status = await budgetService.getStatus();

      if (status.status === 'warning' && previousBudgetStatus === 'ok') {
        await pushoverService.sendBudgetWarning(
          status.percent_used,
          status.spent_usd,
          status.budget_usd
        );
      } else if (status.status === 'exceeded' && previousBudgetStatus !== 'exceeded') {
        await pushoverService.sendBudgetExceeded(status.spent_usd, status.budget_usd);
      }
      previousBudgetStatus = status.status;

      if (!status.processing_enabled) {
        console.log('Budget exceeded, skipping processing');
        return;
      }

      // Get pending entries
      const now = new Date().toISOString();
      const entries = db.prepare(
        `SELECT * FROM entries
         WHERE status = 'pending'
         OR (status = 'failed' AND retry_count < 5 AND (next_retry_at IS NULL OR next_retry_at <= ?))
         ORDER BY created_at ASC`
      ).all(now) as Record<string, unknown>[];

      console.log(`Found ${entries.length} entries to process`);

      for (const row of entries) {
        // Check budget before each entry
        if (!(await budgetService.canProcess())) {
          console.log('Budget exceeded mid-batch, stopping');
          break;
        }

        const entry: Entry = {
          id: row.id as string,
          url: row.url as string,
          category: row.category as string | null,
          status: row.status as Entry['status'],
          title: row.title as string | null,
          extractedContent: row.extracted_content as string | null,
          transcriptJson: row.transcript_json as string | null,
          errorMessage: row.error_message as string | null,
          retryCount: row.retry_count as number,
          nextRetryAt: row.next_retry_at as string | null,
          createdAt: row.created_at as string,
          processedAt: row.processed_at as string | null,
        };

        console.log(`Processing entry ${entry.id}: ${entry.url}`);
        const result = await processEntry(entry);

        if (result.success) {
          console.log(`Successfully processed entry ${entry.id}`);
        } else {
          console.error(`Failed to process entry ${entry.id}: ${result.error}`);
        }
      }
    } finally {
      releaseLock();
    }
  }

  async function runCleanupJob(): Promise<void> {
    console.log('Running cleanup job');

    // Delete old episodes from database
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - config.retentionDays);

    const deleted = db.prepare('DELETE FROM episodes WHERE published_at < ?')
      .run(cutoffDate.toISOString());

    console.log(`Deleted ${deleted.changes} old episodes`);

    // Reset stuck processing entries
    const resetResult = db.prepare(
      "UPDATE entries SET status = 'pending' WHERE status = 'processing'"
    ).run();

    if (resetResult.changes > 0) {
      console.log(`Reset ${resetResult.changes} stuck entries`);
    }

    // Clean orphaned temp files older than 24 hours
    try {
      const files = readdirSync(config.tempDir);
      const cutoffTime = Date.now() - 24 * 60 * 60 * 1000;

      for (const file of files) {
        const filePath = join(config.tempDir, file);
        const stat = statSync(filePath);

        if (stat.mtimeMs < cutoffTime) {
          unlinkSync(filePath);
          console.log(`Deleted orphaned temp file: ${file}`);
        }
      }
    } catch (error) {
      // Ignore if temp dir doesn't exist
    }
  }

  function start(): void {
    console.log(`Scheduling processing job: ${config.cronSchedule}`);
    cron.schedule(config.cronSchedule, () => {
      runProcessingJob().catch(console.error);
    });

    console.log(`Scheduling cleanup job: ${config.cleanupSchedule}`);
    cron.schedule(config.cleanupSchedule, () => {
      runCleanupJob().catch(console.error);
    });
  }

  return {
    start,
    runProcessingJob,
    runCleanupJob,
  };
}
