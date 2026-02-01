// src/types/index.ts

export interface Entry {
  id: string;
  url: string;
  category: string | null;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  title: string | null;
  extracted_content: string | null;
  transcript_json: string | null;
  error_message: string | null;
  retry_count: number;
  next_retry_at: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface Episode {
  id: string;
  entry_id: string;
  category: string | null;
  title: string;
  description: string;
  audio_key: string;
  audio_duration: number;
  audio_size: number;
  published_at: string;
}

export interface Category {
  name: string;
  feed_id: string;
  created_at: string;
}

export interface UsageLog {
  id: string;
  entry_id: string | null;
  service: 'openai_chat' | 'openai_tts' | 'anthropic';
  model: string;
  input_units: number;
  output_units: number | null;
  cost_usd: number;
  created_at: string;
}

export interface ProcessingLock {
  id: number;
  locked_at: string | null;
  locked_by: string | null;
}

export interface TranscriptSegment {
  speaker: 'HOST' | 'EXPERT' | 'NARRATOR';
  text: string;
  instruction: string;
}

export type Transcript = TranscriptSegment[];

export interface ProcessingResult {
  success: boolean;
  entry_id: string;
  episode_id?: string;
  error?: string;
}

export interface BudgetStatus {
  period: string;
  spent_usd: number;
  budget_usd: number;
  remaining_usd: number;
  percent_used: number;
  status: 'ok' | 'warning' | 'exceeded';
  processing_enabled: boolean;
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
