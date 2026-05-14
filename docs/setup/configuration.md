# Configuration

The main settings model is [`src/utils/config.py`](../../src/utils/config.py).

## Core Environment Variables

### Models

- `GOOGLE_API_KEY`
- `ORCHESTRATOR_MODEL`
- `AGENT_MODEL`

### Browser and MCP

- `BROWSER_WS_ENDPOINT`
- `MCP_SERVER_URL`

### Database

- `DATABASE_URL`

### Observability

- `OBSERVABILITY_ENABLED`
- `OBSERVABILITY_PROJECT_NAME`
- `OBSERVABILITY_DEFAULT_DATASET_NAME`
- `OBSERVABILITY_DATASET_DIR`
- `MODEL_PRICING_JSON`
- `PROVIDER_PRICING_SYNC_ENABLED`
- `PROVIDER_PRICING_TIMEOUT_SECONDS`
- `PROVIDER_PRICING_MAX_MODELS`
- `UI_CORS_ORIGINS`

### Integrations

- `IPINFO_TOKEN`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

## Pricing Configuration

Costs come from either:

- `MODEL_PRICING_JSON`
- pricing rows stored through the operator console
- provider API sync (`POST /ui/pricing/sync`) where supported

Stored pricing rows are loaded at startup and merged into runtime pricing defaults.

Provider API sync support is Gemini-only (`google`).

## YAML Overrides

Runtime overrides can also be supplied in:

- [`configs/settings.yaml`](../../configs/settings.yaml)
