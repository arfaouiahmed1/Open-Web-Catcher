# Architecture Overview

## Stack

- Backend: FastAPI
- Agents: Python async agents under `src/agents/`
- Browser tooling: Node.js MCP servers under `tools/puppeteer/` and `tools/playwright/`
- UI: Next.js App Router under `web/`
- Database: Postgres
- Persistence: SQLAlchemy + Alembic

## Runtime Services

- `owc-tools`: browser and MCP tools server on `3001` (host)
- `owc`: FastAPI backend on `8000`
- `owc-web`: Next.js operator console on `3000` (host)
- `postgres`: main persistence layer

## Key Paths

- [`src/agents/orchestrator.py`](../../src/agents/orchestrator.py)
- [`src/api/app.py`](../../src/api/app.py)
- [`src/storage/repositories.py`](../../src/storage/repositories.py)
- [`src/storage/ui_repository.py`](../../src/storage/ui_repository.py)
- [`src/utils/observability.py`](../../src/utils/observability.py)
- [`tools/puppeteer/mcp-server.js`](../../tools/puppeteer/mcp-server.js)
- [`tools/playwright/mcp-server.js`](../../tools/playwright/mcp-server.js)
- [`web/app`](../../web/app)

## Responsibility Split

- Python owns agent execution, orchestration, persistence, evaluations, and observability
- Node owns browser automation and MCP tool exposure
- Next.js owns the operator-facing interface

## Persistence Strategy

Two layers are kept:

- legacy run snapshots for compatibility
- normalized observability tables for dashboards, drill-downs, and evaluations
