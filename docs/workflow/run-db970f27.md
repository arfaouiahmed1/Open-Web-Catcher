# Example Run: db970f27-aadc-4a77-a976-781903658d56

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Agent Desk](./agent-desk.md) | Next: [Agents Index](../agents/README.md)

The provided URL is:

`http://localhost:3000/runs/db970f27-aadc-4a77-a976-781903658d56`

The backend payload is loaded from:

`GET http://localhost:8000/ui/runs/db970f27-aadc-4a77-a976-781903658d56`

This run targeted `https://hoofoot.ru/`. It is a useful failure-path example because it shows how the system records memory checks, tool failures, model attempts, route decisions, skipped provider/email stages, and cost/token metrics even when no stream is found.

## Observed Outcome

| Field | Value |
| --- | --- |
| Run ID | `db970f27-aadc-4a77-a976-781903658d56` |
| URL | `https://hoofoot.ru/` |
| Root actor | `orchestrator` |
| Primary provider/model | `google` / `gemini-3.1-flash-lite` |
| Classification | `unknown` with high confidence |
| Final status | failed / page inaccessible path |
| Streams | 0 |
| Screenshots | 0 |
| Provider analyses | 0 |
| Emails | 0 |
| LLM calls | 2 |
| Tool calls | 4 persisted in the classification agent rollup |
| Total estimated cost | about `$0.0036245` in the persisted payload |

## Failure Flow

```mermaid
flowchart TD
  Start["Pipeline started for https://hoofoot.ru/"]
  Memory["Orchestrator memory checked<br/>0 hints found"]
  CallClass["Calling classification agent<br/>reason: recheck page type before routing"]
  AgentStart["Classification agent started"]
  MemoryLookup["memory_lookup<br/>success"]
  Navigate["navigate https://hoofoot.ru/<br/>timeout after 45s"]
  Inspect["inspect<br/>Execution context destroyed"]
  LLMTool["Gemini requests open_url"]
  OpenUrl["open_url https://hoofoot.ru/<br/>timeout after 45s"]
  FinalLLM["Gemini final response<br/>CLASSIFICATION: other"]
  Parsed["Classification decided unknown<br/>confidence high"]
  Route["Classification route selected<br/>next_node=analyze_providers"]
  ProviderSkip["Provider analysis skipped<br/>no stream URLs found"]
  EmailSkip["Takedown generation skipped<br/>no stream URLs found"]
  Finish["Pipeline finished with failed status"]

  Start --> Memory --> CallClass --> AgentStart --> MemoryLookup --> Navigate --> Inspect --> LLMTool --> OpenUrl --> FinalLLM --> Parsed --> Route --> ProviderSkip --> EmailSkip --> Finish
```

## Backend Sequence For This Run

```mermaid
sequenceDiagram
  participant UI as RunDetailPage
  participant API as /ui/runs/{run_id}
  participant Repo as OperatorConsoleRepository
  participant Jobs as BackgroundJobRepository
  participant DB as Postgres
  participant Graph as OrchestratorAgent
  participant Classifier as ClassificationAgent
  participant MCP as classification MCP profile
  participant Gemini as Gemini

  UI->>API: GET /ui/runs/db970f27...
  API->>Jobs: load workflow job state
  API->>Repo: get_run_detail(run_id)
  Repo->>DB: read pipeline_runs, agent_runs, events, calls, model_usage
  API-->>UI: payload with run, snapshot, rollups, events, calls

  Graph->>Graph: memory check for all page types
  Graph->>Classifier: run(url=https://hoofoot.ru/)
  Classifier->>MCP: memory_lookup
  MCP-->>Classifier: no exact profile found
  Classifier->>MCP: navigate
  MCP-->>Classifier: timeout
  Classifier->>MCP: inspect
  MCP-->>Classifier: execution context destroyed
  Classifier->>Gemini: LLM turn with tool context
  Gemini-->>Classifier: open_url tool call
  Classifier->>MCP: open_url
  MCP-->>Classifier: timeout
  Classifier->>Gemini: final answer request
  Gemini-->>Classifier: classification other/unknown
  Classifier-->>Graph: ClassificationResult
  Graph->>Graph: provider/email stages skipped because no streams
```

## Payload Shape Used By The UI

```mermaid
classDiagram
  class UiRunDetailPayload {
    +run
    +snapshot
    +provider_analysis
    +takedown_emails
    +all_streams
    +all_screenshots
    +agent_runs
    +agent_outputs
    +agent_rollups
    +stage_rollups
    +parallelism
    +tool_calls
    +llm_calls
    +model_usage
    +events
    +decisions
    +tasks
    +job
    +job_state
  }

  class Run {
    +str run_id
    +str url
    +str page_type
    +str status
    +str final_status
    +bool success
    +int stream_count
    +int total_tokens_in
    +int total_tokens_out
    +int total_llm_calls
    +int total_tool_calls
    +float estimated_total_cost_usd
  }

  class AgentRollup {
    +str actor
    +str agent_type
    +str status
    +int tool_calls
    +int llm_calls
    +int input_tokens
    +int cached_input_tokens
    +int new_input_tokens
    +int output_tokens
    +float cost_usd
    +str output_summary
  }

  class ToolCall {
    +str tool_name
    +dict args_json
    +str status
    +float duration_seconds
    +str result_preview
    +str error_text
  }

  class LLMCall {
    +str provider
    +str model_name
    +str prompt_hash
    +str cache_mode
    +int input_tokens
    +int cached_input_tokens
    +int new_input_tokens
    +int output_tokens
    +int tool_calls_requested
    +list tools_requested
  }

  UiRunDetailPayload --> Run
  UiRunDetailPayload --> AgentRollup
  UiRunDetailPayload --> ToolCall
  UiRunDetailPayload --> LLMCall
```

## Tool Calls In The Failed Run

| Seq | Tool | Status | Meaning |
| ---: | --- | --- | --- |
| 1 | `memory_lookup` | success | No exact profile for `hoofoot.ru`; gather fresh evidence |
| 2 | `navigate` | error | Bootstrap navigation timed out after 45 seconds |
| 3 | `inspect` | error | Browser execution context was destroyed during navigation |
| 4 | `open_url` | error | Gemini-requested navigation also timed out after 45 seconds |

## Why Provider And Email Were Skipped

Provider analysis consumes provider-like stream URLs: HLS/DASH/MP4 URLs, tokenized stream manifests, or stream-like media paths. This run produced no `all_streams`, no server stream rows, and no screenshot evidence. The orchestrator therefore emitted explicit skip decisions instead of fabricating provider rows or email drafts.

```mermaid
flowchart LR
  Extraction["extraction_results = []"]
  Streams["all_streams = []"]
  Provider{"provider stream URLs?"}
  ProviderSkip["Provider analysis skipped"]
  EmailSkip["Takedown draft generation skipped"]

  Extraction --> Streams --> Provider
  Provider -->|"no"| ProviderSkip --> EmailSkip
```

## Separate Success-Path Email Example

The run above did not generate emails. Current persisted email rows show the success shape from other runs: a provider, abuse contact, infringing page, stream URLs, screenshot URLs, and correlated `StreamEvidence`.

```mermaid
flowchart TD
  Stream["Captured stream URL<br/>m3u8/mpd/mp4"]
  Provider["ProviderInfo<br/>IP, hostname, org, abuse email"]
  Evidence["StreamEvidence<br/>server label, screenshot, page URL"]
  Email["TakedownEmail<br/>subject, body, evidence links"]

  Stream --> Provider
  Stream --> Evidence
  Provider --> Email
  Evidence --> Email
```

