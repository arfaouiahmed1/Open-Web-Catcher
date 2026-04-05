# Open Web Catcher — Documentation Hub

> Multi-agent AI pipeline: classify illegal streaming pages → extract stream URLs → analyze CDN providers → generate DMCA takedown emails.

---

## Navigation

### Architecture
| Doc | What it covers |
|-----|---------------|
| [System Overview](architecture/overview.md) | Components, tech stack, why each choice was made |
| [Agents](architecture/agents.md) | Classification, Landing, Hosting, Embedded, Orchestrator — design + prompt strategy |
| [MCP Server & Browser Tools](architecture/mcp-server.md) | Node.js MCP server, Puppeteer tools, profile isolation |
| [Data Flow](architecture/data-flow.md) | End-to-end pipeline: URL in → takedown emails out, with JSON schemas |

### Setup & Operations
| Doc | What it covers |
|-----|---------------|
| [Quickstart](setup/quickstart.md) | Running the container in 5 minutes |
| [Configuration](setup/configuration.md) | All environment variables + `settings.yaml` reference |
| [Docker & Scripts](setup/docker.md) | Single-container architecture, `scripts/` reference, supervisord |

### API Reference
| Doc | What it covers |
|-----|---------------|
| [REST API (FastAPI)](api/fastapi.md) | All HTTP endpoints with request/response schemas |
| [Gradio Dashboard](api/gradio.md) | Dashboard tabs, how to use each agent panel |

### Tools Reference
| Doc | What it covers |
|-----|---------------|
| [Browser Tools](tools/browser-tools.md) | `inspect`, `interact`, `harvest`, `navigate`, `screenshot` |
| [Python Tools](tools/python-tools.md) | `mcp_client`, `ipinfo_tool`, `email_tool` |

### Changelog
| Doc | What it covers |
|-----|---------------|
| [Progress Log](changelog/progress.md) | Chronological build history, milestones, decisions |
| [Issues & Resolutions](changelog/issues.md) | Bugs, architectural wrong turns, and how they were fixed |

---

## Project at a Glance

```
User submits URL
       │
       ▼
┌─────────────────────────────────────────────────────┐
│                  OrchestratorAgent                  │
│          (gemini-2.5-flash-lite — routing)          │
│                                                     │
│  1. classify_page()     → ClassificationAgent       │
│  2. run_landing_agent() → LandingPageAgent          │
│  3. run_hosting_agent() → HostingPageAgent (×N)     │
│  4. run_embedded_agent()→ EmbeddedPageAgent (×M)    │
│  5. analyze_providers() → IPInfo lookup             │
│  6. generate_takedown_emails() → DMCA notices       │
└─────────────────────────────────────────────────────┘
       │
       ▼
 PipelineResult
  ├── classification  (page_type, confidence)
  ├── matches[]       (hosting page URLs found)
  ├── extraction_results[] (streams + screenshots per server)
  ├── provider_analysis[]  (IP, org, country, abuse email)
  └── takedown_emails[]    (one DMCA notice per CDN provider)
```

### Key Technical Choices

| Decision | Choice | Why |
|----------|--------|-----|
| LLM client | `langchain-google-genai` + Gemini | Native function calling via `bind_tools()` |
| Agent loop | Custom `run_agent_loop()` | Full budget control, no ReAct text format overhead |
| Browser automation | Puppeteer (Node.js) | Battle-tested, CDP access for stream interception |
| Tool protocol | MCP (Model Context Protocol) | Profile-based tool isolation per agent |
| Orchestrator | LLM agent with sub-agents as tools | Flash-Lite routes cheaply; sub-agents do heavy lifting |
| Container | Single Docker container | Postgres + Chrome + MCP + API + Gradio in one place |
| Python packaging | `uv` | 10-100× faster than pip |

---

## Repository Layout

```
open-web-catcher/
├── src/                  Python source (agents, tools, API, storage)
│   ├── agents/           Classification · Landing · Hosting · Embedded · Orchestrator
│   ├── api/              FastAPI app · Gradio dashboard
│   ├── models/           Pydantic schemas + enums
│   ├── storage/          SQLAlchemy + PostgreSQL
│   ├── tools/            MCP client · IPInfo · Email generator
│   └── utils/            Config · Logging · IPInfo HTTP client
├── tools_js/             Node.js MCP server + 5 Puppeteer tool handlers
├── configs/              settings.yaml · supervisord.conf · agent prompts/
├── scripts/              build · start · stop · restart · clean · test
├── tests/                pytest suite (unit + integration)
├── docs/                 ← you are here
│   ├── architecture/
│   ├── setup/
│   ├── api/
│   ├── tools/
│   └── changelog/
├── data/                 logs · raw outputs · reports (gitignored)
├── notebooks/            Jupyter DS deliverables
├── Dockerfile            Single all-in-one container
├── docker-compose.yml    One-service compose file
└── pyproject.toml        Python deps (managed by uv)
```

---

*All docs are interlinked. Start with [Architecture Overview](architecture/overview.md) if you're new to the project, or [Quickstart](setup/quickstart.md) if you just want to run it.*
