// src/services/budget.ts
import { readFileSync, existsSync } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { BudgetStatus, PricingConfig, UsageLog } from '../types/index.js';

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
          console.warn(`Failed to parse pricing config at ${path}:`, error);
          // Continue to next path
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
