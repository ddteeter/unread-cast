// src/api/routes.ts
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { createAuthHook, isPublicPath } from './middleware.js';
import { createEntryHandlers, type CreateEntryInput } from './entries.js';
import { createFeedHandlers, type FeedConfig } from './feeds.js';
import type { BudgetService } from '../services/budget.js';

export interface RouteConfig {
  apiKey: string;
  feedConfig: FeedConfig;
}

export function registerRoutes(
  app: FastifyInstance,
  db: Database.Database,
  budgetService: BudgetService,
  config: RouteConfig
): void {
  const entryHandlers = createEntryHandlers(db);
  const feedHandlers = createFeedHandlers(db, config.feedConfig);
  const authHook = createAuthHook(config.apiKey);

  // Apply auth to non-public routes
  app.addHook('preHandler', (request, reply, done) => {
    if (isPublicPath(request.url)) {
      done();
      return;
    }
    authHook(request, reply, done);
  });

  // Health check
  app.get('/health', async () => {
    return {
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };
  });

  // Budget endpoint
  app.get('/budget', async () => {
    return budgetService.getStatus();
  });

  // Create entry
  app.post<{ Body: CreateEntryInput }>('/entries', async (request, reply) => {
    try {
      const entry = await entryHandlers.createEntry(request.body);
      reply.status(201);
      return entry;
    } catch (error) {
      const err = error as Error & { code?: string };
      if (err.code === 'INVALID_URL') {
        reply.status(400);
        return { error: 'Bad Request', message: err.message, code: 'INVALID_URL' };
      }
      if (err.code === 'DUPLICATE_URL') {
        reply.status(409);
        return { error: 'Conflict', message: err.message, code: 'DUPLICATE_URL' };
      }
      throw error;
    }
  });

  // Trigger processing
  app.post('/process', async (request, reply) => {
    const canProcess = await budgetService.canProcess();
    if (!canProcess) {
      const status = await budgetService.getStatus();
      reply.status(503);
      return {
        error: 'Service Unavailable',
        message:
          status.status === 'exceeded'
            ? 'Budget exceeded'
            : 'Pricing config missing or invalid',
        code: status.status === 'exceeded' ? 'BUDGET_EXCEEDED' : 'PRICING_CONFIG_MISSING',
      };
    }

    // Count pending entries
    const result = db
      .prepare(
        `SELECT COUNT(*) as count FROM entries
         WHERE status = 'pending'
         OR (status = 'failed' AND retry_count < 5 AND (next_retry_at IS NULL OR next_retry_at <= ?))`
      )
      .get(new Date().toISOString()) as { count: number };

    // Note: Actual processing is triggered via scheduler
    // This endpoint just reports what would be processed
    reply.status(202);
    return {
      message: 'Processing started',
      pendingCount: result.count,
    };
  });

  // List feeds
  app.get('/feeds', async () => {
    const feeds = await feedHandlers.listFeeds();
    return { feeds };
  });

  // Get feed XML
  app.get<{ Params: { feedId: string } }>('/feed/:feedId.xml', async (request, reply) => {
    try {
      const xml = await feedHandlers.getFeedXml(request.params.feedId);
      reply.header('Content-Type', 'application/rss+xml');
      return xml;
    } catch (error) {
      reply.status(404);
      return { error: 'Not Found', message: 'Feed not found', code: 'NOT_FOUND' };
    }
  });
}
