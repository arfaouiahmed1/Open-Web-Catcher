# Workflow Lifecycle

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Workflow Index](./README.md) | Next: [Dashboard Logging](./dashboard-logging.md)

A workflow run starts from the operator console and ends as a persisted `PipelineResult` plus normalized telemetry. The current route is deterministic: the orchestrator always checks memory, calls classification, routes to the correct specialist path, then aggregates streams, providers, email drafts, screenshots, metrics, and final status.

## End-To-End Flowchart

```mermaid
flowchart TD
  Start(["Operator submits URL"])
  UI["Next.js console<br/>/live or /runs"]
  RunPost["POST /ui/workflows/run"]
  Preflight{"Runtime preflight ok?"}
  Queue["Create background job<br/>job_type=workflow"]
  Trace["Create RunObserver<br/>root_actor=orchestrator"]
  PersistLoop["Start trace persistence loop"]
  Orchestrator["OrchestratorAgent.run"]
  Memory["Check LongTermMemory<br/>classification/landing/hosting/embedded"]
  Classify["ClassificationAgent"]
  Route{"Page type?"}
  Landing["LandingPageAgent<br/>discover hosting candidates"]
  QueueHosting["Queue hosting URLs"]
  Hosting["HostingPageAgent<br/>parallel by max_parallel_hosting_pages"]
  QueueEmbedded["Queue embedded/player URLs"]
  Embedded["EmbeddedPageAgent"]
  Providers["IPInfoTool<br/>provider analysis"]
  Email["EmailTool<br/>takedown draft generation"]
  Result["Build PipelineResult<br/>final status + metrics"]
  DB["Persist normalized records"]
  Detail["GET /ui/runs/{run_id}"]
  SSE["GET /ui/runs/{run_id}/stream"]

  Start --> UI --> RunPost --> Preflight
  Preflight -->|"no"| Blocked["Return 503 with blocking_reasons"]
  Preflight -->|"yes"| Queue --> Trace --> PersistLoop --> Orchestrator
  Orchestrator --> Memory --> Classify --> Route
  Route -->|"landing"| Landing --> QueueHosting
  Route -->|"hosting"| QueueHosting
  Route -->|"embedded"| QueueEmbedded
  Route -->|"unknown / other"| Providers
  QueueHosting --> Hosting
  Landing --> QueueEmbedded
  Hosting --> QueueHosting
  Hosting --> QueueEmbedded
  QueueEmbedded --> Embedded
  Embedded --> Providers
  Hosting --> Providers
  Providers --> Email --> Result --> DB
  DB --> Detail
  Trace --> SSE
```

## Orchestrator Activity Diagram

```mermaid
flowchart TD
  A([Start orchestrator])
  B[Emit pipeline_started]
  C[Read domain memory hints]
  D[Emit memory checked decision]
  E[Call ClassificationAgent]
  F{classification.page_type}
  G[Prepare landing handoff]
  H[Run LandingPageAgent]
  I[Normalize matches and direct stream hints]
  J[Prepare hosting handoff]
  K[Run HostingPageAgent targets under semaphore]
  L[Collect embedded handoff URLs]
  M[Prepare embedded handoff]
  N[Run EmbeddedPageAgent]
  O[Collect provider-like stream URLs]
  P{streams found?}
  Q[Run IPInfoTool]
  R[Run EmailTool]
  S[Compute final_status]
  T[Emit pipeline_finished]
  U([Return PipelineResult])

  A --> B --> C --> D --> E --> F
  F -->|"landing"| G --> H --> I
  F -->|"hosting"| J
  F -->|"embedded"| M
  F -->|"unknown/other"| O
  I --> J
  I --> M
  J --> K --> L
  L -->|"embedded URLs"| M
  L -->|"no embedded URLs"| O
  M --> N --> O
  O --> P
  P -->|"yes"| Q --> R --> S
  P -->|"no"| Skip["Emit provider/email skipped decisions"] --> S
  S --> T --> U
```

## Agent Loop Activity

```mermaid
flowchart TD
  Start([Agent.run])
  Compile["compile_agent_prompt<br/>base policy + contract + runtime + memory + task brief"]
  Tools["Open MCP profile session"]
  Bootstrap["Optional bootstrap tools<br/>memory_lookup, navigate/open_url, inspect"]
  Turn["LLM turn with Gemini"]
  ToolCall{"LLM requested tools?"}
  Invoke["Invoke tool with timeout"]
  Cache{"Tool cache hit?"}
  Record["Record LLM/tool event"]
  Progress{"Progress made?"}
  Stop{"Stop condition?"}
  Parse["Parse JSON or structured text"]
  Normalize["Normalize result to schema"]
  Remember["Store memory profile if enabled"]
  Finish([Agent result])

  Start --> Compile --> Tools --> Bootstrap --> Turn
  Turn --> Record --> ToolCall
  ToolCall -->|"yes"| Cache
  Cache -->|"yes"| Record
  Cache -->|"no"| Invoke --> Record
  Record --> Progress
  Progress --> Stop
  Stop -->|"budget exhausted"| Parse
  Stop -->|"repeated tool/no progress"| Parse
  Stop -->|"site down"| Parse
  Stop -->|"not done"| Turn
  ToolCall -->|"no final answer"| Parse
  Parse --> Normalize --> Remember --> Finish
```

## Sequence: Workflow Launch

```mermaid
sequenceDiagram
  participant Browser
  participant Console as Next.js console
  participant API as FastAPI
  participant Health as service_health
  participant Jobs as BackgroundJobRepository
  participant Worker as background worker
  participant Orchestrator
  participant DB as Postgres

  Browser->>Console: submit URL in workflow mode
  Console->>API: POST /ui/workflows/run {url, idempotency_key}
  API->>Health: _ensure_launch_runtime_ready()
  alt runtime blocked
    Health-->>API: blocking_reasons
    API-->>Console: 503 structured preflight response
  else runtime ready
    API->>Jobs: enqueue workflow job
    API-->>Console: run_id, job_id, status queued/running
    Worker->>Jobs: claim background job
    Worker->>Orchestrator: _background_workflow(run_id, url)
    Orchestrator->>DB: persist final PipelineResult and trace rows
  end
```

## Sequence: Run Detail Load

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
  API->>Registry: active trace?
  API->>DB: restore trace if possible
  API->>Jobs: get job state
  API->>Dataset: get dataset context
  API->>Repo: get_run_detail(run_id)
  alt normalized payload exists
    Repo-->>API: run, snapshot, agent_rollups, stage_rollups, calls, events
  else only background job exists
    Jobs-->>API: job.result_json
    API->>API: synthesize fallback rollups/events
  end
  API-->>UI: page-level payload
```

## Sequence: SSE Live Trace

```mermaid
sequenceDiagram
  participant UI as RunDetailLive
  participant API as /ui/runs/{run_id}/stream
  participant Registry as run_registry
  participant Trace as RunTrace

  UI->>API: EventSource open
  API->>Registry: find active trace
  loop while request open
    API->>Trace: snapshot events/metrics/completed/cancel state
    API-->>UI: SSE data event
    UI->>UI: normalizeTraceEvents and update Agent desk
  end
```

## Final Status State Diagram

```mermaid
stateDiagram-v2
  [*] --> Running
  Running --> Success: provider stream URLs found
  Running --> Timeout: agent timeout or extraction timeout
  Running --> PageInaccessible: navigation/site-down evidence
  Running --> NoHostingPages: landing found no hosting candidates
  Running --> NoStreams: hosting/embedded worked but no streams
  Running --> Partial: pending followups or nonfailed evidence
  Running --> Failed: no useful evidence and no specific terminal reason
  Running --> Cancelled: cancel_requested
  Success --> [*]
  Timeout --> [*]
  PageInaccessible --> [*]
  NoHostingPages --> [*]
  NoStreams --> [*]
  Partial --> [*]
  Failed --> [*]
  Cancelled --> [*]
```

## Happy Path

```mermaid
flowchart LR
  URL["Streaming site URL"]
  Classification["classification -> landing"]
  Landing["landing finds match cards"]
  Hosting["hosting opens watch page<br/>activates player<br/>switches servers"]
  Embedded["embedded handles iframe/player URL"]
  Streams["m3u8/mpd/mp4 streams"]
  Provider["provider + abuse contact"]
  Email["draft takedown emails"]
  UI["run detail shows Agent desk, streams, screenshots, providers, emails"]

  URL --> Classification --> Landing --> Hosting --> Embedded --> Streams --> Provider --> Email --> UI
```

## Failure Path

```mermaid
flowchart LR
  URL["URL"]
  Memory["orchestrator memory check"]
  Classify["classification"]
  ToolErrors["navigate/inspect/open_url errors"]
  Unknown["classification returns unknown/other"]
  NoStreams["no stream URLs"]
  SkipProvider["provider analysis skipped"]
  SkipEmail["email generation skipped"]
  Failed["final_status failed or page_inaccessible"]

  URL --> Memory --> Classify --> ToolErrors --> Unknown --> NoStreams --> SkipProvider --> SkipEmail --> Failed
```

