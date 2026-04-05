# Configuration Reference

> **See also:** [Quickstart](quickstart.md) · [Docker & Scripts](docker.md) · [← Docs Home](../README.md)

All configuration is loaded by [`src/utils/config.py`](../../src/utils/config.py) using
`pydantic-settings`. Values are read from (in priority order):

1. Environment variables
2. `.env` file
3. `configs/settings.yaml`
4. Hardcoded defaults

---

## Required Variables

These must be set in `.env` or the environment before starting the container.

| Variable | Description |
|----------|-------------|
| `GOOGLE_API_KEY` | Google AI Studio API key for Gemini models |
| `LANGCHAIN_API_KEY` | LangSmith API key (required when tracing is enabled) |
| `CLOUDINARY_CLOUD_NAME` | Cloudinary cloud name for screenshot hosting |
| `CLOUDINARY_API_KEY` | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | Cloudinary API secret |

---

## LLM Models

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCHESTRATOR_MODEL` | `gemini-2.5-flash-lite-preview-05-20` | Model for the orchestrator (routing only — uses cheap/fast model) |
| `AGENT_MODEL` | `gemini-2.5-flash-preview-05-20` | Model for all sub-agents (classification, landing, hosting, embedded) |
| `GEMINI_TEMPERATURE` | `0.0` | Temperature for all Gemini calls (0 = deterministic) |

> Why two models? The orchestrator only makes routing decisions — it never touches the
> browser. Flash-Lite is 10× cheaper. Sub-agents do heavy lifting (tool-calling loops,
> vision), so they use the full Flash model.

---

## LangSmith Tracing

| Variable | Default | Description |
|----------|---------|-------------|
| `LANGCHAIN_TRACING_V2` | `true` | Enable/disable LangSmith tracing |
| `LANGCHAIN_API_KEY` | `""` | Your LangSmith API key |
| `LANGCHAIN_PROJECT` | `open-web-catcher` | Project name in LangSmith |

When `LANGCHAIN_TRACING_V2=true` and `LANGCHAIN_API_KEY` is set, every LLM invocation
and tool call is automatically traced. To disable tracing without removing the key,
set `LANGCHAIN_TRACING_V2=false`.

---

## Internal Services

These have correct defaults for the single-container setup.
Only change them if you're running services on different hosts.

| Variable | Default | Description |
|----------|---------|-------------|
| `BROWSER_WS_ENDPOINT` | `ws://localhost:9222` | Chrome DevTools WebSocket endpoint |
| `MCP_SERVER_URL` | `http://localhost:3000` | MCP tool server base URL |
| `DATABASE_URL` | `postgresql+psycopg2://owc:owc@localhost:5432/owc` | SQLAlchemy database URL |

> For local development outside Docker, set `DATABASE_URL=sqlite:///./data/open_web_catcher.db`
> to use SQLite instead of PostgreSQL.

---

## Agent Budgets

Controls how many tool calls each agent is allowed before being forced to output a final answer.

| Variable | Default | Agent |
|----------|---------|-------|
| `CLASSIFICATION_MAX_TOOL_CALLS` | `5` | ClassificationAgent |
| `LANDING_PAGE_MAX_TOOL_CALLS` | `50` | LandingPageAgent |
| `HOSTING_PAGE_MAX_TOOL_CALLS` | `20` | HostingPageAgent |
| `EMBEDDED_PAGE_MAX_TOOL_CALLS` | `20` | EmbeddedPageAgent |
| `ORCHESTRATOR_MAX_TOOL_CALLS` | `60` | OrchestratorAgent |

Budget formula for orchestrator:
```
1 classify + 1 landing + N hosting (≤10) + M embedded (≤10) + 2 analysis tools + buffer = 60
```

---

## Timeouts

| Variable | Default | Description |
|----------|---------|-------------|
| `TOOL_TIMEOUT_SECONDS` | `30` | Max seconds per MCP tool call |
| `AGENT_TIMEOUT_SECONDS` | `300` | Max seconds for a complete agent run |

---

## Logging

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `INFO` | Python log level (`DEBUG`, `INFO`, `WARNING`, `ERROR`) |
| `LOG_FILE` | `data/logs/app.log` | Log file path (relative to `/app` in container) |

Service-specific logs are also written by supervisord:

| Log file | Process |
|----------|---------|
| `data/logs/chrome.log` | Chrome headless |
| `data/logs/mcp.log` | MCP Node.js server |
| `data/logs/api.log` | FastAPI / uvicorn |
| `data/logs/gradio.log` | Gradio dashboard |
| `data/logs/supervisord.log` | supervisord itself |

---

## IPInfo

| Variable | Default | Description |
|----------|---------|-------------|
| `IPINFO_TOKEN` | `""` | IPInfo API token. Empty = use free tier (50k/month) |

---

## `configs/settings.yaml`

You can override any of the above settings in `configs/settings.yaml` without touching
the environment. This file is volume-mounted read-only into the container:

```yaml
# configs/settings.yaml
orchestrator_model: gemini-2.5-flash-preview-05-20  # promote orchestrator to full model
landing_page_max_tool_calls: 30                      # reduce budget for faster runs
log_level: DEBUG
```

Changes to `settings.yaml` take effect on the next agent invocation
(settings are loaded at request time, not at startup).

---

## Agent Prompts

Prompts are versioned markdown files in `configs/prompts/`. They are loaded at agent
instantiation time from the file system.

| File | Agent |
|------|-------|
| `configs/prompts/classification_v1.md` | ClassificationAgent |
| `configs/prompts/landing_page_v1.md` | LandingPageAgent |
| `configs/prompts/hosting_page_v1.md` | HostingPageAgent |
| `configs/prompts/embedded_page_v1.md` | EmbeddedPageAgent |
| `configs/prompts/orchestrator_v1.md` | OrchestratorAgent |

To A/B test a prompt, create `hosting_page_v2.md` and update `PROMPT_PATH` in
`src/agents/hosting_page.py`. The `configs/` directory is volume-mounted, so you can
swap prompts without rebuilding the container.

---

*Next: [Docker & Scripts](docker.md) | [Quickstart](quickstart.md)*
