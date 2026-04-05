# System Architecture Overview

> **See also:** [Agents](agents.md) · [MCP Server](mcp-server.md) · [Data Flow](data-flow.md) · [← Docs Home](../README.md)

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Single Docker Container                      │
│                                                                  │
│  ┌──────────┐  ┌──────────────┐  ┌──────────┐  ┌───────────┐  │
│  │ Postgres │  │ Chrome :9222 │  │  MCP     │  │  FastAPI  │  │
│  │   :5432  │  │ (headless)   │  │ :3000    │  │   :8000   │  │
│  └──────────┘  └──────┬───────┘  └────┬─────┘  └─────┬─────┘  │
│                        │  WebSocket    │  HTTP         │        │
│                        └──────────────┘               │        │
│                                                        │        │
│  ┌──────────────────────────────────────────────────── │ ─────┐ │
│  │          Python Agent Layer                         │      │ │
│  │                                                     ▼      │ │
│  │   OrchestratorAgent (gemini-2.5-flash-lite)                │ │
│  │   ├── ClassificationAgent (gemini-2.5-flash)               │ │
│  │   ├── LandingPageAgent    (gemini-2.5-flash)               │ │
│  │   ├── HostingPageAgent    (gemini-2.5-flash)               │ │
│  │   └── EmbeddedPageAgent   (gemini-2.5-flash)               │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐                            │
│  │   Gradio     │  │  LangSmith   │                            │
│  │   :7860      │  │  (tracing)   │                            │
│  └──────────────┘  └──────────────┘                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## Process Hierarchy (supervisord)

All four background processes are managed by `supervisord` inside the container.
They start in priority order to satisfy dependencies:

| Priority | Process | Command | Port | Depends on |
|----------|---------|---------|------|-----------|
| 10 | `chrome` | `google-chrome-stable --headless=new --remote-debugging-port=9222` | 9222 | — |
| 20 | `mcp` | `node /app/tools_js/mcp-server.js` | 3000 | chrome |
| 30 | `api` | `uvicorn src.api.app:app` | 8000 | mcp |
| 30 | `gradio` | `python -m src.api.gradio_app` | 7860 | mcp |

PostgreSQL is started in [`scripts/docker/entrypoint.sh`](../../scripts/docker/entrypoint.sh) before supervisord,
because it needs `pg_ctlcluster` which runs as the `postgres` system user.

---

## Technology Stack

### Python Side

| Library | Version | Role |
|---------|---------|------|
| `langchain-google-genai` | ≥2.0 | Gemini LLM client + `bind_tools()` |
| `langchain-core` | ≥0.3 | `BaseTool`, `BaseMessage`, `ToolMessage` |
| `langchain-mcp-adapters` | ≥0.1 | Converts MCP tools → LangChain `BaseTool` |
| `fastapi` + `uvicorn` | ≥0.111 | Async HTTP API |
| `gradio` | ≥4.36 | Demo dashboard |
| `pydantic` + `pydantic-settings` | ≥2.7 | Schema validation + config from `.env` |
| `sqlalchemy` | ≥2.0 | ORM for PostgreSQL |
| `psycopg2-binary` | ≥2.9 | PostgreSQL driver |
| `httpx` | ≥0.27 | Async HTTP for IPInfo API |
| `langsmith` | ≥0.1 | LLM tracing + evaluation |
| `cloudinary` | ≥1.40 | Screenshot hosting |
| `uv` | latest | Fast Python package manager |

### Node.js Side

| Package | Role |
|---------|------|
| `@modelcontextprotocol/sdk` | MCP server + SSE transport |
| `express` | HTTP server for SSE endpoints |
| `puppeteer-core` | Headless browser automation |
| `cloudinary` | Screenshot upload |
| `zod` | Tool parameter schema validation |

### Infrastructure

| Component | Technology | Notes |
|-----------|-----------|-------|
| Container | Docker (single) | All services in one image |
| Process manager | `supervisord` | Manages chrome/mcp/api/gradio |
| Database | PostgreSQL 15 | Persists pipeline runs, streams, emails |
| Browser | Google Chrome stable | Puppeteer connects via CDP WebSocket |
| Package manager (Py) | `uv` | Faster installs, locked deps |
| Package manager (JS) | `npm ci` | Reproducible Node installs |

---

## Design Decisions

### Why a single container?

Simpler deployment: one `docker run`, one volume, one healthcheck.
All inter-service communication is `localhost`, which eliminates network latency
and Docker networking complexity. The trade-off is that processes share resources
and can't be scaled independently — acceptable for this use case.

### Why not LangGraph for sub-agents?

LangGraph is a state machine. It excels when you have defined states with conditional
transitions between them — exactly what the orchestrator needs (classify → route →
extract → analyze → email).

Sub-agents (Landing, Hosting, Embedded) are **tool-calling loops**, not state machines.
They run `inspect → decide → interact → decide → harvest → done`. A `while` loop with
`bind_tools()` is 30 lines and gives full control over budgets, error handling, and
message history. LangGraph would add overhead without benefit here.

### Why a custom `run_agent_loop()` instead of `create_react_agent`?

`create_react_agent` enforces the **ReAct text format**: `Thought: ... Action: ...
Observation: ...`. Gemini uses **native structured function calls** — the model
returns `tool_calls` as structured data, not text. Using `create_react_agent` would
either force text parsing on structured output or use the incompatible text mode.

The custom loop (`src/agents/base.py`) is 80 lines, handles budgets, and works
natively with Gemini's function calling API.

### Why MCP instead of direct Python tool wrappers?

Before MCP: each agent imported Python `BaseTool` wrappers that called `subprocess`
to run Node.js scripts. This worked but had two problems:
1. Every agent could see every tool — no isolation
2. Starting/stopping Node processes per call was expensive

With MCP: the Node.js server runs permanently, agents connect via SSE, and each
agent profile sees only the tools it's allowed to use. The `classification` profile
sees only `inspect`; `hosting` sees `inspect + interact + harvest + screenshot + navigate`.
The LLM physically cannot call tools outside its profile.

---

## Component Responsibilities

### OrchestratorAgent

- Model: `gemini-2.5-flash-lite` (cheap, fast — only routes)
- Treats all sub-agents and analysis tools as `BaseTool` wrappers
- Calls them in order: classify → landing → hosting(s) → embedded(s) → ipinfo → email
- Does **not** do browser work itself
- See [Agents doc](agents.md#orchestrator) for full details

### ClassificationAgent

- Model: `gemini-2.5-flash`
- MCP profile: `classification` (tools: `inspect`, `navigate`)
- 1–5 tool calls max
- Output: `page_type` + `confidence` + `reasoning`

### LandingPageAgent

- Model: `gemini-2.5-flash`
- MCP profile: `landing` (tools: `inspect`, `navigate`, `interact`, `screenshot`)
- Up to 50 tool calls
- Output: list of hosting page URLs + match metadata

### HostingPageAgent

- Model: `gemini-2.5-flash`
- MCP profile: `hosting` (all 5 tools including `harvest`)
- Up to 20 tool calls
- Output: streams per server, screenshots, embedded URLs for fallback

### EmbeddedPageAgent

- Model: `gemini-2.5-flash`
- MCP profile: `embedded` (all 5 tools)
- Up to 20 tool calls
- Specialises in iframe traversal + coordinate-based clicking

---

*Next: [Agents in depth](agents.md) | [MCP Server](mcp-server.md) | [Data Flow](data-flow.md)*
