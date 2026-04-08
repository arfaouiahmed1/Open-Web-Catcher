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

Stored pricing rows are loaded at startup and merged into runtime pricing defaults.

## YAML Overrides

Runtime overrides can also be supplied in:

- [`configs/settings.yaml`](../../configs/settings.yaml)
