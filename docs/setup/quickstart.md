# Quickstart

> **See also:** [Configuration](configuration.md) · [Docker & Scripts](docker.md) · [← Docs Home](../README.md)

---

## Prerequisites

- Docker Desktop (Windows/Mac) or Docker Engine (Linux)
- A Google AI Studio API key ([get one free](https://aistudio.google.com))
- A LangSmith account and API key ([langsmith.com](https://smith.langchain.com)) — for tracing
- Optional: Cloudinary account for screenshot hosting

---

## 1. Clone & Configure

```bash
git clone https://github.com/your-org/open-web-catcher.git
cd open-web-catcher

# Copy the example env file
cp .env.example .env
```

Edit `.env` — at minimum you need:

```env
GOOGLE_API_KEY=your_google_api_key_here
LANGCHAIN_API_KEY=your_langsmith_api_key_here
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_cloudinary_api_key
CLOUDINARY_API_SECRET=your_cloudinary_api_secret
```

See [Configuration](configuration.md) for all available variables.

---

## 2. Build the Container

```bash
# With layer cache (faster on rebuild)
bash scripts/build.sh

# First build or clean slate
bash scripts/build-nocache.sh
```

The build installs Python (via `uv`), Node.js, Google Chrome, and PostgreSQL 15
into a single image. First build takes 3–5 minutes; rebuilds with cache take ~30s
when only Python source changes.

---

## 3. Start

```bash
bash scripts/start.sh
```

This runs the container with:
- Port `8000` → FastAPI REST API
- Port `7860` → Gradio dashboard
- `./data/` volume → persisted database + logs
- `./configs/` volume → hot-swappable agent prompts

Wait ~15 seconds for all services to start. Check with:

```bash
curl http://localhost:8000/health
# → {"status":"ok","orchestrator_model":"gemini-2.5-flash-lite-preview-05-20","agent_model":"gemini-2.5-flash-preview-05-20"}
```

---

## 4. Use It

### Option A — Gradio Dashboard (easiest)

Open **http://localhost:7860** in your browser.

Tabs available:
- **Full Pipeline** — submit any URL, get classification + streams + screenshots + emails
- **Classification** — test just the classification agent
- **Landing / Hosting / Embedded** — test individual extraction agents

### Option B — REST API

```bash
# Full pipeline
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example-streaming-site.com/match/123"}'

# Classification only
curl -X POST http://localhost:8000/classify \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example-streaming-site.com"}'
```

See the [API docs](http://localhost:8000/docs) for all endpoints, or the [FastAPI reference](../api/fastapi.md).

### Option C — Direct Python (for development)

```bash
# Activate the venv (inside the container or after local install)
source .venv/bin/activate

# Run a single URL
python -c "
import asyncio
from src.agents.orchestrator import run_pipeline
from src.utils.config import Settings
result = asyncio.run(run_pipeline('https://...', Settings.from_yaml()))
print(result.model_dump_json(indent=2))
"
```

---

## 5. View Traces in LangSmith

If `LANGCHAIN_TRACING_V2=true` and `LANGCHAIN_API_KEY` is set, every run is automatically
traced to your LangSmith project `open-web-catcher`.

Open [smith.langchain.com](https://smith.langchain.com) → your project → see every
LLM call, tool call, token count, and cost.

---

## 6. Stop / Restart / Clean

```bash
bash scripts/stop.sh       # stop the container
bash scripts/restart.sh    # restart without rebuilding
bash scripts/clean.sh      # stop + remove container (prompts before removing image)
```

---

## 7. Run Tests

```bash
# Tests run inside the container (no separate test environment needed)
bash scripts/test.sh

# Run a specific test file
bash scripts/test.sh tests/test_agents.py

# Filter by test name
bash scripts/test.sh -k "classification"
```

---

## What Happens on First Boot?

The container's [entrypoint script](../../scripts/entrypoint.sh) runs once at startup:

1. Initialises the PostgreSQL 15 cluster (if not already done)
2. Creates the `owc` database role and `owc` database (idempotent)
3. Creates `data/logs/`, `data/raw/`, etc.
4. Hands off to `supervisord`, which starts (in order):
   - Chrome (headless, port 9222)
   - MCP server (Node.js, port 3000)
   - FastAPI (uvicorn, port 8000)
   - Gradio (port 7860)

---

*Next: [Configuration](configuration.md) | [Docker & Scripts](docker.md)*
