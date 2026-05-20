# System Architecture

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [System Index](./README.md) | Next: [LangChain And LangGraph](./langchain-langgraph.md)

Open Web Catcher is an agentic evidence-collection system for streaming sites. The operator starts workflow or single-agent runs from the Next.js console. The FastAPI backend schedules background jobs, creates a runtime trace, executes LangGraph/LangChain agents, calls profile-scoped MCP browser tools, persists normalized records in Postgres, and exposes run-detail payloads back to the UI.

## Component Diagram

```mermaid
flowchart TB
  subgraph UI["Operator Console"]
    Next["Next.js app<br/>routes: /, /live, /runs, /runs/[runId], /settings, /providers"]
    RunDetail["RunDetailPage<br/>RunDetailLive<br/>Agent desk graph"]
    Settings["Settings UI<br/>models, browser, tools, pricing"]
  end

  subgraph Backend["FastAPI Backend"]
    App["src/api/app.py"]
    DatasetAPI["src/api/datasets.py"]
    ProviderConfig["src/api/provider_config.py"]
    Background["background job runner<br/>workflow and agent jobs"]
    Registry["run_registry<br/>active traces"]
  end

  subgraph Agents["LangGraph / LangChain Runtime"]
    Orchestrator["OrchestratorAgent"]
    Classifier["ClassificationAgent"]
    Landing["LandingPageAgent"]
    Hosting["HostingPageAgent"]
    Embedded["EmbeddedPageAgent"]
    ProviderAgent["IPInfoTool"]
    EmailAgent["EmailTool"]
  end

  subgraph Tools["MCP Browser Tooling"]
    McpClient["src/tools/mcp_client.py"]
    Puppeteer["Puppeteer MCP<br/>profiles + browser tools"]
    Playwright["Playwright MCP<br/>profiles + browser tools"]
    SharedPolicy["shared browser policy<br/>proxy, runtime, errors"]
  end

  subgraph Data["Persistence And External Services"]
    DB[("Postgres")]
    Gemini["Google GenAI / Gemini"]
    IPInfo["IPInfo + RDAP"]
    Cloudinary["Cloudinary screenshot storage"]
    DataDir["data/ runtime files"]
  end

  Next --> App
  RunDetail --> App
  Settings --> ProviderConfig
  App --> Background
  Background --> Registry
  Background --> Orchestrator
  Orchestrator --> Classifier
  Orchestrator --> Landing
  Orchestrator --> Hosting
  Orchestrator --> Embedded
  Orchestrator --> ProviderAgent
  Orchestrator --> EmailAgent
  Classifier --> Gemini
  Landing --> Gemini
  Hosting --> Gemini
  Embedded --> Gemini
  Classifier --> McpClient
  Landing --> McpClient
  Hosting --> McpClient
  Embedded --> McpClient
  McpClient --> Puppeteer
  McpClient --> Playwright
  Puppeteer --> SharedPolicy
  Playwright --> SharedPolicy
  Puppeteer --> Cloudinary
  Playwright --> Cloudinary
  ProviderAgent --> IPInfo
  App --> DB
  Background --> DB
  Registry --> DB
  ProviderConfig --> DataDir
```

## Use Case Diagram

```mermaid
flowchart LR
  Operator((Operator))

  subgraph Console["Open Web Catcher Console"]
    StartRun["Start workflow run"]
    TestAgent["Test single agent"]
    InspectRun["Inspect run detail"]
    ResolveProviders["Resolve stream providers"]
    ReviewEmails["Review takedown emails"]
    ManageSettings["Manage models, pricing, tools, browser runtime"]
    ManageDatasets["Manage datasets and batch runs"]
  end

  Operator --> StartRun
  Operator --> TestAgent
  Operator --> InspectRun
  Operator --> ResolveProviders
  Operator --> ReviewEmails
  Operator --> ManageSettings
  Operator --> ManageDatasets

  StartRun --> InspectRun
  TestAgent --> InspectRun
  InspectRun --> ResolveProviders
  ResolveProviders --> ReviewEmails
  ManageSettings --> StartRun
  ManageDatasets --> StartRun
```

## Backend Module Map

```mermaid
flowchart TB
  subgraph API["src/api"]
    App["app.py<br/>runtime routes and background jobs"]
    Datasets["datasets.py<br/>dataset CRUD and batch runs"]
    ProviderConfig["provider_config.py<br/>settings/model payloads"]
  end

  subgraph Runtime["src/agents"]
    Base["base.py<br/>LLM/tool loop"]
    Cache["cache.py<br/>Gemini + tool cache"]
    Prompting["prompting.py<br/>prompt compilation"]
    Memory["memory.py<br/>agent memory context"]
    Orchestrator["orchestrator.py<br/>LangGraph routing"]
    Specialists["classification.py<br/>landing_page.py<br/>hosting_page.py<br/>embedded_page.py"]
    Emails["email_generator.py"]
  end

  subgraph Tools["src/tools"]
    Mcp["mcp_client.py"]
    Ipinfo["ipinfo_tool.py"]
    EmailTool["email_tool.py"]
  end

  subgraph Storage["src/storage"]
    Models["models.py<br/>SQLAlchemy tables"]
    Repos["repositories.py<br/>write path"]
    UiRepo["ui_repository.py<br/>read models for console"]
    DatasetRepo["dataset_repository.py"]
  end

  subgraph Schemas["src/models"]
    Pydantic["schemas.py"]
    Enums["enums.py"]
  end

  App --> Runtime
  App --> Tools
  App --> Storage
  App --> Schemas
  Runtime --> Tools
  Runtime --> Schemas
  Storage --> Schemas
  Datasets --> DatasetRepo
  ProviderConfig --> Runtime
```

## Agent Interconnection

```mermaid
flowchart LR
  Orchestrator["OrchestratorAgent"]
  Memory["LongTermMemory<br/>soft hints"]
  Classifier["ClassificationAgent"]
  Landing["LandingPageAgent"]
  Hosting["HostingPageAgent<br/>parallel targets"]
  Embedded["EmbeddedPageAgent<br/>iframe/player targets"]
  Providers["IPInfoTool<br/>provider analysis"]
  Emails["EmailTool<br/>takedown drafts"]
  Result["PipelineResult"]

  Orchestrator --> Memory
  Orchestrator --> Classifier
  Classifier -->|"landing"| Landing
  Classifier -->|"hosting"| Hosting
  Classifier -->|"embedded"| Embedded
  Classifier -->|"unknown/other"| FinalNoStreams["analyze_providers node<br/>skips because no streams"]
  Landing -->|"hosting_pages"| Hosting
  Landing -->|"direct embedded urls"| Embedded
  Hosting -->|"embedded_url/player_iframe"| Embedded
  Hosting -->|"streams"| Providers
  Embedded -->|"streams"| Providers
  Providers --> Emails
  Emails --> Result
  Providers --> Result
  FinalNoStreams --> Result
```

## Architecture Decisions

The system is split this way because browser automation, LLM reasoning, persistence, and dashboard rendering have different failure modes.

The Next.js console does not connect to Postgres directly. It calls FastAPI endpoints through `web/lib/api.js`; FastAPI owns the database access through repository classes. This keeps the UI thin and makes run payload assembly testable from `GET /ui/runs/{run_id}`.

The browser runtime is separated into MCP tool services locally because Chrome and Playwright/Puppeteer dependencies are heavier and less predictable than the API process. In Docker Compose, this lets the backend restart independently from browser tooling and keeps tool health checks separate. For Azure Container Apps Jobs, a single-container variant can still be useful because each job is isolated and short-lived; that deployment is documented in [Azure Container Apps Job With Service Bus](../operations/azure-container-app-job-service-bus.md).

The orchestrator owns routing because routing is operationally important. If a page is unknown or inaccessible, provider analysis and email generation are skipped because there are no stream URLs to resolve. If a hosting page returns an embedded iframe, the embedded agent receives a handoff. If streams exist, provider analysis and email generation become meaningful downstream stages.

The database stores both product evidence and observability. Product evidence is stream URLs, screenshots, providers, and emails. Observability is events, model calls, tool calls, prompt compilations, and model usage. The dashboard needs both: a final answer without the failure path is not enough for debugging agent runs.

## Runtime Sequence

```mermaid
sequenceDiagram
  participant O as Operator
  participant UI as Next.js console
  participant API as FastAPI
  participant Job as BackgroundJobRepository
  participant Trace as RunObserver / run_registry
  participant Graph as Orchestrator LangGraph
  participant Agent as Specialist agents
  participant MCP as MCP browser profile
  participant LLM as Gemini
  participant DB as Postgres

  O->>UI: submit workflow URL
  UI->>API: POST /ui/workflows/run
  API->>Job: enqueue workflow job
  API-->>UI: run_id + queued job state
  API->>Trace: create active trace
  API->>Graph: run_pipeline(url, settings, observer)
  Graph->>Trace: emit pipeline_started and decisions
  Graph->>Agent: call classification / landing / hosting / embedded
  Agent->>MCP: connect profile SSE and load tools
  Agent->>LLM: prompt + tools + working state
  LLM-->>Agent: tool call or final answer
  Agent->>MCP: tool invocation
  MCP-->>Agent: DOM/network/screenshot/harvest result
  Agent-->>Graph: structured result
  Graph->>DB: persist final result and telemetry
  UI->>API: GET /ui/runs/{run_id}
  API-->>UI: run, events, calls, rollups, evidence
```

## Current Architecture Rules

- The orchestrator owns routing. Prompt text is important, but the deterministic graph and handoff builders decide which agent runs next.
- Memory is soft guidance. The orchestrator still calls classification to re-check the current page.
- Browser tools are profile-scoped. Agents only see tools registered for their MCP profile.
- The run-detail page is backend-connected. `GET /ui/runs/{run_id}` is the page-level payload, and SSE is used only for active/live updates.
- Provider and email stages run only when stream URLs exist.
- Runtime settings flow through `/ui/config`, backend settings resolution, and browser runtime bridge files before they affect agents and tools.
