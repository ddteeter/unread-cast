// src/types/index.ts

export interface Entry {
  id: string;
  url: string;
  category: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  title: string | null;
  extractedContent: string | null;
  transcriptJson: string | null;
  errorMessage: string | null;
  retryCount: number;
  nextRetryAt: string | null;
  createdAt: string;
  processedAt: string | null;
}

export interface Episode {
  id: string;
  entryId: string;
  category: string | null;
  title: string;
  description: string;
  audioKey: string;
  audioDuration: number;
  audioSize: number;
  publishedAt: string;
}

export interface Category {
  name: string;
  feedId: string;
  createdAt: string;
}

export interface UsageLog {
  id: string;
  entryId: string | null;
  service: 'openai_chat' | 'openai_tts' | 'anthropic';
  model: string;
  inputUnits: number;
  outputUnits: number | null;
  costUsd: number;
  createdAt: string;
}

export interface ProcessingLock {
  id: number;
  lockedAt: string | null;
  lockedBy: string | null;
}

export interface TranscriptSegment {
  speaker: 'HOST' | 'EXPERT' | 'NARRATOR';
  text: string;
  instruction: string;
}

export type Transcript = TranscriptSegment[];

export interface ProcessingResult {
  success: boolean;
  entryId: string;
  episodeId?: string;
  error?: string;
}

export interface BudgetStatus {
  period: string;
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  percentUsed: number;
  status: 'ok' | 'warning' | 'exceeded';
  processingEnabled: boolean;
}

export interface PricingConfig {
  openai?: {
    [model: string]: {
      input_per_1m?: number;
      output_per_1m?: number;
      chars_per_1m?: number;
    };
  };
  anthropic?: {
    [model: string]: {
      input_per_1m: number;
      output_per_1m: number;
    };
  };
}

export interface ApiError {
  error: string;
  message: string;
  code: string;
}

export type ErrorCode =
  | 'INVALID_URL'
  | 'DUPLICATE_URL'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'BUDGET_EXCEEDED'
  | 'PRICING_CONFIG_MISSING';
