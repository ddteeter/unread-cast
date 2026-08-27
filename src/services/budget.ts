// src/services/budget.ts
import { readFileSync, existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { BudgetStatus, PricingConfig, UsageLog } from '../types/index.js';

/**
 * Fallback conversion from characters of speech to billed TTS tokens, used when a
 * pricing entry does not carry its own estimates.
 *
 * Derivation, from OpenAI's published gpt-4o-mini-tts rates:
 *   - ~$12.00 per 1M audio output tokens, and ~$0.015 per minute of generated audio
 *     => $0.015 / ($12 / 1e6) = ~1,250 audio tokens per minute of speech.
 *   - Speech runs ~150 words/min, and English averages ~6 characters per word
 *     including the trailing space => ~900 characters per minute.
 *   - => 1250 / 900 = ~1.39 audio tokens per character.
 *   - Text input tokenises at roughly 4 characters per token => 0.25.
 *
 * Sanity check: a 15-minute episode is ~13,500 characters, which prices at
 * ~$0.225 — matching 15 min x $0.015/min. These are estimates; if OpenAI exposes
 * real usage on the speech endpoint, log that instead.
 */
export const TTS_TOKEN_ESTIMATES = {
  audioTokensPerChar: 1.39,
  textTokensPerChar: 0.25,
} as const;

export interface BudgetService {
  calculateCost(service: string, model: string, inputUnits: number, outputUnits?: number): number;
  logUsage(usage: Omit<UsageLog, 'id' | 'created_at'>): Promise<void>;
  getStatus(): Promise<BudgetStatus>;
  canProcess(): Promise<boolean>;
  loadPricingConfig(): PricingConfig;
}

export function createBudgetService(
  db: Database.Database,
  pricingConfigPath: string,
  monthlyBudgetUsd: number,
  budgetWarningPercent: number = 80
): BudgetService {
  let pricingConfig: PricingConfig | null = null;

  function loadPricingConfig(): PricingConfig {
    if (pricingConfig) return pricingConfig;

    // Try primary path first (user override), then fall back to bundled default
    const pathsToTry = [pricingConfigPath];
    if (pricingConfigPath !== '/app/pricing.json') {
      pathsToTry.push('/app/pricing.json');
    }

    for (const path of pathsToTry) {
      if (existsSync(path)) {
        try {
          const content = readFileSync(path, 'utf-8');
          pricingConfig = JSON.parse(content) as PricingConfig;
          console.log(`Loaded pricing config from ${path}`);
          return pricingConfig;
        } catch (error) {
          // If this is the primary user-specified path, fail immediately
          // Only fall back for bundled defaults
          if (path === pricingConfigPath) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            throw new Error(`Failed to parse pricing config at ${path}: ${errorMsg}`);
          }
          console.warn(`Failed to parse pricing config at ${path}:`, error);
          // Continue to next path only for fallback paths
        }
      }
    }

    const err = new Error(`Failed to load pricing config from any of: ${pathsToTry.join(', ')}`);
    (err as Error & { code: string }).code = 'PRICING_CONFIG_MISSING';
    throw err;
  }

  function calculateCost(
    service: string,
    model: string,
    inputUnits: number,
    outputUnits?: number
  ): number {
    const config = loadPricingConfig();

    if (service === 'openai_chat' || service === 'openai_tts') {
      const modelConfig = config.openai?.[model];
      if (!modelConfig) {
        const err = new Error(`PRICING_CONFIG_MISSING: Model ${model} not found in pricing config`);
        (err as Error & { code: string }).code = 'PRICING_CONFIG_MISSING';
        throw err;
      }

      if (service === 'openai_tts') {
        // Preferred path: model OpenAI's actual token-based TTS billing.
        //
        // The speech endpoint returns raw audio with no usage object, so we cannot
        // read real token counts back. We estimate them from character count using
        // the constants below, which is far closer than the flat per-character rate
        // that preceded this (that under-counted by ~40% and let real spend run past
        // MONTHLY_BUDGET_USD before canProcess() would block anything).
        if (modelConfig.audio_output_per_1m !== undefined) {
          const audioTokens =
            inputUnits *
            (modelConfig.est_audio_tokens_per_char ?? TTS_TOKEN_ESTIMATES.audioTokensPerChar);
          const textTokens =
            inputUnits *
            (modelConfig.est_text_tokens_per_char ?? TTS_TOKEN_ESTIMATES.textTokensPerChar);
          const audioCost = (audioTokens / 1_000_000) * modelConfig.audio_output_per_1m;
          const textCost = (textTokens / 1_000_000) * (modelConfig.text_input_per_1m ?? 0);
          return audioCost + textCost;
        }

        // Legacy flat per-character rate, kept so existing pricing.json files that
        // predate the token fields keep working rather than hard-failing.
        const charsPerMillion = modelConfig.chars_per_1m ?? 0;
        return (inputUnits / 1_000_000) * charsPerMillion;
      } else {
        const inputPerMillion = modelConfig.input_per_1m ?? 0;
        const outputPerMillion = modelConfig.output_per_1m ?? 0;
        const inputCost = (inputUnits / 1_000_000) * inputPerMillion;
        const outputCost = ((outputUnits ?? 0) / 1_000_000) * outputPerMillion;
        return inputCost + outputCost;
      }
    }

    if (service === 'anthropic_chat') {
      const modelConfig = config.anthropic?.[model];
      if (!modelConfig) {
        const err = new Error(`PRICING_CONFIG_MISSING: Model ${model} not found in pricing config`);
        (err as Error & { code: string }).code = 'PRICING_CONFIG_MISSING';
        throw err;
      }
      const inputCost = (inputUnits / 1_000_000) * modelConfig.input_per_1m;
      const outputCost = ((outputUnits ?? 0) / 1_000_000) * modelConfig.output_per_1m;
      return inputCost + outputCost;
    }

    throw new Error(`Unknown service: ${service}`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async function logUsage(usage: Omit<UsageLog, 'id' | 'created_at'>): Promise<void> {
    const id = uuidv4();
    const createdAt = new Date().toISOString();

    db.prepare(
      `INSERT INTO usage_log (id, entry_id, service, model, input_units, output_units, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      usage.entry_id,
      usage.service,
      usage.model,
      usage.input_units,
      usage.output_units,
      usage.cost_usd,
      createdAt
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async function getStatus(): Promise<BudgetStatus> {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const result = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) as total
         FROM usage_log
         WHERE created_at >= ?`
      )
      .get(monthStart.toISOString()) as { total: number };

    const spentUsd = result.total;
    const remainingUsd = Math.max(0, monthlyBudgetUsd - spentUsd);
    const percentUsed = (spentUsd / monthlyBudgetUsd) * 100;

    let status: 'ok' | 'warning' | 'exceeded';
    if (percentUsed >= 100) {
      status = 'exceeded';
    } else if (percentUsed >= budgetWarningPercent) {
      status = 'warning';
    } else {
      status = 'ok';
    }

    return {
      period,
      spent_usd: spentUsd,
      budget_usd: monthlyBudgetUsd,
      remaining_usd: remainingUsd,
      percent_used: percentUsed,
      status,
      processing_enabled: status !== 'exceeded',
    };
  }

  async function canProcess(): Promise<boolean> {
    // First check if pricing config is valid
    try {
      loadPricingConfig();
    } catch {
      return false;
    }

    const status = await getStatus();
    return status.processing_enabled;
  }

  return {
    calculateCost,
    logUsage,
    getStatus,
    canProcess,
    loadPricingConfig,
  };
}
