# Dashboard Logging And Run Telemetry

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Run Lifecycle](./run-lifecycle.md) | Next: [Agent Desk](./agent-desk.md)

The dashboard is not reading raw terminal logs. It is assembled from active in-memory traces from `run_registry`, normalized Postgres rows written by `RunRepository`, and background job rows or fallback result payloads when normalized telemetry is incomplete.

This matters because a run can be visible before it finishes, after it finishes, or after a server restart. The UI needs to keep showing a coherent run detail page in all three cases.

## Logging Architecture

```mermaid
flowchart TB
  subgraph Runtime["Runtime execution"]
    Observer["RunObserver"]
    Events["RuntimeEvent objects"]
    Metrics["RunMetrics"]
    AgentLoop["Agent loop<br/>LLM + tools"]
    Orchestrator["Orchestrator graph"]
  end

  subgraph Persistence["Postgres persistence"]
    Snapshots["run_snapshots"]
    RuntimeEvents["runtime_events"]
    AgentRuns["agent_runs"]
    LlmCalls["llm_calls"]
    ToolCalls["tool_calls"]
    Usage["run_model_usage"]
    Streams["run_streams"]
    Providers["provider_analyses"]
    Emails["takedown_emails"]
    Jobs["background_jobs"]
  end

  subgraph UI["Operator console"]
    Detail["RunDetailPage"]
    Live["RunDetailLive"]
    Desk["Agent desk"]
    Tabs["outputs, streams/providers, browser, decisions/tasks"]
  end

  AgentLoop --> Observer
  Orchestrator --> Observer
  Observer --> Events
  Observer --> Metrics
  Events --> Snapshots
  Events --> RuntimeEvents
  Metrics --> Usage
  AgentLoop --> AgentRuns
  AgentLoop --> LlmCalls
  AgentLoop --> ToolCalls
  Orchestrator --> Streams
  Orchestrator --> Providers
  Orchestrator --> Emails
  Orchestrator --> Jobs
  Snapshots --> Detail
  RuntimeEvents --> Detail
  AgentRuns --> Desk
  LlmCalls --> Desk
  ToolCalls --> Desk
  Streams --> Tabs
  Providers --> Tabs
  Emails --> Tabs
  Jobs --> Detail
```

## Runtime Events

`RunObserver.emit` creates an ordered event with `seq`, `actor`, `kind`, `status`, `message`, and `details`. The dashboard should prefer `details` when it needs machine-readable facts, and `message` when it needs short human text.

```mermaid
classDiagram
  class RuntimeEvent {
    +int seq
    +datetime timestamp
    +str actor
    +str kind
    +str message
    +str status
    +dict details
  }

  class RuntimeEventRecord {
    +int pipeline_run_id
    +int agent_run_id
    +str actor
    +int seq
    +str kind
    +str status
    +str message
    +dict details_json
    +datetime created_at
  }

  RuntimeEvent --> RuntimeEventRecord
```

## LLM Usage Logging

`RunObserver.add_llm_usage` aggregates model usage immediately when an LLM response is observed. It reads provider usage metadata, extracts cache counters where available, resolves pricing, and updates both run totals and per-model totals.

The persisted `llm_calls` rows provide per-call detail. The persisted `run_model_usage` rows provide grouped totals by provider and model. The frontend uses detailed LLM rows for call timelines and model attempts, grouped usage rows for cost and model summary cards, and pricing catalog rows to estimate cost when a call did not store complete cost fields.

```mermaid
flowchart LR
  Response["Gemini AIMessage<br/>usage_metadata + response_metadata"]
  Extract["extract tokens<br/>input, cached, new, output, thinking"]
  Pricing["resolve_model_pricing<br/>provider/model catalog"]
  Cost["estimate_usage_cost<br/>input + cached + cache write + output"]
  Metrics["RunMetrics totals"]
  LlmRows["llm_calls"]
  UsageRows["run_model_usage"]
  Frontend["pricing.js<br/>estimateRunCost / peakContextUsage"]

  Response --> Extract
  Extract --> Pricing
  Pricing --> Cost
  Cost --> Metrics
  Metrics --> UsageRows
  Extract --> LlmRows
  LlmRows --> Frontend
  UsageRows --> Frontend
```

## Tool Output Logging

Tools are logged in two forms: runtime events, which are available immediately over SSE, and normalized `tool_calls`, which are useful after the run and for reliability summaries.

The event layer records `tool_call_started` and `tool_call_finished`. The finished event includes result previews and, when available, full serialized result text. The persistence layer stores arguments, target summary, status, duration, preview, and error text.

Tool output can be large, so the UI should show previews by default and expose details where needed. For browser tools, the important evidence is usually not the raw payload alone; it is the screenshot URL, stream URL, selected element, frame path, network observation, or timeout/error string extracted from the tool result.

```mermaid
sequenceDiagram
  participant AgentLoop as run_agent_loop
  participant Tool as MCP tool
  participant Observer as RunObserver
  participant DB as tool_calls/runtime_events
  participant UI as Agent desk

  AgentLoop->>Observer: tool_call_started(tool_name, args, bootstrap?)
  AgentLoop->>Tool: invoke with timeout
  alt success
    Tool-->>AgentLoop: JSON/string result
    AgentLoop->>Observer: tool_call_finished(status=success, preview, full result)
  else timeout or exception
    AgentLoop->>Observer: tool_call_finished(status=error, error_text)
  end
  Observer->>DB: trace snapshot and normalized rows
  DB-->>UI: tool counts, recent milestones, tool table
```

## What The Frontend Uses

The current run detail route is `web/app/runs/[runId]/page.js`, which renders `RunDetailPage`. `RunDetailPage` fetches `GET /ui/runs/{run_id}` through `web/lib/api.js`. It also loads pricing through `web/lib/pricing`.

`RunDetailLive` attaches to `GET /ui/runs/{run_id}/stream` for live updates and calls `POST /ui/runs/{run_id}/cancel`, `POST /ui/runs/{run_id}/sync-logs`, screenshot endpoints, and `POST /ui/providers/lookup`.

`AgentActivityBoard` builds compact per-actor cards from `agentRollups`, runtime `events`, and synthesized LLM rows. It uses `web/lib/run-trace.js` to map actors to stages and `web/lib/pricing.js` to compute context-window and cost information.

```mermaid
flowchart TD
  Page["RunDetailPage"]
  Api["apiFetch('/ui/runs/{id}')"]
  Payload["backend payload"]
  Live["RunDetailLive"]
  Board["AgentActivityBoard"]
  ProviderTab["StreamProviderTab"]
  BrowserTab["BrowserLiveView"]
  Pricing["loadPricing()"]
  TraceLib["run-trace.js"]

  Page --> Api --> Payload
  Payload --> Live
  Payload --> Board
  Payload --> ProviderTab
  Payload --> BrowserTab
  Pricing --> Page
  Pricing --> Board
  TraceLib --> Board
```

## Payload Source Priority

`GET /ui/runs/{run_id}` can return data from several paths. The current backend checks for active trace data, persisted normalized rows, snapshots, and job fallback payloads.

```mermaid
flowchart TD
  Request["GET /ui/runs/{run_id}"]
  Active["active run_registry trace?"]
  DB["normalized pipeline run rows?"]
  Snapshot["run_snapshots or job.result_json?"]
  Fallback["background job state only"]
  Payload["UI payload"]

  Request --> Active
  Active -->|"yes"| Payload
  Active -->|"no"| DB
  DB -->|"yes"| Payload
  DB -->|"no"| Snapshot
  Snapshot -->|"yes"| Payload
  Snapshot -->|"no"| Fallback
  Fallback --> Payload
```

If the payload source is `background_job_result`, the UI should treat telemetry as degraded. The page can still show final output, but some call-level rows may be missing.

## Dashboard Interpretation Rules

- `agent_rollups` tell the dashboard which actors ran and their status.
- `runtime_events` explain what those actors did and why.
- `llm_calls` answer model/provider/token/cost questions.
- `tool_calls` answer browser/tool behavior questions.
- `run_model_usage` gives a grouped cost and token summary.
- `run_streams`, attributed `run_screenshots`, `provider_analyses`, and `takedown_emails` are the evidence products of the run.
- `background_jobs` explains queued/running/retrying/cancelled job state even before a normalized `pipeline_runs` row exists.

For screenshots, the compatibility list `all_screenshots` still exists, but the richer UI path reads `screenshots[]` rows with `agent_run_id`, `actor`, `agent_type`, `invocation_index`, `tool_name`, `target_url`, and `seq`. This is how Summary can show which parallel hosting or embedded invocation produced each frame.

This separation is intentional. A failed run with no streams can still be a valuable run if it records the reason: page inaccessible, classification unknown, tool timeout, no hosting pages, no streams, or cancellation.
