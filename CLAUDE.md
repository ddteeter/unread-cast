# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Unread Cast is an article-to-podcast converter that accepts URLs via API, processes them through an LLM-powered pipeline to generate podcast scripts, converts them to audio using TTS, and serves them as RSS feeds for podcast apps.

**Key Flow:**
1. User submits URL → API stores in SQLite as "pending" entry
2. Cron scheduler (every 6 hours) picks up pending entries
3. Processing pipeline: fetch HTML → extract content → generate transcript → TTS → merge audio → upload to R2 → create RSS episode
4. RSS feeds served at `/feeds/:feedId` for podcast app subscriptions

## Development Commands

```bash
# Development with hot reload
npm run dev

# Build TypeScript to dist/
npm run build

# Production start (requires build first)
npm start

# Run all tests
npm test

# Watch mode for tests
npm run test:watch

# Run specific test file
npx vitest run tests/processing/pipeline.test.ts

# Docker deployment
docker-compose up -d
```

## Architecture

### Factory Pattern with Dependency Injection

The entire application uses factory functions that create service objects with their dependencies injected. See `src/index.ts` for the initialization sequence:

1. **Services Layer** - External integrations (OpenAI, Anthropic, R2, Pushover, Budget tracking)
2. **Processing Layer** - Pipeline components (fetcher, extractor, transcriber, TTS, audio merger)
3. **API Layer** - Fastify routes with authentication middleware
4. **Scheduler** - Cron jobs for processing and cleanup

All components are pure functions with explicit dependencies - no singletons or global state.

### Processing Pipeline

The pipeline (`src/processing/pipeline.ts`) orchestrates the entire conversion process:

1. **Fetch** - Download HTML from URL
2. **Extract** - Use Mozilla Readability; fallback to LLM if content < 500 chars
3. **Transcribe** - LLM generates podcast script with speaker segments and voice instructions
4. **TTS** - OpenAI TTS processes each segment with voice selection
5. **Merge** - ffmpeg concatenates segments, streams directly to R2 (no local storage)
6. **Cleanup** - Delete temp segment files (only on success; kept on failure for retry)

**Critical: Budget Protection**
- Every LLM/TTS call logs costs to `usage_log` table
- Budget service enforces `MONTHLY_BUDGET_USD` limit
- Processing blocked when budget exceeded (returns 429 errors)
- Pushover notifications at 80% and 100% thresholds

### Database Schema

SQLite at `/data/unread-cast.db` with these core tables:

- `entries` - Submitted URLs with status (pending/processing/completed/failed), retry logic
- `episodes` - Published podcast episodes with R2 audio references
- `categories` - Feed organization (each has unique feed_id for RSS)
- `usage_log` - Cost tracking for budget enforcement
- `processing_lock` - Single-row table preventing concurrent processing

### Configuration

All config via environment variables, validated with Zod schema in `src/config.ts`:

**Required:**
- `API_KEY` - Authentication for API endpoints
- `ANTHROPIC_API_KEY` - For LLM (default provider)
- `OPENAI_API_KEY` - For TTS (always required, even when using Anthropic for LLM)
- `R2_*` credentials - Cloudflare R2 for audio storage
- `MONTHLY_BUDGET_USD` - Cost protection limit

**Critical: Pricing Config**
- `data/pricing.json` REQUIRED for cost calculation
- Contains per-million pricing for OpenAI/Anthropic models
- See `data/pricing.json.example` for format
- Update regularly as API prices change

**Optional:**
- `LLM_PROVIDER` - Choose `anthropic` (default) or `openai`
- `LLM_MODEL` - Specific model to use (default: `claude-sonnet-4-5-20250929`)
  - **Anthropic**: `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-sonnet-4-5-20250929` (default)
  - **OpenAI**: `gpt-5.2`, `gpt-5`, `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`
- `PUSHOVER_*` - Notifications for budget/failures
- `CRON_SCHEDULE` - Default: `0 */6 * * *` (every 6 hours)

### Test Files

Tests use Vitest with temporary directories (`mkdtempSync` with prefix `unread-cast-test-`):

- Database tests use `:memory:` SQLite
- Mock external services (OpenAI, Anthropic, R2, Pushover)
- Pipeline tests verify full flow with segment cleanup behavior

## Key Implementation Details

### Error Handling & Retries

Entries that fail processing:
- Increment `retry_count` (max 5)
- Calculate exponential backoff: `2^retryCount minutes + random 0-30s jitter`
- Set `next_retry_at` for scheduler to pick up
- After max retries: send Pushover notification, stop retrying

### Audio Processing

Uses `fluent-ffmpeg` wrapper around ffmpeg binary:
- TTS generates AAC segments: `/data/temp/{entryId}_{segmentIndex}.aac`
- Merge concatenates without re-encoding
- Stream uploads to R2 during merge (no final file written locally)
- Segments deleted only on success (kept for retry on failure)

### LLM Provider Abstraction

Both OpenAI and Anthropic services implement same interface:
- `generateTranscript(content, title)` - Returns transcript + usage
- `extractContentWithLLM(html)` - Fallback content extraction + usage

Token limits enforced via `maxTranscriptTokens` and `maxExtractionTokens` config.

### RSS Feed Generation

Dynamic XML generation in `src/api/feeds.ts`:
- Query episodes by category's feed_id
- Standard podcast RSS 2.0 with iTunes tags
- Audio served from R2 public URL
- No caching - generated on each request

## Important Constraints

1. **Budget enforcement is critical** - Never bypass budget checks or allow processing when `canProcess()` returns false
2. **Pricing config must exist** - Application won't start without valid `data/pricing.json`
3. **Single instance processing** - `processing_lock` table prevents concurrent runs; scheduler respects this
4. **Audio segment cleanup** - Only delete temp files on success; keep on failure for retry
5. **Database is single file** - All data in one SQLite file; backup by copying `/data/unread-cast.db`
6. **Node 24+ required** - Uses modern ES2022 features, ESM modules

## Common Gotchas

- All imports must use `.js` extension (ESM requirement): `import { foo } from './bar.js'`
- TypeScript `module: "NodeNext"` setting enforces this
- R2Service expects public URL for RSS feeds (not internal R2 endpoint)
- TTS voice selection is random from configured `TTS_VOICES` array
- Cron scheduler starts AFTER HTTP server is ready (not before)
