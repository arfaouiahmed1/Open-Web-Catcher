# System Architecture

Open Web Catcher is engineered as a distributed, decoupled system divided into three primary tiers:

1. **Intelligence & Orchestration Tier** (`src/`): Python FastAPI service coordinating multi-agent state machines via LangGraph.
2. **Execution & Browser Tooling Tier** (`tools/playwright/`): Standalone Node.js service exposing browser capabilities via the Model Context Protocol (MCP) over Streamable HTTP/SSE.
3. **Observation & Control Tier** (`web/`): Next.js 15 web application providing real-time telemetry streaming, interactive agent execution graphs, and operator-grade settings.

---

## Service Topology

```text
[Operator Browser] 
       │ (HTTP:3005)
       ▼
[Next.js Console (web)] 
       │ (HTTP:8000 + SSE)
       ▼
[FastAPI Backend (owc)] ──► [PostgreSQL (pgvector)]
       │                      [Redis 7 (ephemeral state)]
       │ (MCP Streamable HTTP:3001)
       ▼
[Playwright MCP Sidecar (owc-tools-playwright)]
       │
       ▼
[Chromium Headless / Xvfb] + [uBlock Origin Lite Extension]
```

---

## Key Design Principles

- **Zero Unverified Claims**: Every discovered stream URL is validated through automated probe checks and byte sampling.
- **Context Isolation**: Every pipeline run allocates an isolated browser profile and storage state directory, completely preventing cross-site cookie or session leakage.
- **Provider-Neutral Routing**: Model interactions route through unified schemas, allowing operators to freely switch between Gemini, OpenAI, Anthropic, or local LLMs without modifying agent code.
- **Stateless Tooling**: MCP tools expose six deterministic primitives (`navigate`, `inspect`, `interact`, `harvest`, `screenshot`, `wait`), avoiding fragile client-side assumptions.
