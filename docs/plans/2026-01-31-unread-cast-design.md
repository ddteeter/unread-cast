# Unread Cast - Product Requirements Document

A read-it-later application that converts web articles into podcast episodes, subscribable via Apple Podcasts and other podcast apps.

## System Overview

### Architecture
- **Runtime**: Docker container on Hetzner VPS (deployed via Dokploy)
- **Language**: TypeScript
- **Framework**: Fastify
- **Database**: SQLite (single file at `/data/unread-cast.db`)
- **Audio Storage**: Cloudflare R2 (served via custom domain)
- **Port**: 8080

### Core Flow
1. User submits URL via API
2. On scheduled intervals, system processes unprocessed entries:
   - Fetch HTML content
   - Extract article content (Readability, fallback to LLM)
   - Generate podcast transcript via LLM
   - Convert transcript to audio via OpenAI TTS
   - Merge audio clips and stream directly to R2
   - Add to RSS feed
3. User subscribes to RSS feed in podcast app

---

## API Specification

### Authentication
All endpoints (except feeds and health) require `X-API-Key` header matching configured `API_KEY` environment variable.

### Endpoints

#### `POST /entries`
Add a new read-it-later entry.

**Request:**
```json
{
  "url": "https://example.com/article",
  "category": "tech"  // optional
}
```

**Response (201 Created):**
```json
{
  "id": "uuid-string",
  "status": "pending",
  "url": "https://example.com/article",
  "category": "tech"  // or null if not provided
}
```

**Errors:**
- `400 Bad Request` - Invalid URL format
- `401 Unauthorized` - Missing or invalid API key
- `409 Conflict` - URL already exists in database

#### `POST /process`
Manually trigger processing of pending entries (outside cron schedule).

**Response (202 Accepted):**
```json
{
  "message": "Processing started",
  "pendingCount": 5
}
```

**Errors:**
- `401 Unauthorized` - Missing or invalid API key
- `503 Service Unavailable` - Budget exceeded or pricing config missing (returns `BUDGET_EXCEEDED` or `PRICING_CONFIG_MISSING` code)

#### `GET /feeds`
List all available podcast feed URLs. **Requires authentication.**

**Response (200 OK):**
```json
{
  "feeds": [
    {
      "category": "default",
      "title": "My Podcast",
      "url": "https://podcast.example.com/feed/a3f8c2d1-5b7e-4f9a.xml"
    },
    {
      "category": "tech",
      "title": "My Podcast - tech",
      "url": "https://podcast.example.com/feed/b4e9d3f2-6c8a-5b1e.xml"
    }
  ]
}
```

#### `GET /feed/:feedId.xml`
RSS feed accessed by random feed ID. No authentication required (the random ID acts as the secret).

- `/feed/{feedId}.xml` - Feed for the category associated with this feed ID

Returns valid RSS 2.0 XML with iTunes podcast extensions.

#### `GET /health`
Health check endpoint. No authentication required.

**Response (200 OK):**
```json
{
  "status": "healthy",
  "timestamp": "2025-01-15T10:30:00Z"
}
```

#### `GET /budget`
Current month's spend and budget status. Requires authentication.

**Response (200 OK):**
```json
{
  "period": "2026-01",
  "spent_usd": 12.45,
  "budget_usd": 20.00,
  "remaining_usd": 7.55,
  "percent_used": 62.3,
  "status": "ok",
  "processing_enabled": true
}
```

**Status values:**
- `ok` - Under warning threshold
- `warning` - Over warning threshold but under limit
- `exceeded` - At or over limit, processing paused
- `unlimited` - No budget configured (not possible with required `MONTHLY_BUDGET_USD`)

---

## Database Schema

### `entries` table
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PRIMARY KEY | UUID |
| url | TEXT UNIQUE NOT NULL | Original article URL |
| category | TEXT | Optional category tag (null = uncategorized) |
| status | TEXT NOT NULL | 'pending', 'processing', 'completed', 'failed' |
| title | TEXT | Article title (fetched from page) |
| extracted_content | TEXT | Extracted article text |
| transcript_json | TEXT | Generated transcript (JSON string) |
| error_message | TEXT | Last error if failed |
| retry_count | INTEGER DEFAULT 0 | Number of retry attempts |
| next_retry_at | TEXT | ISO timestamp for next retry (null if not scheduled) |
| created_at | TEXT NOT NULL | ISO timestamp |
| processed_at | TEXT | ISO timestamp when completed |

### `episodes` table
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PRIMARY KEY | UUID |
| entry_id | TEXT NOT NULL | FK to entries.id |
| category | TEXT | Category (denormalized for feed queries) |
| title | TEXT NOT NULL | Episode title |
| description | TEXT | Episode description |
| audio_key | TEXT NOT NULL | R2 object key (e.g., `{episodeId}.aac`) |
| audio_duration | INTEGER | Duration in seconds |
| audio_size | INTEGER | File size in bytes |
| published_at | TEXT NOT NULL | ISO timestamp |

### `categories` table
| Column | Type | Description |
|--------|------|-------------|
| name | TEXT PRIMARY KEY | Category name (e.g., "tech", "default") |
| feed_id | TEXT UNIQUE NOT NULL | Random UUID for feed URL |
| created_at | TEXT NOT NULL | ISO timestamp |

Categories are created dynamically when first used in an entry. A "default" category is created on first server start for uncategorized entries.

### `usage_log` table
| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PRIMARY KEY | UUID |
| entry_id | TEXT | FK to entries.id (nullable for non-entry costs) |
| service | TEXT NOT NULL | 'openai_chat', 'openai_tts', 'anthropic' |
| model | TEXT NOT NULL | e.g., 'gpt-4o', 'gpt-4o-mini-tts', 'claude-sonnet-4-20250514' |
| input_units | INTEGER NOT NULL | Tokens or characters depending on service |
| output_units | INTEGER | Tokens (null for TTS) |
| cost_usd | REAL NOT NULL | Calculated cost in USD |
| created_at | TEXT NOT NULL | ISO timestamp |

Usage is logged after each API call for cost tracking and budget enforcement.

### `processing_lock` table
| Column | Type | Description |
|--------|------|-------------|
| id | INTEGER PRIMARY KEY | Always 1 (single row) |
| locked_at | TEXT | ISO timestamp when lock was acquired |
| locked_by | TEXT | Identifier (e.g., hostname or process ID) |

Used to prevent concurrent processing. Lock is considered stale after 30 minutes.

---

## Content Processing Pipeline

### Step 1: Fetch HTML
- Use `node-fetch` or similar to retrieve page HTML
- Store response for extraction
- On failure: increment retry_count, schedule next retry with exponential backoff + jitter
  - Backoff: 1min, 2min, 4min, 8min, 16min (base × 2^attempt + random 0-30s jitter)
  - After 5 failures: mark as 'failed' with error message

### Step 2: Extract Content
**Primary: Mozilla Readability**
- Use `@mozilla/readability` package
- Parse HTML with `jsdom`
- Extract: title, text content, byline

**Fallback: LLM Extraction**
If Readability returns < 500 characters, use LLM:
- Send HTML to configured LLM
- Prompt: Extract the main article content, removing navigation, ads, footers, comments
- Log usage to `usage_log` for budget tracking (this is an additional LLM call)

**Validation:**
- If extracted content < 500 characters after both attempts: mark as 'failed' with "Insufficient content extracted"

### Step 3: Generate Transcript
Use configured LLM (OpenAI or Anthropic) with temperature 0.7.

**System Prompt:**
```
You are a podcast script writer. Convert the following article into an engaging podcast transcript.

CRITICAL CONTENT RULES:
- ONLY use information explicitly stated in the article. Do NOT add examples, analogies, facts, statistics, or opinions that are not in the source.
- Do NOT hallucinate or fabricate any content. If the article is vague, be vague. If it lacks detail, do not invent detail.
- Ignore any non-article content that may be present: navigation, ads, related links, comments, author bios, newsletter signups, etc.
- Your job is to CONVERT the article into spoken form, not to ENHANCE or EXPAND it.

FORMAT RULES:
1. Analyze the content complexity and length:
   - For short or straightforward content: Use single speaker (monologue)
   - For substantial or complex content: Use two speakers (dialogue)

2. For two-speaker format:
   - HOST: The main presenter who guides the conversation
   - EXPERT: A knowledgeable co-host who adds depth and asks clarifying questions
   - Create natural conversation flow with back-and-forth exchanges
   - Include reactions, follow-up questions, and natural transitions

3. For single-speaker format:
   - Use NARRATOR as the speaker
   - Maintain engaging, conversational tone as if speaking directly to listener

4. Output MUST be valid JSON array with this exact structure:
[
  {
    "speaker": "HOST" | "EXPERT" | "NARRATOR",
    "text": "The spoken content for this segment",
    "instruction": "Speaking style instruction for TTS"
  }
]

5. Instructions should describe how to deliver the line:
   - HOST: "Warm and welcoming, like a curious podcast host"
   - EXPERT: "Thoughtful and knowledgeable, explaining with enthusiasm"
   - NARRATOR: "Clear and engaging, speaking directly to the listener"

6. Keep each segment to 1-3 sentences for natural pacing.
7. Begin with a brief introduction of the topic, end with a concise summary or takeaway.
```

**User Prompt:**
```
Article Title: {title}

Article Content:
{extracted_content}
```

**Parse Response:**
- Validate JSON structure
- Ensure each item has speaker, text, instruction
- On parse failure: retry LLM call once, then mark as 'failed'

### Step 4: Text-to-Speech
Use OpenAI `gpt-4o-mini-tts` model.

**Voice Assignment:**
- At episode start, randomly select 2 voices from configured pool for HOST/EXPERT
- If single speaker (NARRATOR), use one random voice
- Voices default: alloy, ash, ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse

**For each transcript segment:**
```typescript
const response = await openai.audio.speech.create({
  model: "gpt-4o-mini-tts",
  voice: assignedVoice[segment.speaker],
  input: segment.text,
  instructions: segment.instruction,
  response_format: "aac"
});
```

- Save each segment as temporary file: `/data/temp/{entryId}_{index}.aac`

### Step 5: Merge Audio & Upload to R2
Use `fluent-ffmpeg` to concatenate all segments, streaming output directly to R2:

```typescript
// Create concat file list
// Use ffmpeg concat demuxer to merge
// Stream output to R2 via @aws-sdk/lib-storage Upload
// Object key: {episodeId}.aac
// Target: AAC 128kbps
```

**On successful upload:**
- Delete all temp segment files from `/data/temp/`
- Calculate duration and file size for episode metadata

**On upload failure:**
- Keep segment files intact (can re-merge without re-running TTS)
- Mark entry for retry

### Step 6: Create Episode
- Generate episode ID (UUID)
- Create episode record with:
  - title: from entry.title
  - description: first 200 chars of extracted content + "..."
  - audio_key: `{episodeId}.aac`
  - published_at: current timestamp
- Update entry status to 'completed', set processed_at

---

## R2 Storage Configuration

### Bucket Setup
- Create R2 bucket in Cloudflare dashboard
- Configure custom domain (e.g., `audio.yourdomain.com`)
- Set lifecycle rule to delete objects after `RETENTION_DAYS` (default 90)

### Audio URLs
Full URL constructed as: `{R2_PUBLIC_URL}/{audio_key}`

Example: `https://audio.yourdomain.com/a3f8c2d1-5b7e-4f9a-8c1d-2e3f4a5b6c7d.aac`

### Upload Settings
- Set `Content-Type: audio/aac` on upload for proper handling by podcast apps
- No caching headers needed (R2/Cloudflare handles this)

---

## RSS Feed Generation

Generate valid RSS 2.0 with iTunes podcast extensions.

### Feed Limits
- Maximum 50 most recent episodes per feed
- Older episodes still exist in database but are not included in RSS

### Feed Structure
```xml
<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"
     xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>{FEED_TITLE} - {category}</title>  <!-- or just FEED_TITLE for default -->
    <link>{BASE_URL}</link>
    <description>{FEED_DESCRIPTION}</description>
    <language>en-us</language>
    <itunes:author>{FEED_AUTHOR}</itunes:author>
    <itunes:image href="{ARTWORK_URL}"/>
    <atom:link href="{BASE_URL}/feed/{feedId}.xml" rel="self" type="application/rss+xml"/>

    <!-- Episodes, newest first -->
    <item>
      <title>{episode.title}</title>
      <description>{episode.description}</description>
      <enclosure url="{R2_PUBLIC_URL}/{episode.audio_key}"
                 length="{episode.audio_size}"
                 type="audio/aac"/>
      <guid isPermaLink="false">{episode.id}</guid>
      <pubDate>{RFC 2822 formatted date}</pubDate>
      <itunes:duration>{HH:MM:SS or MM:SS}</itunes:duration>
    </item>
  </channel>
</rss>
```

---

## Cost Controls

### Pricing Configuration

Pricing is configured via a JSON file at `/data/pricing.json` (configurable via `PRICING_CONFIG_PATH`).

**Example pricing.json:**
```json
{
  "openai": {
    "gpt-4o": { "input_per_1m": 2.50, "output_per_1m": 10.00 },
    "gpt-4o-mini": { "input_per_1m": 0.15, "output_per_1m": 0.60 },
    "gpt-4o-mini-tts": { "chars_per_1m": 12.00 }
  },
  "anthropic": {
    "claude-sonnet-4-20250514": { "input_per_1m": 3.00, "output_per_1m": 15.00 }
  }
}
```

**Behavior if pricing config missing, invalid, or model not found:**
- Server refuses to process any entries
- Entries stay pending until config is fixed
- Logs error on startup and on each processing attempt
- If `LLM_MODEL` or TTS model is not in pricing config, processing fails with `PRICING_CONFIG_MISSING` error

### Budget Enforcement

- `MONTHLY_BUDGET_USD` is required - fail safe, not open
- Before processing each entry, check if current month's spend >= budget
- If exceeded, skip processing (entries stay pending)
- If budget is exceeded mid-batch: finish current entry, then stop (remaining entries stay pending)
- Budget resets automatically on the 1st of each month (calendar month)

### Usage Tracking

After each API call:
1. Capture usage from response (tokens for chat, characters for TTS)
2. Look up pricing for the model in pricing config
3. Calculate cost in USD
4. Insert record into `usage_log` table

### Alerts via Pushover

If `PUSHOVER_USER_KEY` and `PUSHOVER_APP_TOKEN` are configured, send push notifications for:

1. **Budget warning** - When spend crosses `BUDGET_WARNING_PERCENT` threshold (default 80%)
2. **Budget exceeded** - When spend hits 100% (processing paused)
3. **Processing failed** - When an entry fails after max retries

**Example alert:**
```
Title: Unread Cast - Budget Warning
Message: Monthly spend at 82% ($16.40 of $20.00). Processing will pause at 100%.
```

If Pushover is not configured, alerts are logged to stdout only.

---

## Scheduled Tasks

### Processing Job (Cron)
- Default schedule: `0 */6 * * *` (every 6 hours)
- Configurable via `CRON_SCHEDULE` environment variable
- Use `node-cron` package

**Processing Lock:**
- Before processing, acquire a lock (row in `processing_lock` table with timestamp)
- If lock exists and is < 30 minutes old, skip processing (another job is running)
- If lock exists and is >= 30 minutes old, assume stale and take over (previous job crashed)
- Release lock when processing completes (success or failure)
- This prevents duplicate processing from overlapping cron jobs or concurrent POST /process calls

**Job Logic:**
1. Attempt to acquire processing lock (skip if locked)
2. Query entries with status='pending' OR (status='failed' AND retry_count < 5 AND next_retry_at <= now)
3. Process sequentially (one at a time)
4. For each entry, run full pipeline (Steps 1-6)
5. On error: update retry_count, calculate next_retry_at, set error_message
6. Release processing lock

### Cleanup Job
- Run daily at midnight UTC: `0 0 * * *`
- Delete episode records older than `RETENTION_DAYS` from SQLite
- R2 lifecycle rules handle file deletion automatically
- Delete orphaned temp segment files in `/data/temp/` older than 24 hours
- Reset any entries stuck in 'processing' status back to 'pending' (handles crashes)

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `API_KEY` | Yes | - | API key for authentication |
| `BASE_URL` | Yes | - | Public URL (e.g., https://podcast.example.com) |
| `PORT` | No | 8080 | HTTP server port |
| `CRON_SCHEDULE` | No | `0 */6 * * *` | Processing schedule (cron expression) |
| `OPENAI_API_KEY` | Yes | - | OpenAI API key for TTS and optional LLM |
| `ANTHROPIC_API_KEY` | No | - | Anthropic API key (if using Claude) |
| `LLM_PROVIDER` | No | openai | 'openai' or 'anthropic' |
| `LLM_MODEL` | No | gpt-4o | Model for transcript generation |
| `TTS_VOICES` | No | all 11 | Comma-separated voice list |
| `FEED_TITLE` | No | Unread Cast | RSS feed title |
| `FEED_AUTHOR` | No | Unread Cast | RSS feed author |
| `FEED_DESCRIPTION` | No | Auto-generated podcasts | RSS feed description |
| `ARTWORK_URL` | No | - | URL to podcast artwork image |
| `RETENTION_DAYS` | No | 90 | Days to keep episodes |
| `MIN_CONTENT_LENGTH` | No | 500 | Minimum extracted chars |
| `R2_ACCOUNT_ID` | Yes | - | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | Yes | - | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | Yes | - | R2 API token secret |
| `R2_BUCKET_NAME` | Yes | - | R2 bucket name |
| `R2_PUBLIC_URL` | Yes | - | Custom domain URL for R2 (e.g., https://audio.yourdomain.com) |
| `MONTHLY_BUDGET_USD` | Yes | - | Monthly spend limit in USD (required for processing) |
| `PRICING_CONFIG_PATH` | No | `/data/pricing.json` | Path to pricing configuration file |
| `PUSHOVER_USER_KEY` | No | - | Pushover user key for alerts |
| `PUSHOVER_APP_TOKEN` | No | - | Pushover application token for alerts |
| `BUDGET_WARNING_PERCENT` | No | 80 | Percentage threshold to trigger warning alert |

---

## Project Structure

```
unread-cast/
├── src/
│   ├── index.ts              # Entry point, server setup
│   ├── config.ts             # Environment variable parsing
│   ├── db/
│   │   ├── schema.ts         # Database schema/migrations
│   │   └── client.ts         # SQLite client wrapper
│   ├── api/
│   │   ├── routes.ts         # Fastify route definitions
│   │   ├── entries.ts        # Entry CRUD handlers
│   │   ├── feeds.ts          # RSS feed generation
│   │   └── middleware.ts     # Auth middleware
│   ├── processing/
│   │   ├── scheduler.ts      # Cron job setup
│   │   ├── pipeline.ts       # Main processing orchestrator
│   │   ├── fetcher.ts        # HTML fetching
│   │   ├── extractor.ts      # Content extraction (Readability + LLM)
│   │   ├── transcriber.ts    # LLM transcript generation
│   │   ├── tts.ts            # OpenAI TTS integration
│   │   └── audio.ts          # Audio merging + R2 upload
│   ├── services/
│   │   ├── openai.ts         # OpenAI client wrapper
│   │   ├── anthropic.ts      # Anthropic client wrapper
│   │   ├── r2.ts             # R2 storage client
│   │   ├── pushover.ts       # Pushover notification client
│   │   └── budget.ts         # Budget tracking and enforcement
│   └── types/
│       └── index.ts          # TypeScript interfaces
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
└── README.md
```

---

## Dependencies

### Production
- `fastify` - HTTP framework
- `@fastify/cors` - CORS support
- `better-sqlite3` - SQLite driver
- `@mozilla/readability` - Content extraction
- `jsdom` - HTML parsing
- `openai` - OpenAI SDK
- `@anthropic-ai/sdk` - Anthropic SDK
- `@aws-sdk/client-s3` - S3-compatible client for R2
- `@aws-sdk/lib-storage` - Streaming uploads to S3/R2
- `node-cron` - Job scheduling
- `fluent-ffmpeg` - Audio processing
- `uuid` - ID generation
- `zod` - Schema validation

### Development
- `typescript`
- `tsx` - TypeScript execution
- `@types/*` - Type definitions

### Docker
- Base image: `node:24-alpine`
- Install `ffmpeg` package in container

---

## Interfaces for Agent Independence

### Entry Interface
```typescript
interface Entry {
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
```

### Episode Interface
```typescript
interface Episode {
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
```

### Category Interface
```typescript
interface Category {
  name: string;
  feedId: string;
  createdAt: string;
}
```

### Transcript Segment Interface
```typescript
interface TranscriptSegment {
  speaker: 'HOST' | 'EXPERT' | 'NARRATOR';
  text: string;
  instruction: string;
}

type Transcript = TranscriptSegment[];
```

### Processing Result Interface
```typescript
interface ProcessingResult {
  success: boolean;
  entryId: string;
  episodeId?: string;
  error?: string;
}
```

### LLM Provider Interface
```typescript
interface LLMProvider {
  generateTranscript(content: string, title: string): Promise<Transcript>;
  extractContent(html: string): Promise<string>;
}
```

### R2 Storage Interface
```typescript
interface R2Storage {
  upload(key: string, stream: Readable): Promise<{ url: string; size: number }>;
  delete(key: string): Promise<void>;
}
```

### Usage Log Interface
```typescript
interface UsageLog {
  id: string;
  entryId: string | null;
  service: 'openai_chat' | 'openai_tts' | 'anthropic';
  model: string;
  inputUnits: number;
  outputUnits: number | null;
  costUsd: number;
  createdAt: string;
}
```

### Budget Status Interface
```typescript
interface BudgetStatus {
  period: string;  // YYYY-MM format
  spentUsd: number;
  budgetUsd: number;
  remainingUsd: number;
  percentUsed: number;
  status: 'ok' | 'warning' | 'exceeded';
  processingEnabled: boolean;
}
```

### Pricing Config Interface
```typescript
interface PricingConfig {
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
```

### Budget Service Interface
```typescript
interface BudgetService {
  logUsage(log: Omit<UsageLog, 'id' | 'createdAt'>): Promise<void>;
  getStatus(): Promise<BudgetStatus>;
  canProcess(): Promise<boolean>;
  calculateCost(service: string, model: string, inputUnits: number, outputUnits?: number): number;
}
```

---

## Error Handling

### Retry Strategy
- Exponential backoff with jitter: `(2^attempt) minutes + random(0-30) seconds`
- Maximum 5 retries before marking permanently failed
- Retryable errors: network timeouts, rate limits, temporary API errors, R2 upload failures
- Non-retryable: invalid URL, 404, content too short

### Error Response Format
```json
{
  "error": "Error type",
  "message": "Human-readable description",
  "code": "ERROR_CODE"
}
```

Error codes: `INVALID_URL`, `DUPLICATE_URL`, `UNAUTHORIZED`, `NOT_FOUND`, `INTERNAL_ERROR`, `BUDGET_EXCEEDED`, `PRICING_CONFIG_MISSING`

---

## Verification / Testing

### Manual Testing
1. Create pricing config: `echo '{"openai":{"gpt-4o":{"input_per_1m":2.5,"output_per_1m":10},"gpt-4o-mini-tts":{"chars_per_1m":12}}}' > /data/pricing.json`
2. Start the server: `npm run dev`
3. Check budget: `curl http://localhost:8080/budget -H "X-API-Key: test"`
4. Add an entry: `curl -X POST http://localhost:8080/entries -H "X-API-Key: test" -H "Content-Type: application/json" -d '{"url": "https://example.com/article"}'`
5. Trigger processing: `curl -X POST http://localhost:8080/process -H "X-API-Key: test"`
6. Check feeds: `curl http://localhost:8080/feeds -H "X-API-Key: test"`
7. Get feed URL from response, verify RSS: `curl http://localhost:8080/feed/{feedId}.xml`
8. Subscribe in podcast app using the feed URL

### Unit Tests
- Test content extraction with sample HTML
- Test transcript JSON parsing
- Test RSS XML generation
- Test retry backoff calculation
- Test R2 upload/delete operations (mocked)
- Test cost calculation from usage
- Test budget enforcement (processing blocked when exceeded)
- Test calendar month reset logic

### Integration Tests
- Full pipeline with mock LLM/TTS responses
- Database operations
- R2 storage operations (using localstack or minio)

---

## Implementation Order

Recommended order for parallel agent work:

1. **Foundation** (must be first):
   - `src/config.ts` - Environment parsing
   - `src/db/` - Database setup and schema
   - `src/types/` - TypeScript interfaces

2. **Can be parallel after Foundation**:
   - **Agent A**: `src/api/` - All HTTP routes and middleware (including `/budget` endpoint)
   - **Agent B**: `src/processing/fetcher.ts` + `src/processing/extractor.ts`
   - **Agent C**: `src/services/openai.ts` + `src/services/anthropic.ts` + `src/services/r2.ts`
   - **Agent D**: `src/services/budget.ts` + `src/services/pushover.ts`

3. **After services ready**:
   - `src/processing/transcriber.ts` - Uses LLM services
   - `src/processing/tts.ts` - Uses OpenAI service

4. **After TTS ready**:
   - `src/processing/audio.ts` - Audio merging + R2 upload

5. **After all processing modules**:
   - `src/processing/pipeline.ts` - Orchestrates everything
   - `src/processing/scheduler.ts` - Cron setup

6. **Final**:
   - `src/index.ts` - Wire everything together
   - `Dockerfile` + `docker-compose.yml`
