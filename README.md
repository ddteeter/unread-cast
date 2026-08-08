# Unread Cast

An article-to-podcast converter that accepts URLs, generates audio via LLM+TTS, and serves episodes as RSS feeds.

## Setup

### Prerequisites

- Node.js (v24 or higher)
- Docker and Docker Compose (for production deployment)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure pricing (REQUIRED):
```bash
cp data/pricing.json.example data/pricing.json
```

Note: The `data/pricing.json` file contains API pricing information and is required for the application to run. Update pricing values periodically to reflect current API costs from OpenAI and Anthropic.

3. Set up environment variables (create `.env` file):
```bash
API_KEY=your-api-key
BASE_URL=http://localhost:8080
OPENAI_API_KEY=your-openai-key
ANTHROPIC_API_KEY=your-anthropic-key  # Optional
R2_ACCOUNT_ID=your-r2-account-id
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret
R2_BUCKET_NAME=your-bucket-name
R2_PUBLIC_URL=https://your-bucket.r2.dev
MONTHLY_BUDGET_USD=100
```

4. Initialize the database:
```bash
npm run build
npm start
```

## Development

```bash
npm run dev
```

**Note**: Pre-commit hooks automatically run prettier and eslint on staged files. This ensures code quality and prevents CI failures. No manual setup required - hooks install automatically with `npm install`.

## Testing

```bash
npm test
```

## Production Deployment

The Docker image includes a bundled pricing.json with current API rates, so no manual setup is required:

```bash
docker-compose up -d
```

To override with custom pricing, simply add `pricing.json` to your mounted data directory:
```bash
cp data/pricing.json.example data/pricing.json
# Edit data/pricing.json with your custom rates
docker-compose up -d
```

The application automatically checks `/data/pricing.json` first, then falls back to the bundled `/app/pricing.json`.

## Configuration

See `.env` file for all configuration options. Key settings:

- `LLM_PROVIDER`: Choose between `anthropic` (default) or `openai`
- `LLM_MODEL`: Model to use (default: `claude-sonnet-4-5-20250929`)
  - **Anthropic models**: `claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-6`, `claude-sonnet-4-5-20250929` (recommended), `claude-haiku-4-5`
  - **OpenAI models**: `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.3`, `gpt-5.2`, `gpt-4o-mini`
- `LLM_TRANSCRIPT_MODEL` / `LLM_EXTRACTION_MODEL`: Per-stage overrides, both defaulting to `LLM_MODEL`
- `LLM_REASONING_EFFORT`: `minimal` | `low` | `medium` | `high`, applied only to the gpt-5 family
- `TTS_MODEL`: Speech model (default: `gpt-4o-mini-tts-2025-12-15`)
- `MONTHLY_BUDGET_USD`: Monthly spending limit in USD
- `PRICING_CONFIG_PATH`: Path to pricing config (default: `/data/pricing.json` with fallback to `/app/pricing.json`)

### Choosing models per stage

Transcript generation and HTML extraction have opposite shapes: the first is short-input
and long-output, the second is a large HTML dump in and a modest amount of text out.
Pointing them at different models can cut cost without touching transcript quality.

One caveat when picking an extraction model: GPT-5.6 Luna's long-context recall (MRCR)
is 41.3% against Terra's 89.6%, so despite its very low input price it is a poor fit for
pulling an article out of a large page. Prefer Terra or better for that stage.

Any model you configure must have a matching entry in `pricing.json` — cost calculation
throws rather than guessing, so an unpriced model fails the entry instead of silently
running unbudgeted.

## API Pricing

The application requires a pricing configuration file containing pricing information for API calls:

- OpenAI chat models (per million tokens)
- OpenAI TTS models (per million tokens, for text input and audio output separately)
- Anthropic models (per million tokens)

### Upgrading an existing deployment

The default TTS model changed to `gpt-4o-mini-tts-2025-12-15`. Cost calculation throws
on a model that has no pricing entry, so **if you mount your own `/data/pricing.json`
(which takes precedence over the bundled `/app/pricing.json`), add an entry for the new
model before deploying** — otherwise every entry will fail with
`PRICING_CONFIG_MISSING`. Copy the `gpt-4o-mini-tts-2025-12-15` block from
`data/pricing.json.example`, or set `TTS_MODEL` back to a model you already price.

This is deliberate fail-safe behaviour: an unpriced model would otherwise run without
counting against `MONTHLY_BUDGET_USD`.

TTS is priced on tokens rather than characters because that is how OpenAI actually bills
it. The speech endpoint returns no usage object, so token counts are estimated from
character count — see `TTS_TOKEN_ESTIMATES` in `src/services/budget.ts` for the
derivation. The older flat `chars_per_1m` field is still honoured for backward
compatibility, but it under-counts real spend by roughly 40%, which lets actual cost run
past `MONTHLY_BUDGET_USD` before processing is blocked.

**For Docker deployments:** Pricing configuration is bundled in the image at `/app/pricing.json` with current rates. No setup required.

**For local development:** Copy `data/pricing.json.example` to `data/pricing.json` (as shown in Installation step 2).

**Important:** The bundled pricing reflects rates as of the image build date. For production use, consider periodically rebuilding the image or mounting a custom pricing file to reflect current API costs. See `data/pricing.json.example` for the required format.

## License

MIT
