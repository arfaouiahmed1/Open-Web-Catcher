# Open Web Catcher Documentation

> **Navigation:** [Docs Home](./README.md) | [System](./system/README.md) | [Workflow](./workflow/README.md) | [Agents](./agents/README.md) | [API](./api/README.md) | [Tools](./tools/README.md) | [Operations](./operations/README.md)

Open Web Catcher is a multi-agent evidence collection system for investigating unauthorized streaming pages. The operator submits a URL, the backend classifies the page, specialized agents inspect the relevant page type, browser tools collect evidence, provider analysis resolves infrastructure, and the final result is shown in a Next.js operator console.

This README is written for report and jury review. It gathers the main UML-style diagrams in one place and explains each diagram in practical terms. The deeper documentation pages remain linked in the [Documentation Index](#documentation-index).

## How To Read These Diagrams

The diagrams use Mermaid syntax inside Markdown. They are UML-style diagrams, not a separate generated model. Each diagram is grounded in the current source code and is followed by a short explanation:

- **What it shows** describes the purpose of the diagram.
- **How to read it** explains the main arrows or relationships.
- **Why it matters** explains the design decision behind the diagram.
- **Source grounding** points to the implementation files used to verify the diagram.

The active frontend screens are `/`, `/live`, `/runs`, `/runs/[runId]`, `/providers`, and `/settings`. The `/agents` route exists, but it redirects to `/live`, so it is not shown as a separate active product screen.

## Reading Order

1. [System](./system/README.md) - architecture, deployment, persistence, and runtime structure.
2. [Workflow](./workflow/README.md) - how runs start, stream events, persist evidence, and appear in the dashboard.
3. [Agents](./agents/README.md) - orchestrator, classification, landing, hosting, embedded, provider, and email responsibilities.
4. [API Contracts](./api/README.md) - FastAPI routes and operator-console payloads.
5. [MCP And Browser Tools](./tools/README.md) - browser automation tools and MCP profiles.
6. [Operations](./operations/README.md) - Docker, configuration, validation, and troubleshooting.

## 1. System Component Diagram

```mermaid
flowchart TB
  Operator((Operator))

  subgraph Frontend["Next.js Operator Console"]
    Console["Active UI routes<br/>/ /live /runs /runs/[runId] /providers /settings"]
    ApiClient["web/lib/api.js<br/>API URL builder and fetch helper"]
    RunDetail["Run detail UI<br/>Agent desk, outputs, browser frames, provider tab"]
  end

  subgraph Backend["FastAPI Backend"]
    FastAPI["src/api/app.py<br/>UI routes, public routes, background jobs"]
    DatasetAPI["src/api/datasets.py<br/>dataset sites, batches, stream"]
    ProviderConfig["src/api/provider_config.py<br/>model/provider settings"]
    Jobs["Background job runner<br/>workflow and single-agent jobs"]
    Registry["run_registry<br/>active in-memory traces"]
  end

  subgraph Runtime["LangGraph / LangChain Runtime"]
    Orchestrator["OrchestratorAgent<br/>deterministic routing"]
    Classification["ClassificationAgent"]
    Landing["LandingPageAgent"]
    Hosting["HostingPageAgent"]
    Embedded["EmbeddedPageAgent"]
    ProviderTool["IPInfoTool"]
    EmailTool["EmailTool / email generator"]
  end

  subgraph Tools["MCP Browser Tools"]
    MCPClient["src/tools/mcp_client.py"]
    Puppeteer["Puppeteer MCP server"]
    Playwright["Playwright MCP server"]
    SharedPolicy["shared browser policy<br/>proxy, runtime, error codes"]
  end

  subgraph DataAndExternal["Persistence And External Services"]
    DB[("Postgres")]
    Gemini["Google GenAI / Gemini"]
    IPInfo["IPInfo + RDAP / Whois"]
    Cloudinary["Cloudinary screenshots"]
    DataFiles["data/ runtime files<br/>memory and browser runtime state"]
  end

  Operator --> Console
  Console --> ApiClient
  ApiClient --> FastAPI
  RunDetail --> ApiClient
  FastAPI --> DatasetAPI
  FastAPI --> ProviderConfig
  FastAPI --> Jobs
  Jobs --> Registry
  Jobs --> Orchestrator
  Orchestrator --> Classification
  Orchestrator --> Landing
  Orchestrator --> Hosting
  Orchestrator --> Embedded
  Orchestrator --> ProviderTool
  Orchestrator --> EmailTool
  Classification --> Gemini
  Landing --> Gemini
  Hosting --> Gemini
  Embedded --> Gemini
  Classification --> MCPClient
  Landing --> MCPClient
  Hosting --> MCPClient
  Embedded --> MCPClient
  MCPClient --> Puppeteer
  MCPClient --> Playwright
  Puppeteer --> SharedPolicy
  Playwright --> SharedPolicy
  Puppeteer --> Cloudinary
  Playwright --> Cloudinary
  ProviderTool --> IPInfo
  FastAPI --> DB
  Jobs --> DB
  Registry --> DB
  FastAPI --> DataFiles
```

- **What it shows:** the full logical system: operator console, FastAPI backend, agent runtime, browser tooling, database, and external services.
- **How to read it:** the operator uses the Next.js console, the console calls FastAPI, FastAPI starts jobs, jobs run the orchestrator, and the orchestrator delegates to specialist agents and tools.
- **Why it matters:** the project is not a single scraper. It is a controlled runtime where routing, browser evidence, model calls, provider lookup, and persistence are separated so failures can be inspected.
- **Source grounding:** `web/lib/api.js`, `src/api/app.py`, `src/agents/orchestrator.py`, `src/tools/mcp_client.py`, `src/storage/models.py`, and `docker-compose.yml`.

## 2. Deployment Diagram

```mermaid
flowchart TB
  Operator["Operator browser"]

  subgraph WebContainer["owc-web container"]
    NextRuntime["Next.js 15 + React 19<br/>serves operator console"]
    WebPort["host localhost:3000<br/>container port 3001"]
  end

  subgraph ApiContainer["owc container"]
    FastAPIRuntime["FastAPI + Uvicorn<br/>Python 3.11"]
    AgentRuntime["LangChain Core<br/>LangGraph<br/>Gemini integration"]
    PersistenceLayer["SQLAlchemy + Alembic<br/>repository classes"]
    ApiPort["host localhost:8000<br/>container port 8000"]
  end

  subgraph BrowserContainers["Browser MCP containers"]
    PuppeteerSvc["owc-tools<br/>Puppeteer + Chrome<br/>MCP 3000, CDP 9222"]
    PlaywrightSvc["owc-tools-playwright<br/>Playwright + Chrome<br/>MCP 3001, CDP 9223"]
  end

  subgraph DataPlane["Data services and mounted files"]
    Postgres[("postgres:16-alpine<br/>owc database")]
    DataDir["./data<br/>runtime memory and generated state"]
    Configs["./configs<br/>prompt and settings files"]
    Datasets["./datasets<br/>seed/test site lists"]
  end

  subgraph External["External APIs"]
    GeminiAPI["Google GenAI / Gemini"]
    IPInfoAPI["IPInfo / RDAP / Whois"]
    CloudinaryAPI["Cloudinary"]
  end

  Operator --> WebPort --> NextRuntime
  NextRuntime --> ApiPort --> FastAPIRuntime
  FastAPIRuntime --> AgentRuntime
  AgentRuntime --> GeminiAPI
  AgentRuntime --> PuppeteerSvc
  AgentRuntime --> PlaywrightSvc
  PuppeteerSvc --> CloudinaryAPI
  PlaywrightSvc --> CloudinaryAPI
  FastAPIRuntime --> PersistenceLayer --> Postgres
  FastAPIRuntime --> IPInfoAPI
  FastAPIRuntime --> DataDir
  FastAPIRuntime --> Configs
  FastAPIRuntime --> Datasets
  PuppeteerSvc --> DataDir
  PlaywrightSvc --> DataDir
```

- **What it shows:** the local Docker Compose deployment and how each container contributes to the runtime.
- **How to read it:** traffic starts in the operator browser, enters the `owc-web` container, moves to the `owc` API container, then reaches Postgres, browser MCP containers, or external APIs.
- **Why it matters:** browser automation is isolated from the API process. This avoids mixing heavy Chrome/Playwright dependencies with the FastAPI application and makes tool health easier to diagnose.
- **Source grounding:** `docker-compose.yml`, `Dockerfile`, `Dockerfile.web`, `Dockerfile.tools`, and `Dockerfile.tools.playwright`.

## 3. Use Case Diagram

```mermaid
flowchart LR
  Operator((Operator))

  subgraph Console["Open Web Catcher Console"]
    ViewDashboard["View operational dashboard"]
    LaunchWorkflow["Launch full workflow run"]
    TestAgent["Test one specialist agent"]
    ManageDatasets["Manage dataset sites and batches"]
    InspectRun["Inspect run detail and traces"]
    ReviewEvidence["Review streams, screenshots, providers, emails"]
    LookupProvider["Run manual provider lookup"]
    ManageSettings["Manage models, browser, tools, pricing, keys"]
  end

  Operator --> ViewDashboard
  Operator --> LaunchWorkflow
  Operator --> TestAgent
  Operator --> ManageDatasets
  Operator --> InspectRun
  Operator --> LookupProvider
  Operator --> ManageSettings
  LaunchWorkflow --> InspectRun
  TestAgent --> InspectRun
  ManageDatasets --> LaunchWorkflow
  InspectRun --> ReviewEvidence
  ReviewEvidence --> LookupProvider
  ManageSettings --> LaunchWorkflow
```

- **What it shows:** the main actions a human operator performs through the UI.
- **How to read it:** the operator can start new work from `/live`, manage batches from `/runs`, inspect results in `/runs/[runId]`, and adjust configuration through `/settings`.
- **Why it matters:** the system is designed for investigation and review, not automatic takedown sending. The operator remains responsible for interpreting evidence and reviewing generated emails.
- **Source grounding:** `web/components/console/layout/navigation-config.js`, `web/components/console/live/live-page.js`, `web/components/console/runs/runs-page.js`, and `web/components/console/run-detail/run-detail-page.js`.

## 4. Frontend Route And Data Flow Diagram

```mermaid
flowchart TB
  Shell["AppShell<br/>navigation and topbar"]

  Dashboard["/<br/>OverviewPage"]
  Live["/live<br/>workflow and single-agent launcher"]
  Runs["/runs<br/>websites, batches, history"]
  RunDetail["/runs/[runId]<br/>run detail, Agent desk, evidence tabs"]
  Providers["/providers<br/>manual provider lookup and history"]
  Settings["/settings<br/>models, browser, display, keys, MCP tools"]
  AgentsRedirect["/agents<br/>redirects to /live"]

  OverviewAPI["/ui/overview<br/>/ui/events/recent<br/>/ui/tools/reliability<br/>/ui/database/*"]
  LaunchAPI["/ui/workflows/run<br/>/ui/agents/test<br/>/ui/browser/status"]
  RunsAPI["/ui/runs<br/>/api/datasets/*"]
  DetailAPI["/ui/runs/{run_id}<br/>/ui/runs/{run_id}/stream<br/>/ui/runs/{run_id}/screenshot<br/>/ui/runs/{run_id}/cancel"]
  ProviderAPI["/ui/providers/lookup<br/>/ui/providers/history"]
  SettingsAPI["/ui/config<br/>/ui/providers/models<br/>/ui/pricing<br/>/ui/pricing/sync"]

  Shell --> Dashboard
  Shell --> Live
  Shell --> Runs
  Shell --> Providers
  Shell --> Settings
  AgentsRedirect --> Live
  Runs --> RunDetail
  Dashboard --> OverviewAPI
  Live --> LaunchAPI
  Runs --> RunsAPI
  RunDetail --> DetailAPI
  RunDetail --> ProviderAPI
  Providers --> ProviderAPI
  Settings --> SettingsAPI
```

- **What it shows:** the active frontend routes and the backend endpoints each route depends on.
- **How to read it:** page nodes are UI screens; API nodes are the FastAPI route groups they call. `/agents` is included only to show that it redirects to `/live`.
- **Why it matters:** this avoids overstating unused frontend screens. For the report, the active console is Dashboard, Live Pipeline, View Results, Provider Results, Settings, and Run Detail.
- **Source grounding:** `web/app/page.js`, `web/app/live/page.js`, `web/app/runs/page.js`, `web/app/runs/[runId]/page.js`, `web/app/providers/page.js`, `web/app/settings/page.js`, `web/app/agents/page.js`, and `src/api/app.py`.

## 5. End-To-End Flowchart

```mermaid
flowchart TD
  Start(["Operator submits target URL"])
  UI["Next.js console<br/>/live workflow form"]
  PostRun["POST /ui/workflows/run"]
  Preflight{"Runtime ready?"}
  Blocked["Return blocking reasons<br/>tools, browser, or API unavailable"]
  Queue["Create background job<br/>job_type=workflow"]
  Trace["Create RunObserver<br/>root actor orchestrator"]
  Graph["Run OrchestratorAgent"]
  Classify["ClassificationAgent"]
  Route{"Classified page type"}
  Landing["LandingPageAgent<br/>find watch/hosting candidates"]
  Hosting["HostingPageAgent<br/>operate server controls and players"]
  Embedded["EmbeddedPageAgent<br/>inspect iframe/player context"]
  Streams{"Concrete streams found?"}
  Provider["IPInfoTool<br/>provider and abuse contact"]
  Email["Email generator<br/>draft takedown notices"]
  NoEvidence["Skip provider/email<br/>record no-stream reason"]
  Persist["Persist result, events, calls, evidence"]
  Detail["Run detail dashboard<br/>GET /ui/runs/{run_id}"]

  Start --> UI --> PostRun --> Preflight
  Preflight -->|"no"| Blocked
  Preflight -->|"yes"| Queue --> Trace --> Graph --> Classify --> Route
  Route -->|"landing_page"| Landing --> Hosting
  Route -->|"hosting_page"| Hosting
  Route -->|"embedded_page"| Embedded
  Route -->|"unknown"| Streams
  Landing --> Embedded
  Hosting --> Embedded
  Hosting --> Streams
  Embedded --> Streams
  Streams -->|"yes"| Provider --> Email --> Persist
  Streams -->|"no"| NoEvidence --> Persist
  Persist --> Detail
```

- **What it shows:** the complete investigation path from a URL submission to a persisted dashboard result.
- **How to read it:** diamonds are decisions; rectangular nodes are runtime stages. The path branches based on classification and whether streams are found.
- **Why it matters:** it shows that provider lookup and email drafting are conditional. They run only after concrete stream evidence exists.
- **Source grounding:** `/ui/workflows/run` in `src/api/app.py`, orchestration nodes in `src/agents/orchestrator.py`, schema outputs in `src/models/schemas.py`, and persistence in `src/storage/repositories.py`.

## 6. Orchestrator Activity Diagram

```mermaid
flowchart TD
  A([Start orchestrator])
  B["Initialize PipelineState<br/>url, run_id, pending queues"]
  C["Emit pipeline_started"]
  D["Read long-term memory hints<br/>if memory enabled"]
  E["Run ClassificationAgent"]
  F{"classification.page_type"}
  G["Build landing handoff"]
  H["Run LandingPageAgent"]
  I["Collect matches, hosting URLs,<br/>direct embedded URLs"]
  J["Queue hosting targets"]
  K["Run HostingPageAgent<br/>bounded parallelism"]
  L["Collect streams and embedded handoffs"]
  M["Queue embedded targets"]
  N["Run EmbeddedPageAgent"]
  O["Aggregate stream URLs<br/>dedupe provider-like URLs"]
  P{"streams found?"}
  Q["Run provider analysis"]
  R["Generate takedown email drafts"]
  S["Skip provider/email<br/>emit skipped decision"]
  T["Compute final_status"]
  U["Build PipelineResult"]
  V([Return result])

  A --> B --> C --> D --> E --> F
  F -->|"landing_page"| G --> H --> I
  F -->|"hosting_page"| J
  F -->|"embedded_page"| M
  F -->|"unknown"| O
  I --> J
  I --> M
  J --> K --> L
  L -->|"embedded URLs exist"| M
  L -->|"no more embedded URLs"| O
  M --> N --> O
  O --> P
  P -->|"yes"| Q --> R --> T
  P -->|"no"| S --> T
  T --> U --> V
```

- **What it shows:** the orchestrator's activity from initial state to final `PipelineResult`.
- **How to read it:** classification decides the first specialist stage, but later stages can still hand off to hosting or embedded work when they discover better targets.
- **Why it matters:** routing is deterministic and observable. Prompts do not silently decide the pipeline path; the graph and handoff logic do.
- **Source grounding:** `PipelineState`, `build_graph`, `route_after_classification`, `route_after_landing`, `route_after_hosting`, and `route_after_embedded` in `src/agents/orchestrator.py`.

## 7. Shared Agent Loop Activity Diagram

```mermaid
flowchart TD
  Start([Agent.run])
  Prompt["compile_agent_prompt<br/>policy, contract, runtime, memory, task"]
  Tools["Open MCP profile session<br/>classification, landing, hosting, embedded"]
  Bootstrap["Optional bootstrap tools<br/>memory lookup, navigation, inspect"]
  LLM["Gemini turn<br/>messages plus bound tools"]
  ToolDecision{"LLM requested tool calls?"}
  Cache{"Non-mutating tool cache hit?"}
  Invoke["Invoke MCP tool<br/>timeout and error handling"]
  Record["Record runtime event<br/>LLM usage, tool call, context"]
  Progress{"Progress or stop condition?"}
  Compact["Compact context<br/>when usage is high"]
  Parse["Parse final JSON / structured text"]
  Normalize["Normalize to Pydantic schema"]
  Remember["Store memory profile<br/>if enabled"]
  Finish([Agent result])

  Start --> Prompt --> Tools --> Bootstrap --> LLM --> ToolDecision
  ToolDecision -->|"yes"| Cache
  Cache -->|"hit"| Record
  Cache -->|"miss"| Invoke --> Record
  ToolDecision -->|"no final answer"| Parse
  Record --> Progress
  Progress -->|"continue"| LLM
  Progress -->|"context high"| Compact --> LLM
  Progress -->|"budget exhausted or done"| Parse
  Parse --> Normalize --> Remember --> Finish
```

- **What it shows:** the shared browser-facing agent loop used by classification, landing, hosting, and embedded agents.
- **How to read it:** every agent compiles a prompt, connects to its MCP tool profile, lets Gemini request tools, records telemetry, and normalizes the final answer.
- **Why it matters:** the loop makes LLM work inspectable. Model calls, tool calls, cache decisions, context pressure, and stop reasons become dashboard evidence.
- **Source grounding:** `run_agent_loop`, `AgentGraphState`, `AgentLoopResult`, `build_llm`, and tool invocation helpers in `src/agents/base.py`; prompt compilation in `src/agents/prompting.py`.

## 8. Workflow Launch Sequence Diagram

```mermaid
sequenceDiagram
  participant Browser as Operator Browser
  participant UI as Next.js Console
  participant API as FastAPI
  participant Health as Runtime Preflight
  participant Jobs as BackgroundJobRepository
  participant Worker as Background Worker
  participant Orchestrator as OrchestratorAgent
  participant DB as Postgres

  Browser->>UI: submit URL on /live
  UI->>API: POST /ui/workflows/run
  API->>Health: verify launch runtime
  alt runtime blocked
    Health-->>API: blocking reasons
    API-->>UI: 503 response with details
  else runtime ready
    API->>Jobs: enqueue workflow job
    API-->>UI: run_id, job_id, queued/running status
    Worker->>Jobs: claim job
    Worker->>Orchestrator: run_pipeline(run_id, url)
    Orchestrator->>DB: persist trace snapshots and final result
  end
```

- **What it shows:** how a full workflow run is launched from the frontend.
- **How to read it:** the UI does not run agents directly. It asks FastAPI to create a job, then the backend worker runs the orchestrator.
- **Why it matters:** background jobs make long browser investigations manageable and allow the UI to show queued, running, cancelled, failed, or finished states.
- **Source grounding:** `/ui/workflows/run`, background job helpers, and `_background_workflow` in `src/api/app.py`; job records in `src/storage/models.py`.

## 9. Run Detail Sequence Diagram

```mermaid
sequenceDiagram
  participant UI as RunDetailPage
  participant API as FastAPI /ui/runs/{run_id}
  participant Registry as run_registry
  participant Jobs as BackgroundJobRepository
  participant Repo as OperatorConsoleRepository
  participant Dataset as DatasetRepository
  participant DB as Postgres

  UI->>API: GET /ui/runs/{run_id}
  API->>Registry: check active trace
  API->>DB: restore trace if server has persisted snapshot
  API->>Jobs: read job state
  API->>Dataset: read dataset context when available
  API->>Repo: get_run_detail(run_id)
  alt normalized rows exist
    Repo-->>API: run, events, calls, rollups, evidence
  else job result or snapshot only
    Jobs-->>API: fallback result_json
    API->>API: synthesize degraded payload
  end
  API-->>UI: page-level run detail payload
```

- **What it shows:** how the run detail page loads data for a completed or active run.
- **How to read it:** FastAPI checks active memory, persisted snapshots, job state, normalized rows, and fallbacks before returning one combined payload.
- **Why it matters:** the dashboard can still show useful information even if a run is active, partially persisted, restored after restart, or missing some normalized rows.
- **Source grounding:** `GET /ui/runs/{run_id}` and trace recovery helpers in `src/api/app.py`; read-model assembly in `src/storage/ui_repository.py`.

## 10. SSE Live Trace Sequence Diagram

```mermaid
sequenceDiagram
  participant UI as RunDetailLive
  participant API as /ui/runs/{run_id}/stream
  participant Registry as run_registry
  participant Trace as RunTrace
  participant Board as Agent desk

  UI->>API: open EventSource
  API->>Registry: find active trace
  loop while run is active and request open
    API->>Trace: snapshot events, metrics, cancellation, completion
    API-->>UI: SSE data event
    UI->>Board: normalize events and update stage cards
  end
  UI->>API: POST /ui/runs/{run_id}/sync-logs
```

- **What it shows:** how live events reach the run-detail dashboard while a run is still executing.
- **How to read it:** the browser keeps an EventSource connection open; FastAPI repeatedly sends trace snapshots; the frontend normalizes them into Agent Desk cards.
- **Why it matters:** the jury can understand why the dashboard shows live progress before the database has fully persisted the final result.
- **Source grounding:** `/ui/runs/{run_id}/stream` and `_stream_trace` in `src/api/app.py`; `RunDetailLive`, `AgentActivityBoard`, and `web/lib/run-trace.js`.

## 11. Agent Class Diagram

```mermaid
classDiagram
  class OrchestratorAgent {
    +Settings settings
    +RunObserver observer
    +graph
    +run(url) PipelineResult
  }

  class ClassificationAgent {
    +Settings settings
    +run(url, observer) ClassificationResult
  }

  class LandingPageAgent {
    +Settings settings
    +run(url, observer, orchestrator_handoff) ExtractionResult
  }

  class HostingPageAgent {
    +Settings settings
    +run(url, observer, orchestrator_handoff) ExtractionResult
  }

  class EmbeddedPageAgent {
    +Settings settings
    +run(url, observer, orchestrator_handoff) ExtractionResult
  }

  class AgentLoopResult {
    +str final_text
    +int tool_calls_made
    +int bootstrap_tool_calls
    +int llm_tool_calls_made
    +list messages
    +str stop_reason
    +bool budget_exhausted
    +parse_json() dict
  }

  class RunObserver {
    +str run_id
    +str actor
    +child(actor, agent_type) RunObserver
    +emit(kind, message, status, details) RuntimeEvent
    +add_llm_usage(...) dict
    +increment_tool_calls(count) void
    +finish(success, failure_mode) void
    +request_cancel(reason) void
    +trace() RunTrace
  }

  OrchestratorAgent --> ClassificationAgent : invokes
  OrchestratorAgent --> LandingPageAgent : invokes
  OrchestratorAgent --> HostingPageAgent : invokes
  OrchestratorAgent --> EmbeddedPageAgent : invokes
  OrchestratorAgent --> RunObserver : records
  ClassificationAgent --> AgentLoopResult : uses
  LandingPageAgent --> AgentLoopResult : uses
  HostingPageAgent --> AgentLoopResult : uses
  EmbeddedPageAgent --> AgentLoopResult : uses
  ClassificationAgent --> RunObserver : emits
  LandingPageAgent --> RunObserver : emits
  HostingPageAgent --> RunObserver : emits
  EmbeddedPageAgent --> RunObserver : emits
```

- **What it shows:** the main runtime classes and how the orchestrator coordinates specialist agents.
- **How to read it:** arrows from `OrchestratorAgent` mean it calls that agent. Arrows to `RunObserver` mean the class emits events, usage, and trace information.
- **Why it matters:** the split keeps each agent focused: classification routes, landing discovers watch pages, hosting operates players, and embedded inspects iframe/player contexts.
- **Source grounding:** `src/agents/orchestrator.py`, `src/agents/classification.py`, `src/agents/landing_page.py`, `src/agents/hosting_page.py`, `src/agents/embedded_page.py`, and `src/utils/observability.py`.

## 12. Runtime Schema Class Diagram

```mermaid
classDiagram
  class PipelineResult {
    +str run_id
    +str url
    +ClassificationResult classification
    +list~MatchInfo~ matches
    +list~ExtractionResult~ extraction_results
    +ExtractionStatus final_status
    +list~StreamURL~ all_streams
    +list~str~ all_screenshots
    +list~ProviderInfo~ provider_analysis
    +list~TakedownEmail~ takedown_emails
    +RunMetrics metrics
    +streams() list~StreamURL~
  }

  class ClassificationResult {
    +str url
    +PageType page_type
    +Confidence confidence
    +str reasoning
    +AgentType agent_type
  }

  class MatchInfo {
    +str url
    +str title
    +str channel
    +str route
    +list~str~ iframes
    +list~str~ video_srcs
    +list~str~ player_urls
    +list~dict~ server_hints
    +dict metadata
  }

  class ExtractionResult {
    +str url
    +PageType page_type
    +ExtractionStatus status
    +list~ServerResult~ servers
    +list~StreamURL~ streams
    +list~str~ screenshots
    +list~str~ embedded_urls
    +str primary_channel
    +list~str~ detected_channels
    +dict channel_metadata
    +AgentType agent_type
  }

  class ServerResult {
    +str label
    +bool server_up
    +list~str~ m3u8_urls
    +list~str~ mpd_urls
    +list~str~ mp4_urls
    +list~str~ stream_urls
    +str primary_stream
    +str screenshot_url
    +str embedded_url
    +str player_iframe_url
    +str status
  }

  class StreamURL {
    +str url
    +str protocol
    +str quality
    +str source_layer
    +str channel_name
    +datetime captured_at
  }

  class ProviderInfo {
    +str stream_url
    +str ip
    +str hostname
    +str org
    +str provider
    +str country
    +str abuse_email
    +str whois_raw
  }

  class TakedownEmail {
    +str provider
    +str abuse_email
    +str channel_name
    +str subject
    +str body
    +str infringing_url
    +list~str~ stream_urls
    +list~str~ screenshot_urls
    +ProviderInfo provider_info
  }

  PipelineResult --> ClassificationResult
  PipelineResult --> MatchInfo
  PipelineResult --> ExtractionResult
  PipelineResult --> StreamURL
  PipelineResult --> ProviderInfo
  PipelineResult --> TakedownEmail
  ExtractionResult --> ServerResult
  ExtractionResult --> StreamURL
  TakedownEmail --> ProviderInfo
```

- **What it shows:** the Pydantic objects that define the pipeline result returned by the backend and stored by repositories.
- **How to read it:** `PipelineResult` is the aggregate root. It owns classification, matches, extraction results, streams, screenshots, provider analysis, and email drafts.
- **Why it matters:** these schemas make agent outputs consistent. Even if an agent uses free-form LLM reasoning internally, the final output must fit typed runtime objects.
- **Source grounding:** `src/models/schemas.py` and enum definitions in `src/models/enums.py`.

## 13. Repository Class Diagram

```mermaid
classDiagram
  class RunRepository {
    +save(result, trace) void
    +save_trace_snapshot(run_id, root_actor, url, trace) void
    +hard_delete_run(run_id) dict
    +get_by_run_id(run_id) RunRecord
    +list_recent(limit) list
    +list_runtime_events(run_id) list
    +list_agent_runs(run_id) list
    +list_llm_calls(run_id) list
    +list_tool_calls(run_id) list
    +list_prompt_compilations(run_id) list
  }

  class BackgroundJobRepository {
    +enqueue(run_id, job_type, url, actor, payload, idempotency_key, max_attempts) BackgroundJobRecord
    +claim_next(lease_seconds) BackgroundJobRecord
    +heartbeat(run_id, lease_seconds) void
    +mark_cancelled(run_id, reason) void
    +mark_succeeded(run_id, result_json) void
    +mark_failed(run_id, error_text) BackgroundJobRecord
    +recover_stale_running(stale_after_seconds) int
  }

  class OperatorConsoleRepository {
    +get_overview(active_traces, limit) dict
    +list_runs(status, limit, offset) dict
    +get_run_detail(run_id, active_trace) dict
    +list_database_table(table, limit, offset) dict
    +list_pricing_configs() list
    +record_tool_playground_call(payload) dict
    +record_provider_lookup_batch(payload) dict
    +list_recent_runtime_events(limit) list
  }

  class DatasetRepository {
    +ensure_seeded_from_csv(csv_path) dict
    +list_sites(...) dict
    +create_site(...) dict
    +get_site_detail(site_id, limit) dict
    +create_batch(...) dict
    +list_batches(limit, offset) dict
    +get_batch(batch_id) dict
    +record_result(run_id, result) void
    +cancel_batch(batch_id, reason) dict
  }

  BackgroundJobRepository --> RunRepository : workflow jobs finish into runs
  RunRepository --> OperatorConsoleRepository : normalized rows are read by UI
  DatasetRepository --> BackgroundJobRepository : batch site runs enqueue jobs
  DatasetRepository --> OperatorConsoleRepository : dataset context enriches run detail
```

- **What it shows:** the persistence classes that write and read runtime state.
- **How to read it:** `RunRepository` writes results and telemetry, `BackgroundJobRepository` manages durable work, `OperatorConsoleRepository` assembles UI payloads, and `DatasetRepository` manages benchmark/batch site runs.
- **Why it matters:** write paths and read paths are separated. This keeps the agent runtime focused on execution while the console receives dashboard-ready payloads.
- **Source grounding:** `src/storage/repositories.py`, `src/storage/ui_repository.py`, `src/storage/dataset_repository.py`, and `src/api/app.py`.

## 14. Database ER Diagram

```mermaid
erDiagram
  PIPELINE_RUNS ||--o| RUN_SNAPSHOTS : has
  PIPELINE_RUNS ||--o{ AGENT_RUNS : invokes
  AGENT_RUNS ||--o| AGENT_OUTPUTS : returns
  AGENT_RUNS ||--o{ LLM_CALLS : records
  AGENT_RUNS ||--o{ TOOL_CALLS : records
  PIPELINE_RUNS ||--o{ RUNTIME_EVENTS : emits
  AGENT_RUNS ||--o{ RUNTIME_EVENTS : may_own
  PIPELINE_RUNS ||--o{ RUN_MODEL_USAGE : aggregates
  PIPELINE_RUNS ||--o{ RUN_STREAMS : captures
  PIPELINE_RUNS ||--o{ RUN_SCREENSHOTS : captures
  PIPELINE_RUNS ||--o{ PROVIDER_ANALYSES : resolves
  PIPELINE_RUNS ||--o{ TAKEDOWN_EMAILS : drafts
  PIPELINE_RUNS ||--o{ RUN_DECISIONS : syncs
  PIPELINE_RUNS ||--o{ RUN_TASKS : syncs

  PIPELINE_RUNS {
    int id PK
    string run_id
    text root_url
    string page_type
    string final_status
    bool success
    int stream_count
    int screenshot_count
    int email_count
    int total_llm_calls
    int total_tool_calls
    float estimated_total_cost_usd
  }

  AGENT_RUNS {
    int id PK
    int pipeline_run_id FK
    string actor
    string agent_type
    text target_url
    string status
    int invocation_index
    int tool_calls_made
    int llm_calls_made
  }

  RUNTIME_EVENTS {
    int id PK
    int pipeline_run_id FK
    int agent_run_id FK
    string actor
    int seq
    string kind
    string status
    text message
  }

  LLM_CALLS {
    int id PK
    int agent_run_id FK
    int seq
    string provider
    string model_name
    int input_tokens
    int output_tokens
    float estimated_total_cost_usd
  }

  TOOL_CALLS {
    int id PK
    int agent_run_id FK
    int seq
    string tool_name
    string status
    text result_preview
    text error_text
  }

  RUN_STREAMS {
    int id PK
    int pipeline_run_id FK
    text stream_url
    text source_url
    string protocol
    string server_label
  }
```

- **What it shows:** the normalized database tables centered on `pipeline_runs`.
- **How to read it:** one pipeline run can have many agent runs, events, model calls, tool calls, streams, screenshots, provider rows, and email rows.
- **Why it matters:** the database stores both final evidence and operational telemetry. This lets the console answer what was found and how the run behaved.
- **Source grounding:** SQLAlchemy records in `src/storage/models.py` and persistence logic in `src/storage/repositories.py`.

## 15. Dataset ER Diagram

```mermaid
erDiagram
  DATASET_SITES ||--o{ DATASET_SITE_RUNS : schedules
  DATASET_BATCHES ||--o{ DATASET_SITE_RUNS : contains

  DATASET_SITES {
    int id PK
    string canonical_url
    text url
    string source
    string language
    string label
    int total_runs
    int successful_runs
    int failed_runs
    datetime last_tested_at
  }

  DATASET_BATCHES {
    int id PK
    string batch_id
    string batch_name
    string status
    string source
    string language_filter
    string label_filter
    int requested_count
    int completed_count
    int passed_count
    int failed_count
    int cancelled_count
  }

  DATASET_SITE_RUNS {
    int id PK
    int batch_id FK
    int site_id FK
    string run_id
    text url
    string status
    string final_status
    int stream_count
    float total_cost_usd
    text error_text
  }
```

- **What it shows:** how benchmark or evaluation sites are stored and connected to batch runs.
- **How to read it:** a dataset batch contains many site-run rows, and each site-run can point back to a known dataset site.
- **Why it matters:** the project can evaluate multiple target URLs consistently instead of relying only on one manual run.
- **Source grounding:** `DatasetSiteRecord`, `DatasetBatchRecord`, and `DatasetSiteRunRecord` in `src/storage/models.py`; dataset APIs in `src/api/datasets.py`.

## 16. Prompt And Memory ER Diagram

```mermaid
erDiagram
  PROMPT_VERSIONS ||--o{ PROMPT_COMPILATIONS : compiles
  AGENT_RUNS ||--o{ PROMPT_COMPILATIONS : owns
  AGENT_RUNS ||--o{ MEMORY_HINTS_USED : used
  MEMORY_ENTRIES ||--o{ MEMORY_HINTS_USED : referenced
  AGENT_RUNS ||--o{ MEMORY_ENTRIES : may_create

  PROMPT_VERSIONS {
    int id PK
    string agent_id
    text source_path
    string semantic_version
    string content_hash
    bool active
  }

  PROMPT_COMPILATIONS {
    int id PK
    int prompt_version_id FK
    int agent_run_id FK
    string cache_mode
    string compiled_prompt_hash
    bool provider_cache_eligible
    bool static_cache_hit
    bool memory_injected
  }

  MEMORY_ENTRIES {
    int id PK
    string domain
    string page_type
    string source_run_id
    int source_agent_run_id FK
    string status
    bool success
    text url
  }

  MEMORY_HINTS_USED {
    int id PK
    int agent_run_id FK
    int memory_entry_id FK
  }
```

- **What it shows:** the relationship between prompt versions, compiled prompts, stored memory, and memory hints used by an agent run.
- **How to read it:** prompt source files become prompt versions, each agent run can record a prompt compilation, and memory entries can be referenced as hints.
- **Why it matters:** prompt and memory telemetry makes agent behavior explainable. The report can show whether a run used cached prompts or prior domain knowledge.
- **Source grounding:** `PromptVersionRecord`, `PromptCompilationRecord`, `MemoryEntryRecord`, and `MemoryHintUsedRecord` in `src/storage/models.py`; prompt compilation in `src/agents/prompting.py`; memory helpers in `src/agents/memory.py`.

## 17. Final Status State Diagram

```mermaid
stateDiagram-v2
  [*] --> Running
  Running --> Success: provider stream URLs found
  Running --> Timeout: agent or extraction timeout
  Running --> PageInaccessible: navigation or site-down evidence
  Running --> NoHostingPages: landing found no useful hosting candidates
  Running --> NoStreams: hosting or embedded worked but found no streams
  Running --> Partial: useful evidence exists but not complete success
  Running --> Failed: no useful evidence and no more specific status
  Running --> Cancelled: cancel requested
  Success --> [*]
  Timeout --> [*]
  PageInaccessible --> [*]
  NoHostingPages --> [*]
  NoStreams --> [*]
  Partial --> [*]
  Failed --> [*]
  Cancelled --> [*]
```

- **What it shows:** the terminal states a workflow can end in.
- **How to read it:** all runs start as running, then finish in exactly one meaningful final status.
- **Why it matters:** different failures mean different things. A page-inaccessible run, a no-hosting-pages run, and a no-streams run require different follow-up actions.
- **Source grounding:** `ExtractionStatus` in `src/models/enums.py` and final status construction in `_build_pipeline_result` inside `src/agents/orchestrator.py`.

## 18. Agent Desk State Diagram

```mermaid
stateDiagram-v2
  [*] --> Waiting
  Waiting --> Running: agent_started or stage event
  Running --> Success: agent_finished success
  Running --> Warning: partial, no_streams, or no_hosting_pages
  Running --> Failed: agent_failed or terminal error
  Running --> Waiting: queued next invocation
  Success --> [*]
  Warning --> [*]
  Failed --> [*]
```

- **What it shows:** how the frontend Agent Desk interprets stage status.
- **How to read it:** a card starts waiting, becomes running when events arrive, then ends as success, warning, or failed depending on events and persisted rollups.
- **Why it matters:** the Agent Desk is a live execution board. It summarizes multiple backend signals into a readable stage status for the operator and jury.
- **Source grounding:** `web/components/console/run-detail/agent-activity-board.js`, `web/components/orchestrator-graph.js`, and `web/lib/run-trace.js`.

## 19. Evidence Flow Diagram

```mermaid
flowchart LR
  Target["Target URL"]
  BrowserAgents["Landing / Hosting / Embedded agents"]
  BrowserTools["MCP browser tools<br/>inspect, navigate, action, harvest, screenshot"]
  Screenshots["Cloudinary screenshot URLs"]
  Streams["Stream URLs<br/>m3u8, mpd, mp4"]
  Provider["Provider analysis<br/>IP, hostname, org, abuse email"]
  Email["Takedown email draft<br/>subject, body, evidence"]
  DB["Postgres evidence tables"]
  UI["Run detail evidence views"]

  Target --> BrowserAgents
  BrowserAgents --> BrowserTools
  BrowserTools --> Screenshots
  BrowserTools --> Streams
  Streams --> Provider
  Screenshots --> Email
  Streams --> Email
  Provider --> Email
  Screenshots --> DB
  Streams --> DB
  Provider --> DB
  Email --> DB
  DB --> UI
```

- **What it shows:** how raw browser observations become reviewable evidence.
- **How to read it:** browser agents use tools to capture screenshots and stream URLs; streams feed provider analysis; streams, screenshots, and provider facts feed the email draft.
- **Why it matters:** takedown emails are not generated from guesses. They are generated only from persisted evidence that the operator can review.
- **Source grounding:** extraction schemas in `src/models/schemas.py`, provider lookup in `src/tools/ipinfo_tool.py`, email generation in `src/agents/email_generator.py`, and evidence tables in `src/storage/models.py`.

## Documentation Index

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
- [Azure Container Apps Job With Service Bus](./operations/azure-container-app-job-service-bus.md)

## Active Implementation Sources

| Area | Source |
| --- | --- |
| FastAPI routes and background jobs | `src/api/app.py`, `src/api/datasets.py`, `src/api/provider_config.py` |
| Agent runtime | `src/agents/orchestrator.py`, `src/agents/base.py`, `src/agents/classification.py`, `src/agents/landing_page.py`, `src/agents/hosting_page.py`, `src/agents/embedded_page.py` |
| Runtime schemas and enums | `src/models/schemas.py`, `src/models/enums.py` |
| Persistence | `src/storage/models.py`, `src/storage/repositories.py`, `src/storage/ui_repository.py`, `src/storage/dataset_repository.py` |
| MCP and provider tools | `src/tools/mcp_client.py`, `src/tools/ipinfo_tool.py`, `src/tools/email_tool.py`, `tools/puppeteer/`, `tools/playwright/` |
| Active frontend routes | `web/app/page.js`, `web/app/live/page.js`, `web/app/runs/page.js`, `web/app/runs/[runId]/page.js`, `web/app/providers/page.js`, `web/app/settings/page.js`, `web/app/agents/page.js` |
| Frontend navigation and run detail | `web/components/console/layout/navigation-config.js`, `web/components/console/run-detail/`, `web/lib/run-trace.js`, `web/lib/api.js` |
| Docker stack | `docker-compose.yml`, `Dockerfile`, `Dockerfile.web`, `Dockerfile.tools`, `Dockerfile.tools.playwright` |
