# Progress Log

> Chronological record of what was built, key decisions made, and milestones reached.
> See [Issues & Resolutions](issues.md) for bugs and architectural wrong turns.
> **[← Docs Home](../README.md)**

---

## Phase 1 — Project Scaffold

**Starting point:** README.md only (no code).

Built the full 87-file project scaffold matching the README architecture:

```
src/
├── agents/   classification · landing_page · hosting_page · embedded_page · orchestrator
├── api/      gradio_app
├── models/   schemas · enums
├── memory/   short_term · long_term
├── evaluation/ metrics · tracing · datasets
├── storage/  database · repositories
├── tools/    bridge · inspect_tool · interact_tool · harvest_tool · navigate_tool · screenshot_tool
└── utils/    config · logging · browser · ipinfo
tools_js/     inspect · interact · harvest · navigate · screenshot · shared/
configs/      settings.yaml · prompts/
tests/        conftest · test_tools · test_agents · test_orchestrator · test_prompts · test_schemas
scripts/      run_batch · export_metrics · migrate_db · extract_tools_from_n8n
```

**Key initial decisions:**
- `pydantic-settings` for config (loads `.env` + YAML, validated)
- `SQLAlchemy` ORM for storage (ready for SQLite → PostgreSQL)
- Prompts as versioned markdown files in `configs/prompts/` (hot-swappable)
- `cloudinary` for screenshot hosting (visual evidence in DMCA emails)

---

## Phase 2 — Framework Architecture Decision

**Question asked:** Do sub-agents need LangGraph? Is LangChain needed?

**Decision reached:**

| Component | Framework | Reason |
|-----------|-----------|--------|
| Orchestrator | LLM agent (custom loop) | Routes based on classification result — LLM decides order |
| Sub-agents | Custom `run_agent_loop()` | Tool-calling loop, not a state machine |
| LangGraph | **Not used** | Added complexity without benefit for simple while-loops |
| LangChain `create_react_agent` | **Not used** | Forces ReAct text format; Gemini uses native function calls |

What IS used from LangChain:
- `langchain-core`: `BaseTool`, `BaseMessage`, `ToolMessage`, `SystemMessage`
- `langchain-google-genai`: `ChatGoogleGenerativeAI` + `bind_tools()`
- `langsmith`: tracing callbacks

**`run_agent_loop()` built** in `src/agents/base.py` — 80-line async while-loop:
```
messages → ainvoke → check tool_calls → execute → append ToolMessages → repeat
```

---

## Phase 3 — Tool Architecture: subprocess → MCP

**Original approach:** Python `JSToolBridge` called Node.js scripts as subprocesses.

**Problem:** No tool isolation — every agent could call every tool. Inefficient (subprocess startup per call).

**New approach:** MCP (Model Context Protocol) server.

**MCP server built** in `tools_js/`:
- `mcp-server.js` — Express app, one `McpServer` per SSE connection
- `profiles.js` — declares which tools each agent profile can see
- `tools/inspect.js`, `interact.js`, `harvest.js`, `navigate.js`, `screenshot.js` — ESM modules
- `shared/browser.js`, `upload.js`, `screenshot.js`, `adblocker.js` — shared utilities

**Profile isolation:** Agent connects to `/mcp/{profile}/sse`. Server registers only that profile's tools. The LLM physically cannot call tools outside its profile.

**Python MCP client built** in `src/tools/mcp_client.py`:
```python
async with agent_tools("hosting", settings) as tools:
    # tools = [inspect, interact, harvest, screenshot, navigate]
```
Uses `langchain-mcp-adapters` (`MultiServerMCPClient`) to convert MCP tools to LangChain `BaseTool` objects.

---

## Phase 4 — Orchestrator Design

**Question asked:** Why not give the orchestrator a prompt? Can it use a small model?

**Design finalised:**
- Orchestrator is an LLM agent — it gets a system prompt and uses `run_agent_loop()`
- Uses `gemini-2.5-flash-lite` (cheap, fast — only routes and coordinates)
- Sub-agents use `gemini-2.5-flash` (strong reasoning + vision for browser work)
- Sub-agents are wrapped as `BaseTool` objects — orchestrator treats them like any other tool

**Agent-as-tool pattern:**
```python
class _HostingTool(BaseTool):
    async def _arun(self, url: str) -> str:
        result = await HostingPageAgent(settings).run(url=url)
        return result.model_dump_json()
```

**Result reconstruction:** After the loop, `_build_pipeline_result()` replays all `ToolMessage` objects in the message history to reconstruct the `PipelineResult` — no separate state machine needed.

**6-tool orchestrator:**
1. `classify_page` → ClassificationAgent
2. `run_landing_agent` → LandingPageAgent
3. `run_hosting_agent` → HostingPageAgent (called N times)
4. `run_embedded_agent` → EmbeddedPageAgent
5. `analyze_providers` → IPInfoTool
6. `generate_takedown_emails` → EmailTool

---

## Phase 5 — IPInfo + Email as Orchestrator Tools

**Decision:** IPInfo lookup and DMCA email generation happen as orchestrator tool calls (not post-processing). This means:
- The orchestrator's message history contains the analysis results
- The LLM can use provider info to decide if more extraction is needed
- Everything is in one coherent loop

**`IPInfoTool` built:** `src/tools/ipinfo_tool.py` + `src/utils/ipinfo.py`
- Resolves hostname → IP → org/country/abuse_email via ipinfo.io API
- Deduplicates by hostname (one query per unique CDN)
- Free tier: 50k/month without token

**`EmailTool` built:** `src/tools/email_tool.py` + `src/agents/email_generator.py`
- Deterministic (no LLM) — groups streams by CDN provider, fills DMCA template
- One email per CDN provider with stream URLs + Cloudinary screenshots as evidence

---

## Phase 6 — Async Conversion + Per-Model Config

**Settings updated** (`src/utils/config.py`):
- `orchestrator_model` = `gemini-2.5-flash-lite-preview-05-20`
- `agent_model` = `gemini-2.5-flash-preview-05-20`
- `mcp_server_url` = `http://localhost:3000`
- `ipinfo_token` = (optional)

**All agents converted to async:**
- `ClassificationAgent.run()` → `async def run()`
- `LandingPageAgent.run()` → `async def run()`
- `HostingPageAgent.run()` → `async def run()`
- `EmbeddedPageAgent.run()` → `async def run()` (replaced old `JSToolBridge` imports)
- `OrchestratorAgent.run()` → `async def run()`
- `run_pipeline()` → `async def run_pipeline()`

**Orchestrator sub-agent tool wrappers updated:**
```python
# Before: _run() calling sync agent
def _run(self, url: str) -> str:
    return HostingPageAgent(settings).run(url=url).model_dump_json()

# After: _arun() awaiting async agent
async def _arun(self, url: str) -> str:
    result = await HostingPageAgent(settings).run(url=url)
    return result.model_dump_json()
```

**FastAPI endpoints updated to `async def`:**
```python
@app.post("/classify")
async def classify(req: ClassifyRequest):
    return await ClassificationAgent(settings).run(url=req.url)
```

---

## Phase 7 — Single Container

**Decision:** Collapse all services into one Docker container.

**Architecture:**
- Base: `python:3.11-bookworm`
- Added: `supervisor`, `postgresql-15`, Node.js 20, Google Chrome stable
- Python deps via `uv`
- Node deps via `npm ci`
- Process manager: `supervisord` (chrome → mcp → api + gradio)
- PostgreSQL: started in `scripts/entrypoint.sh` before supervisord

**Files created/updated:**
- `Dockerfile` — single-stage, all-in-one
- `configs/supervisord.conf` — 4 programs (chrome, mcp, api, gradio)
- `scripts/entrypoint.sh` — pg init + supervisord exec
- `docker-compose.yml` — single `owc` service with `shm_size: 2gb`
- `src/storage/database.py` — `connect_args` now conditional on SQLite vs PostgreSQL
- `src/api/gradio_app.py` — `asyncio.run()` wrappers for async agents
- `pyproject.toml` — added `gradio>=4.36`, `psycopg2-binary>=2.9`, `langchain-mcp-adapters>=0.1`

**Scripts created:**
- `scripts/build.sh` — build with cache
- `scripts/build-nocache.sh` — full fresh build
- `scripts/start.sh` — run container with volumes + env
- `scripts/stop.sh` — stop container
- `scripts/restart.sh` — restart without rebuild
- `scripts/clean.sh` — full cleanup with prompts
- `scripts/test.sh` — run pytest inside running container

**`.gitattributes` added** to enforce LF line endings on `.sh` files (prevents Windows CRLF corruption).

---

## Phase 8 — Documentation

Created comprehensive documentation structure in `docs/`:

```
docs/
├── README.md               Master index
├── architecture/
│   ├── overview.md         System architecture + tech decisions
│   ├── agents.md           All 5 agents in depth
│   ├── mcp-server.md       MCP server + tool isolation
│   └── data-flow.md        End-to-end pipeline + schemas
├── setup/
│   ├── quickstart.md       5-minute start guide
│   ├── configuration.md    All env vars + settings
│   └── docker.md           Container setup + scripts
├── api/
│   ├── fastapi.md          REST API reference
│   └── gradio.md           Dashboard guide
├── tools/
│   ├── browser-tools.md    inspect/interact/harvest/navigate/screenshot
│   └── python-tools.md     mcp_client/ipinfo/email tools
└── changelog/
    ├── progress.md         ← this file
    └── issues.md           Bugs + resolutions
```

---

## Current State

| Component | Status |
|-----------|--------|
| MCP server (Node.js) | ✅ Complete |
| 5 browser tools | ✅ Complete |
| `run_agent_loop()` (async) | ✅ Complete |
| ClassificationAgent | ✅ Complete |
| LandingPageAgent | ✅ Complete |
| HostingPageAgent | ✅ Complete |
| EmbeddedPageAgent | ✅ Complete |
| OrchestratorAgent | ✅ Complete |
| IPInfoTool | ✅ Complete |
| EmailTool | ✅ Complete |
| FastAPI REST API | ✅ Complete |
| Gradio dashboard | ✅ Complete |
| PostgreSQL storage | ✅ Complete |
| Single-container Docker | ✅ Complete |
| Management scripts | ✅ Complete |
| LangSmith tracing | ✅ Configured (enabled by default) |
| Documentation | ✅ Complete |
| Tests | 🔄 Stubs exist, need updating for async + MCP |

---

*See [Issues & Resolutions](issues.md) for bugs encountered during this build.*
