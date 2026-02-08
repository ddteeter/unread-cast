// src/index.ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { join } from 'path';
import { mkdirSync } from 'fs';

import { config } from './config.js';
import { createDatabase } from './db/client.js';
import { createBudgetService } from './services/budget.js';
import { createPushoverService } from './services/pushover.js';
import { createR2Service } from './services/r2.js';
import { createOpenAIService } from './services/openai.js';
import { createAnthropicService } from './services/anthropic.js';
import { registerRoutes } from './api/routes.js';
import { createTranscriber } from './processing/transcriber.js';
import { createTTSProcessor } from './processing/tts.js';
import { createAudioMerger } from './processing/audio.js';
import { createProcessingPipeline } from './processing/pipeline.js';
import { createScheduler } from './processing/scheduler.js';
import { fetchHtml } from './processing/fetcher.js';
import { extractContent } from './processing/extractor.js';

async function main() {
  // Ensure data directories exist
  const dataDir = config.dataDir;
  const tempDir = join(dataDir, 'temp');
  mkdirSync(tempDir, { recursive: true });

  // Initialize database
  const dbPath = join(dataDir, 'unread-cast.db');
  const db = createDatabase(dbPath);
  console.log(`Database initialized at ${dbPath}`);

  // Initialize services
  const budgetService = createBudgetService(
    db,
    config.pricingConfigPath,
    config.monthlyBudgetUsd,
    config.budgetWarningPercent
  );

  // Validate pricing config at startup
  try {
    budgetService.loadPricingConfig();
    console.log('Pricing config loaded successfully');
  } catch (error) {
    console.error('Failed to load pricing config:', error);
    process.exit(1);
  }

  const pushoverService = createPushoverService(config.pushoverUserKey, config.pushoverAppToken);

  const r2Service = createR2Service({
    accountId: config.r2AccountId,
    accessKeyId: config.r2AccessKeyId,
    secretAccessKey: config.r2SecretAccessKey,
    bucketName: config.r2BucketName,
    publicUrl: config.r2PublicUrl,
  });

  const openaiService = createOpenAIService(
    config.openaiApiKey,
    config.maxTranscriptTokens,
    config.maxExtractionTokens
  );
  const anthropicService = config.anthropicApiKey
    ? createAnthropicService(
        config.anthropicApiKey,
        config.maxTranscriptTokens,
        config.maxExtractionTokens
      )
    : null;

  // Initialize processing components
  const transcriber = createTranscriber(openaiService, anthropicService, {
    provider: config.llmProvider,
    model: config.llmModel,
    minContentLength: config.minContentLength,
  });

  const ttsProcessor = createTTSProcessor(openaiService, {
    voices: config.ttsVoices,
    tempDir,
  });

  const audioMerger = createAudioMerger(r2Service, tempDir);

  const pipeline = createProcessingPipeline(
    db,
    budgetService,
    pushoverService,
    fetchHtml,
    extractContent,
    transcriber,
    ttsProcessor,
    audioMerger,
    {
      minContentLength: config.minContentLength,
      maxRetries: config.maxRetries,
    }
  );

  // Initialize scheduler
  const scheduler = createScheduler(
    {
      db,
      budgetService,
      pushoverService,
      processEntry: (entry) => pipeline.processEntry(entry),
    },
    {
      cronSchedule: config.cronSchedule,
      cleanupSchedule: '0 0 * * *', // Daily at midnight
      tempDir,
      retentionDays: config.retentionDays,
      budgetWarningPercent: config.budgetWarningPercent,
      maxRetries: config.maxRetries,
    }
  );

  // Initialize Fastify
  const app = Fastify({ logger: true });
  await app.register(cors);

  // Register routes
  registerRoutes(app, db, budgetService, {
    apiKey: config.apiKey,
    feedConfig: {
      baseUrl: config.baseUrl,
      feedTitle: config.feedTitle,
      feedAuthor: config.feedAuthor,
      feedDescription: config.feedDescription,
      artworkUrl: config.artworkUrl,
      r2PublicUrl: config.r2PublicUrl,
    },
    triggerProcessing: scheduler.runProcessingJob,
    maxRetries: config.maxRetries,
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    console.log(`Received ${signal}, starting graceful shutdown...`);

    try {
      // Stop accepting new requests
      await app.close();
      console.log('HTTP server closed');

      // Note: node-cron doesn't have a built-in stop method that prevents new triggers
      // The scheduler will naturally stop when the process exits

      // Close database connection
      db.close();
      console.log('Database connection closed');

      console.log('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      console.error('Error during shutdown:', error);
      process.exit(1);
    }
  };

  // Register signal handlers
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Start server
  await app.listen({ port: config.port, host: '0.0.0.0' });
  console.log(`Server running on port ${config.port}`);

  // Start scheduler after server is ready
  scheduler.start();
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
