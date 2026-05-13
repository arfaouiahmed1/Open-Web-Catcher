# Open Web Catcher

Open Web Catcher is a Python multi-agent investigation pipeline with a Next.js operator console. It classifies streaming pages, routes them through specialized agents, extracts stream URLs, analyzes providers, drafts takedown emails, and stores detailed observability data in Postgres.

## What Changed

- The previous dashboard implementation is gone.
- The external tracing backend is gone.
- The product now uses:
  - `FastAPI` for execution and API endpoints
  - `Next.js` for the operator console
  - internal observability persisted to Postgres
  - first-party cost and token accounting

## Architecture

```text
URL
  -> classification agent
  -> orchestrator routing
  -> landing / hosting / embedded agent
  -> provider lookup
  -> takedown email generation
  -> Postgres observability + runtime records
  -> Next.js operator console
```

## Main Surfaces

- API: `http://localhost:8000`
- Operator console: `http://localhost:3000`
- MCP tools server: `http://localhost:3001`

## Operator Console

The `web/` app provides:

- Overview dashboard for KPIs, trends, costs, tokens, models, providers, and run health
- Live workflow studio for orchestrator runs with SSE event streaming and graph visualization
- Agent lab for direct per-agent test runs
- Tool playground for direct MCP tool calls
- Provider intel for direct m3u8/IP/whois/provider inspection
- Runs explorer for persisted run drill-down
- Database explorer for read-only access to allowlisted Postgres tables
- Pricing settings for first-party cost configuration

## Backend

The backend lives under `src/`:

- `src/api/app.py`: FastAPI routes, SSE streaming, UI endpoints
- `src/agents/`: orchestrator and specialist agents
- `src/tools/mcp_client.py`: MCP tool connectivity
- `src/storage/repositories.py`: pipeline persistence
- `src/storage/ui_repository.py`: dashboard, pricing, and DB explorer queries
- `src/utils/observability.py`: internal event and metrics registry

## Data Model

Postgres stores:

- pipeline runs
- run snapshots
- agent runs
- run model usage
- LLM calls
- tool calls
- tool playground calls
- provider lookup checks
- runtime events
- streams, screenshots, providers, takedown emails
- pricing configs

## Development

### Python

```bash
uv venv .venv --python 3.11
uv pip install --python .venv/bin/python -e ".[dev]"
```

On Windows:

```powershell
uv venv .venv --python 3.11
uv pip install --python .venv\Scripts\python.exe -e ".[dev]"
```

### Web

```bash
cd web
npm install
npm run dev
```

### Docker

```bash
cp .env.example .env
docker compose up --build
```

## Validation

Web production build:

```bash
cd web
npm run build
```

## Documentation Map

- [Docs Home](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/README.md)
- [FastAPI API](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/api/fastapi.md)
- [Operator Console](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/api/operator-console.md)
- [Architecture Overview](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/architecture/overview.md)
- [Data Flow](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/architecture/data-flow.md)
- [Implementation Deep Dive (2026-04-09)](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/architecture/implementation-deep-dive-2026-04-09.md)
- [Configuration](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/setup/configuration.md)
- [Docker Setup](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/setup/docker.md)
- [Quickstart](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/setup/quickstart.md)
- [Troubleshooting](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/setup/troubleshooting.md)
- [2026-04-08 Agent Debugging and Fixes](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/changelog/2026-04-08-agent-debugging-and-fixes.md)
- [2026-04-09 Issues, Fixes, and Future Improvements](C:/Users/ahmed/Desktop/PFE%20New%20Test/docs/changelog/2026-04-09-issues-fixes-future-improvements.md)
