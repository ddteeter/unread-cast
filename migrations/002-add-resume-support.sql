-- Migration 002: Add resume support
-- Created: 2026-02-08
-- Description: Add columns to track pipeline resume state and force reprocessing

-- Add force_reprocess flag (0 = auto-resume enabled, 1 = force full reprocess)
ALTER TABLE entries ADD COLUMN force_reprocess INTEGER DEFAULT 0;

-- Add expected_segment_count to validate TTS segment completeness
ALTER TABLE entries ADD COLUMN expected_segment_count INTEGER DEFAULT NULL;

-- Index for force_reprocess queries (optional optimization for rare queries)
CREATE INDEX IF NOT EXISTS idx_entries_force_reprocess
  ON entries(force_reprocess)
  WHERE force_reprocess = 1;
