# Open Web Catcher Documentation

> **Navigation:** [Docs Home](./README.md) | [Target Architecture](./architecture/target-design.md) | [ADRs](./adr/) | [System](./system/README.md) | [Workflow](./workflow/README.md) | [Agents](./agents/README.md) | [API](./api/README.md) | [Tools](./tools/README.md) | [Operations](./operations/README.md)

Open Web Catcher is a multi-agent evidence collection system for investigating unauthorized streaming pages. The operator submits a URL, the backend classifies the page, specialist agents inspect it through browser tools, provider analysis resolves infrastructure, and a Next.js console shows both results and failure paths.

The project is mid-re-architecture. Two layers of documentation exist on purpose:

- **Target design** describes what the system is becoming. It is the naming authority: every new class, contract, and page must appear there before its code lands.
- **Module docs** describe what exists today. Where they lag behind the target, the gap is tracked work in `.omo/plans/full-audit.md`, not an error to fix by editing prose.

## Reading Guide

Read in this order.

### 1. Start here: Target Architecture

[Architecture: Target Design](./architecture/target-design.md) is the root document of this tree. It defines the eight agent modules and their typed stage contracts, the two-tier memory model (Redis run state, Postgres plus pgvector long-term memory), the storage and event schema, the LLM provider layer, and the frontend module map. Its conformance rules bind every later change.

### 2. Then the ADRs

Decision records under [docs/adr/](./adr/) explain why the target looks the way it does, one decision per file:

| ADR | Decision |
| --- | --- |
| [ADR-001](./adr/ADR-001-litellm-provider.md) | LiteLLM replaces direct Gemini SDK calls; one provider seam, per-family usage extraction, config-only switching. |
| [ADR-002](./adr/ADR-002-redis-run-state.md) | Redis owns run-scoped short-term memory and SSE fan-out; Postgres owns long-term memory; SQLite and JSON stores are deleted after migration. |
| [ADR-003](./adr/ADR-003-playwright-only-persona.md) | Puppeteer stack is deleted after a feature port; one coherent Windows-laptop persona with persistent cookie jars; zero user-facing fingerprint or proxy knobs. |
| [ADR-004](./adr/ADR-004-rag-strategy.md) | Vector RAG for logo and channel matching, agentic RAG for site memory, GraphRAG rejected. |
| [ADR-005](./adr/ADR-005-auth-model.md) | JWT bearer auth with admin/operator/viewer roles, global 401, bootstrap-admin hatch for fresh installs. |

Each ADR states plainly which parts have landed and which are planned.

### 3. Current-state snapshots

[Current Implementation Diagrams](./architecture/current-diagrams.md) holds the UML-style diagram compendium of today's runtime (component, deployment, sequence, class, ER, and state diagrams), each grounded in source files. It is a snapshot, not the contract.

### 4. Module docs

Deeper pages by area:

1. [System](./system/README.md): architecture, deployment, persistence, runtime structure.
2. [Workflow](./workflow/README.md): how runs start, stream events, persist evidence, and appear in the dashboard.
3. [Agents](./agents/README.md): orchestrator, classification, landing, hosting, embedded, provider, email responsibilities.
4. [API Contracts](./api/README.md): FastAPI routes and operator-console payloads.
5. [MCP And Browser Tools](./tools/README.md): browser automation tools and MCP profiles.
6. [Operations](./operations/README.md): Docker, configuration, validation, troubleshooting, key rotation, migration safety.

Historical notes live under [docs/archive/README.md](./archive/README.md). They are not the active implementation contract.

## Status Honesty

Facts about what landed versus what is planned are marked where they matter:

- Landed: LiteLLM adapter (`src/llm/provider.py`), confidence gating in classification routing, OCR skeleton behind `ocr_enabled`, real Alembic migrations, atomic job claims, hardened Dockerfiles, pytest tiers.
- In progress under plan task 3; not yet verified: auth (`src/api/auth/`, see [ADR-005](./adr/ADR-005-auth-model.md)).
- Planned: Redis run store, pgvector tables, puppeteer deletion, validator node, RunPlan artifact, SSE-only frontend, admin APIs. Track them in `.omo/plans/full-audit.md`.

When you change code, update the matching diagram in `target-design.md` in the same change set (conformance rule 2), and touch the module doc for the area you changed.

## Documentation Index

### Architecture And Decisions

- [Target Design](./architecture/target-design.md)
- [Current Implementation Diagrams](./architecture/current-diagrams.md)
- [ADR Index](./adr/)

### System

- [System Index](./system/README.md)
- [Architecture](./system/architecture.md)
- [LangChain And LangGraph Runtime](./system/langchain-langgraph.md)
- [Runtime Classes And Function Map](./system/runtime-classes-functions.md)
- [Deployment](./system/deployment.md)
- [Data Model](./system/data-model.md)
- [Caching And Observability](./system/caching-observability.md)

### Workflow

- [Workflow Index](./workflow/README.md)
- [Run Lifecycle](./workflow/run-lifecycle.md)
- [Dashboard Logging And Run Telemetry](./workflow/dashboard-logging.md)
- [Agent Desk](./workflow/agent-desk.md)
- [Example Run: db970f27](./workflow/run-db970f27.md)

### Agents

- [Agents Index](./agents/README.md)
- [How Agents Use LangChain And LangGraph](./agents/how-agents-use-langchain-langgraph.md)
- [Orchestrator](./agents/orchestrator.md)
- [Classification](./agents/classification.md)
- [Landing](./agents/landing.md)
- [Hosting](./agents/hosting.md)
- [Embedded](./agents/embedded.md)
- [Provider Analysis](./agents/provider-analysis.md)
- [Email Generator](./agents/email-generator.md)

### APIs And Tools

- [API Index](./api/README.md)
- [FastAPI Contracts](./api/fastapi.md)
- [Operator Console API](./api/operator-console.md)
- [Tools Index](./tools/README.md)
- [MCP Browser Tools](./tools/mcp-browser-tools.md)

### Operations

- [Operations Index](./operations/README.md)
- [Docker And Ports](./operations/docker.md)
- [Configuration](./operations/configuration.md)
- [Validation](./operations/validation.md)
- [Troubleshooting](./operations/troubleshooting.md)
- [Key Rotation](./operations/key-rotation.md)
- [Migration Safety](./operations/migration-safety.md)
- [Azure Container Apps Job With Service Bus](./operations/azure-container-app-job-service-bus.md)

## Active Implementation Sources

| Area | Source |
| --- | --- |
| FastAPI routes, auth, background jobs | `src/api/app.py`, `src/api/auth/`, `src/api/datasets.py`, `src/api/provider_config.py` |
| Agent runtime | `src/agents/orchestrator.py`, `src/agents/base.py`, `src/agents/classification.py`, `src/agents/landing_page.py`, `src/agents/hosting_page.py`, `src/agents/embedded_page.py`, `src/agents/ocr_agent.py` |
| LLM provider layer | `src/llm/provider.py` |
| Memory | `src/memory/short_term.py`, `src/memory/long_term.py` |
| Runtime schemas and enums | `src/models/schemas.py`, `src/models/enums.py` |
| Persistence | `src/storage/models.py`, `src/storage/repositories.py`, `src/storage/ui_repository.py`, `src/storage/dataset_repository.py` |
| MCP and provider tools | `src/tools/mcp_client.py`, `src/tools/ipinfo_tool.py`, `src/tools/email_tool.py`, `tools/puppeteer/`, `tools/playwright/` |
| Active frontend routes | `web/app/page.js`, `web/app/live/page.js`, `web/app/runs/page.js`, `web/app/runs/[runId]/page.js`, `web/app/providers/page.js`, `web/app/settings/page.js`, `web/app/agents/page.js` |
| Frontend navigation and run detail | `web/components/console/layout/navigation-config.js`, `web/components/console/run-detail/`, `web/lib/run-trace.js`, `web/lib/api.js` |
| Docker stack | `docker-compose.yml`, `Dockerfile`, `Dockerfile.web`, `Dockerfile.tools`, `Dockerfile.tools.playwright` |
