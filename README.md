# Open Web Catcher

Multi-agent AI pipeline for extracting streaming URLs from illegal streaming websites and generating evidence packages for hosting provider takedown requests.

## Architecture overview

```
                         ┌──────────────────┐
                         │    Input URL      │
                         └────────┬─────────┘
                                  │
                    ┌─────────────▼──────────────┐
                    │   LangGraph Orchestrator    │
                    │   (state machine pipeline)  │
                    └─────────────┬──────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
   ┌──────────▼─────────┐ ┌──────▼───────┐ ┌────────▼────────┐
   │  Classification    │ │  Hosting     │ │  Embedded       │
   │  (LangChain chain) │ │  (ReAct)     │ │  (ReAct)        │
   └──────────┬─────────┘ └──────┬───────┘ └────────┬────────┘
              │                   │                   │
              │            ┌──────▼───────┐           │
              │            │  Landing     │           │
              │            │  (ReAct)     │           │
              │            └──────────────┘           │
              │                                       │
              └───────────────┬───────────────────────┘
                              │
                   ┌──────────▼──────────┐
                   │  JS Tool Bridge     │
                   │  (Node.js subprocess)│
                   └──────────┬──────────┘
                              │
                   ┌──────────▼──────────┐
                   │  Puppeteer + CDP    │
                   │  (headless browser)  │
                   └─────────────────────┘
```

### What runs where

| Component | Framework | Why |
|-----------|-----------|-----|
| **Orchestrator** | LangGraph | State machine with conditional routing (page_type → correct agent). Manages pipeline state across agents. |
| **Classification Agent** | LangChain chain + `bind_tools` | Mostly single-shot LLM classification. Optional tool calls for low-confidence pages. Not a full agent loop. |
| **Landing Page Agent** | LangChain `create_react_agent` | ReAct tool-calling loop. LLM decides inspect/interact/navigate per turn. 50-call budget. |
| **Hosting Page Agent** | LangChain `create_react_agent` | ReAct loop. OBSERVE→STATE→PLAN reasoning. Server cycling. 20-call budget. |
| **Embedded Page Agent** | LangChain `create_react_agent` | ReAct loop. Coordinates clicking, iframe traversal. 20-call budget. |
| **Tools** | Node.js subprocess via Python bridge | JS tools (inspect, interact, harvest, navigate, screenshot) run as standalone scripts called via `subprocess.run()`. |
| **Evaluation** | LangSmith + pytest + local metrics | Prompt regression testing, agent tracing, token/cost/success metrics. |
| **Demo UI** | Gradio | Test individual agents, run full pipeline, view results + screenshots. |

### LLM integration

- **Model**: Google Gemini Flash via `langchain-google-genai`
- **Vision**: Screenshots uploaded to Cloudinary, URLs passed to LLM as image context
- **Prompts**: Versioned markdown files in `configs/prompts/`, loaded at runtime

### Tool bridge pattern

Python agents don't run Puppeteer directly. Each JS tool is a standalone Node.js
script that:

1. Receives `{browserWSEndpoint, ...params}` as a JSON CLI argument
2. Connects to a shared headless browser via `puppeteer.connect()`
3. Executes its logic (DOM scan, click, network intercept, etc.)
4. Prints a JSON result to stdout

The Python `JSToolBridge` class calls `subprocess.run(["node", "tool.js", json])`,
parses the stdout JSON, and returns it to the LangChain tool wrapper.

```
Python Agent                    Node.js Tool
    │                               │
    │  subprocess.run(["node",      │
    │    "inspect.js", "{...}"])     │
    │──────────────────────────────▶│
    │                               │  puppeteer.connect(wsEndpoint)
    │                               │  page.evaluate(...)
    │                               │  cdp.send(...)
    │       stdout: JSON result     │
    │◀──────────────────────────────│
    │                               │
    │  parse JSON → return to LLM   │
```

---

## Project structure

```
open-web-catcher/
│
├── src/                          # ── Python source ──
│   │
│   ├── main.py                   # CLI entry point (typer)
│   │
│   ├── agents/                   # Agent definitions
│   │   ├── __init__.py
│   │   ├── base.py               # Shared agent config (LLM, callbacks, budget)
│   │   ├── classification.py     # LangChain chain + bind_tools
│   │   ├── landing_page.py       # ReAct agent (create_react_agent)
│   │   ├── hosting_page.py       # ReAct agent with server cycling
│   │   ├── embedded_page.py      # ReAct agent with coordinates mode
│   │   └── orchestrator.py       # LangGraph state machine (routes between agents)
│   │
│   ├── tools/                    # LangChain tool wrappers → JS bridge
│   │   ├── __init__.py
│   │   ├── bridge.py             # JSToolBridge: subprocess runner for Node.js tools
│   │   ├── inspect_tool.py       # InspectTool(BaseTool)
│   │   ├── interact_tool.py      # InteractTool(BaseTool)
│   │   ├── harvest_tool.py       # HarvestTool(BaseTool)
│   │   ├── navigate_tool.py      # NavigateTool(BaseTool)
│   │   └── screenshot_tool.py    # ScreenshotTool(BaseTool)
│   │
│   ├── models/                   # Pydantic data models
│   │   ├── __init__.py
│   │   ├── schemas.py            # ClassificationResult, ExtractionResult, ServerResult, etc.
│   │   └── enums.py              # PageType, Confidence, ExtractionStatus, AgentType
│   │
│   ├── memory/                   # Memory layers
│   │   ├── __init__.py
│   │   ├── short_term.py         # Per-run: ConversationBufferWindowMemory wrapper
│   │   └── long_term.py          # Cross-run: SQLite-backed pattern storage
│   │
│   ├── evaluation/               # Testing, metrics, tracing
│   │   ├── __init__.py
│   │   ├── metrics.py            # MetricsCollector: tokens, timing, success rates, failure modes
│   │   ├── tracing.py            # LangSmith callback setup + local fallback
│   │   └── datasets.py           # Test dataset loader, golden test cases
│   │
│   ├── storage/                  # Data persistence
│   │   ├── __init__.py
│   │   ├── database.py           # SQLAlchemy models + session management
│   │   └── repositories.py       # CRUD operations for runs, results, metrics
│   │
│   ├── utils/                    # Shared utilities
│   │   ├── __init__.py
│   │   ├── config.py             # pydantic-settings: loads .env + settings.yaml
│   │   ├── logging.py            # Structured logging (rich console + JSON file)
│   │   └── browser.py            # Browser lifecycle: launch, connect, health check
│   │
│   └── api/                      # User interfaces
│       ├── __init__.py
│       └── gradio_app.py         # Gradio dashboard: per-agent testing + full pipeline demo
│
├── tools_js/                     # ── JavaScript tools (Node.js) ──
│   ├── package.json              # puppeteer-core, express, zod, Cloudinary
│   ├── inspect.js                # DOM scan + element extraction + screenshot
│   ├── interact.js               # Click/play/type/select/coordinates + anti-bot
│   ├── harvest.js                # 6-layer CDP stream detection
│   ├── navigate.js               # URL navigation + redirect handling
│   ├── screenshot.js             # Quick screenshot capture
│   └── shared/                   # Shared JS modules (extracted from duplicated code)
│       ├── browser.js            # puppeteer.connect() wrapper
│       ├── upload.js             # Cloudinary upload with timeout
│       ├── screenshot.js         # screenshotFull / screenshotViewport / screenshotPlayer
│       └── adblocker.js          # Ghostery-backed adblocker with cached filterlists
│
├── configs/                      # ── Configuration ──
│   ├── settings.yaml             # Runtime config (budgets, timeouts, model params)
│   └── prompts/                  # Versioned agent prompts (loaded at runtime)
│       ├── classification_v1.md
│       ├── landing_page_v1.md
│       ├── hosting_page_v1.md
│       └── embedded_page_v1.md
│
├── tests/                        # ── Test suite ──
│   ├── conftest.py               # Shared fixtures (mock browser, mock tools)
│   ├── test_tools.py             # Unit tests for each tool wrapper
│   ├── test_agents.py            # Integration tests per agent
│   ├── test_orchestrator.py      # Pipeline routing tests
│   ├── test_prompts.py           # Prompt regression tests (LangSmith or local)
│   └── test_schemas.py           # Pydantic model validation tests
│
├── data/                         # ── Data (gitignored except structure) ──
│   ├── raw/                      # Raw agent outputs per run
│   ├── processed/                # Cleaned CSVs for analysis
│   ├── reports/                  # Generated analysis reports
│   ├── test_cases/               # Golden test URLs + expected results
│   │   └── sites.json            # {"url": "...", "expected_type": "landing_page", ...}
│   └── logs/                     # Structured JSON log files
│
├── notebooks/                    # ── Jupyter notebooks (DS deliverables) ──
│   ├── 01_data_exploration.ipynb       # Dataset overview, site distribution
│   ├── 02_success_rate_analysis.ipynb  # Success rates by site type, failure mode breakdown
│   ├── 03_token_cost_analysis.ipynb    # Token usage per agent, cost optimization
│   ├── 04_prompt_comparison.ipynb      # A/B prompt testing results
│   └── 05_model_comparison.ipynb       # Gemini Flash vs Pro vs other models
│
├── scripts/                      # ── Utility scripts ──
│   ├── docker/                   # Docker lifecycle helpers + container entrypoint
│   │   ├── build.ps1             # Build image (add -NoCache for fresh builds)
│   │   ├── start.ps1             # Run container with volumes + env
│   │   ├── stop.ps1              # Stop container
│   │   ├── restart.ps1           # Restart container
│   │   ├── clean.ps1             # Cleanup container/image/build cache
│   │   ├── test.ps1              # Run pytest inside running container
│   │   └── entrypoint.sh         # In-container startup script (PostgreSQL + supervisord)
│   ├── extract_tools_from_n8n.py # Extract JS code from n8n workflow JSON files
│   ├── run_batch.py              # Batch process a list of URLs
│   ├── export_metrics.py         # Export metrics to CSV for notebook analysis
│   └── migrate_db.py             # Database migration script
│
├── docker-compose.yml            # Multi-container: python + node + chrome
├── Dockerfile                    # Python application
├── Dockerfile.tools              # Node.js tools + headless Chrome
├── pyproject.toml                # Python dependencies + project metadata
├── .env.example                  # Environment variable template
├── .gitignore
└── README.md
```

---

## Key design decisions

### Why subprocess instead of rewriting tools in Python?

The 5 JS tools represent ~4,000 lines of battle-tested, iterated code (inspect: 792 lines,
interact: 807 lines, harvest: 696 lines). Rewriting in Playwright/Python would take weeks
and introduce new bugs. The subprocess bridge adds ~50ms overhead per call, which is
negligible compared to the 3-30 second tool execution times.

### Why separate ReAct agents instead of one big agent?

Each page type has different tools, different budgets, and different reasoning patterns.
The Landing Page Agent explores and discovers (50 calls, no harvest). The Hosting Page
Agent extracts streams from a known page (20 calls, uses harvest). Mixing them into one
agent would bloat the prompt and confuse tool selection.

### Why LangGraph for orchestration but not for individual agents?

The orchestrator is a state machine: classify → route → extract → enrich. Each transition
is conditional on the previous result. LangGraph's `StateGraph` with conditional edges
models this naturally.

Individual agents are simpler: they run a ReAct loop until done. `create_react_agent`
handles this with less boilerplate than a full LangGraph graph.

### Why Gradio?

Quick demo UI without frontend development. Test individual agents with specific URLs,
view screenshots inline, inspect tool call traces, and show results to supervisors.
Can be extended later with batch processing, comparison views, etc.

---

## Docker setup

```yaml
# docker-compose.yml has 3 services:
#
# 1. chrome    - headless Chrome with remote debugging
# 2. tools     - Node.js tools server (or just the runtime for subprocess calls)
# 3. app       - Python application (agents + Gradio UI)
```

### Running locally (no Docker)

```bash
# Terminal 1: Start headless Chrome
google-chrome --headless --remote-debugging-port=9222 --no-sandbox

# Terminal 2: Install and run
pip install -e ".[dev]"
cd tools_js && npm install && cd ..
python -m src.main --url "https://example-site.com"

# Or launch Gradio
python -m src.api.gradio_app
```

### Running with Docker Compose

```bash
cp .env.example .env  # configure API keys
docker compose up --build

# Gradio UI available at http://localhost:7860
```

---

## Development workflow

```bash
# Run all tests
pytest tests/ -v

# Run with LangSmith tracing enabled
LANGCHAIN_TRACING_V2=true LANGCHAIN_API_KEY=xxx python -m src.main --url "..."

# Run prompt regression tests only
pytest tests/test_prompts.py -v

# Export metrics for notebook analysis
python scripts/export_metrics.py --output data/processed/metrics.csv

# Batch process URLs
python scripts/run_batch.py --input data/test_cases/sites.json --output data/raw/
```

---

## Evaluation strategy

### Metrics collected per run

| Metric | Source | Purpose |
|--------|--------|---------|
| Token usage (in/out/total) | LangChain callbacks | Cost analysis, prompt optimization |
| Tool calls per agent | Agent loop counter | Budget efficiency |
| Duration per tool call | JSToolBridge timing | Performance bottleneck identification |
| Success/failure per server | ExtractionResult | Success rate calculation |
| Failure mode category | Manual + automated | site_dead / agent_error / timeout / redirect |
| Streams found per site | Pipeline output | Primary success metric |

### Prompt testing

Two methods supported:

1. **LangSmith** (remote): Upload test datasets, run evaluations, compare prompt versions
   with automated scoring. Set `LANGCHAIN_TRACING_V2=true`.

2. **Local pytest** (offline): Golden test cases in `data/test_cases/sites.json` with
   expected outputs. `test_prompts.py` runs each case, compares against expected
   classifications/extractions, reports pass/fail.

### Data science deliverables (notebooks)

The `notebooks/` directory contains Jupyter notebooks for:
- Success rate analysis across site types and complexity levels
- Token cost analysis per agent (identify optimization opportunities)
- Prompt A/B comparison (which prompt version performs better)
- Model comparison (Gemini Flash vs Flash-Lite vs Pro)
- Failure mode categorization and distribution
