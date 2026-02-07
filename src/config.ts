// src/config.ts
import { z } from 'zod';

const configSchema = z.object({
  // Required
  apiKey: z.string().min(1, 'API_KEY environment variable is required'),
  baseUrl: z.string().url('BASE_URL must be a valid URL'),
  openaiApiKey: z.string().min(1, 'OPENAI_API_KEY environment variable is required'),
  r2AccountId: z.string().min(1, 'R2_ACCOUNT_ID environment variable is required'),
  r2AccessKeyId: z.string().min(1, 'R2_ACCESS_KEY_ID environment variable is required'),
  r2SecretAccessKey: z.string().min(1, 'R2_SECRET_ACCESS_KEY environment variable is required'),
  r2BucketName: z.string().min(1, 'R2_BUCKET_NAME environment variable is required'),
  r2PublicUrl: z.string().url('R2_PUBLIC_URL must be a valid URL'),
  monthlyBudgetUsd: z.number().positive('MONTHLY_BUDGET_USD must be a positive number'),

  // Optional with defaults
  port: z.number().default(8080),
  cronSchedule: z.string().default('0 */6 * * *'),
  anthropicApiKey: z.string().optional(),
  llmProvider: z.enum(['openai', 'anthropic']).default('anthropic'),
  llmModel: z.string().default('claude-sonnet-4-5-20250929'),
  ttsVoices: z
    .array(z.string())
    .default([
      'alloy',
      'ash',
      'ballad',
      'coral',
      'echo',
      'fable',
      'nova',
      'onyx',
      'sage',
      'shimmer',
      'verse',
    ]),
  feedTitle: z.string().default('Unread Cast'),
  feedAuthor: z.string().default('Unread Cast'),
  feedDescription: z.string().default('Auto-generated podcasts from articles'),
  artworkUrl: z.string().url().optional(),
  retentionDays: z.number().default(90),
  minContentLength: z.number().default(500),
  pricingConfigPath: z.string().default('/data/pricing.json'),
  pushoverUserKey: z.string().optional(),
  pushoverAppToken: z.string().optional(),
  budgetWarningPercent: z.number().default(80),
  dataDir: z.string().default('/data'),

  // Token limits for LLM API calls
  maxTranscriptTokens: z.number().default(16000), // ~hour of podcast content
  maxExtractionTokens: z.number().default(8000), // long articles
});

export type Config = z.infer<typeof configSchema>;

function parseEnv(): Config {
  const raw = {
    apiKey: process.env.API_KEY,
    baseUrl: process.env.BASE_URL,
    openaiApiKey: process.env.OPENAI_API_KEY,
    r2AccountId: process.env.R2_ACCOUNT_ID,
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID,
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    r2BucketName: process.env.R2_BUCKET_NAME,
    r2PublicUrl: process.env.R2_PUBLIC_URL,
    monthlyBudgetUsd: process.env.MONTHLY_BUDGET_USD
      ? parseFloat(process.env.MONTHLY_BUDGET_USD)
      : undefined,
    port: process.env.PORT ? parseInt(process.env.PORT, 10) : undefined,
    cronSchedule: process.env.CRON_SCHEDULE,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    llmProvider: process.env.LLM_PROVIDER as 'openai' | 'anthropic' | undefined,
    llmModel: process.env.LLM_MODEL,
    ttsVoices: process.env.TTS_VOICES?.split(',').map((v) => v.trim()),
    feedTitle: process.env.FEED_TITLE,
    feedAuthor: process.env.FEED_AUTHOR,
    feedDescription: process.env.FEED_DESCRIPTION,
    artworkUrl: process.env.ARTWORK_URL,
    retentionDays: process.env.RETENTION_DAYS
      ? parseInt(process.env.RETENTION_DAYS, 10)
      : undefined,
    minContentLength: process.env.MIN_CONTENT_LENGTH
      ? parseInt(process.env.MIN_CONTENT_LENGTH, 10)
      : undefined,
    pricingConfigPath: process.env.PRICING_CONFIG_PATH,
    pushoverUserKey: process.env.PUSHOVER_USER_KEY,
    pushoverAppToken: process.env.PUSHOVER_APP_TOKEN,
    budgetWarningPercent: process.env.BUDGET_WARNING_PERCENT
      ? parseInt(process.env.BUDGET_WARNING_PERCENT, 10)
      : undefined,
    dataDir: process.env.DATA_DIR,
    maxTranscriptTokens: process.env.MAX_TRANSCRIPT_TOKENS
      ? parseInt(process.env.MAX_TRANSCRIPT_TOKENS, 10)
      : undefined,
    maxExtractionTokens: process.env.MAX_EXTRACTION_TOKENS
      ? parseInt(process.env.MAX_EXTRACTION_TOKENS, 10)
      : undefined,
  };

  try {
    return configSchema.parse(raw);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.issues.map((err) => {
        const path = err.path.join('.');
        return `  - ${path}: ${err.message}`;
      });
      throw new Error(
        `Configuration validation failed:\n${messages.join('\n')}\n\nPlease check your environment variables and .env file.`
      );
    }
    throw error;
  }
}

export const config = parseEnv();
