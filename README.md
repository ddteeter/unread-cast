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

## Testing

```bash
npm test
```

## Production Deployment

The Docker image includes a bundled pricing.json with current API rates, so no manual setup is required:

```bash
docker-compose up -d
```

To override with custom pricing, mount your own file:
```yaml
volumes:
  - ./data:/data
  - ./my-custom-pricing.json:/app/pricing.json
```

## Configuration

See `.env` file for all configuration options. Key settings:

- `LLM_PROVIDER`: Choose between `anthropic` (default) or `openai`
- `LLM_MODEL`: Model to use (default: `claude-sonnet-4-5-20250929`)
  - **Anthropic models**: `claude-opus-4-6`, `claude-opus-4-5-20251101`, `claude-sonnet-4-5-20250929` (recommended)
  - **OpenAI models**: `gpt-5.2`, `gpt-5`, `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`
- `MONTHLY_BUDGET_USD`: Monthly spending limit in USD
- `PRICING_CONFIG_PATH`: Path to pricing config (default: `/data/pricing.json` for local dev, `/app/pricing.json` for Docker)

## API Pricing

The application requires a pricing configuration file containing pricing information for API calls:

- OpenAI chat models (per million tokens)
- OpenAI TTS models (per million characters)
- Anthropic models (per million tokens)

**For Docker deployments:** Pricing configuration is bundled in the image at `/app/pricing.json` with current rates. No setup required.

**For local development:** Copy `data/pricing.json.example` to `data/pricing.json` (as shown in Installation step 2).

**Important:** The bundled pricing reflects rates as of the image build date. For production use, consider periodically rebuilding the image or mounting a custom pricing file to reflect current API costs. See `data/pricing.json.example` for the required format.

## License

MIT
