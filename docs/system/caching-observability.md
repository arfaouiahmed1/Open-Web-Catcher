# Caching And Observability

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Data Model](./data-model.md) | Next: [Workflow Index](../workflow/README.md)

The runtime records what each model and tool did, how much it cost, whether cache was used, and why an agent stopped. This is the data behind the dashboard, run detail, Agent desk, provider view, and cost/context panels.

## Cache Layers

```mermaid
stateDiagram-v2
  [*] --> PromptCompile
  PromptCompile --> StaticPromptCache: prompt_cache_enabled
  StaticPromptCache --> ProviderEligible: static prefix long enough
  ProviderEligible --> ProviderHook: cache_mode provider_hook
  ProviderEligible --> ProviderActive: cache_mode provider_active
  ProviderHook --> LLMCall: provider cache metadata attached
  ProviderActive --> LLMCall: cached content resource available
  LLMCall --> CacheRead: provider reports cached tokens
  LLMCall --> CacheWrite: provider creates/refreshes cached content
  LLMCall --> NoProviderCache: tools disable active Gemini cached content
  CacheRead --> Metrics
  CacheWrite --> Metrics
  NoProviderCache --> Metrics
```

## Tool Result Cache

```mermaid
flowchart TD
  ToolCall["Tool call requested"]
  Mutating{"State mutating tool?"}
  Key["Build cache key<br/>tool name + args + generation"]
  Hit{"Cached identical result?"}
  Invoke["Invoke MCP tool"]
  Observe["Record result and observation"]
  Repeat{"Repeated observation threshold met?"}
  Write["Write result cache"]
  Return["Return tool result"]

  ToolCall --> Mutating
  Mutating -->|"yes"| Invoke
  Mutating -->|"no"| Key
  Key --> Hit
  Hit -->|"yes"| Return
  Hit -->|"no"| Invoke
  Invoke --> Observe
  Observe --> Repeat
  Repeat -->|"yes"| Write
  Repeat -->|"no"| Return
  Write --> Return
```

## Observability Event Flow

```mermaid
sequenceDiagram
  participant Agent as Agent loop
  participant Observer as RunObserver
  participant Trace as run_registry
  participant Persist as trace persist loop
  participant Repo as RunRepository
  participant DB as Postgres
  participant UI as Run detail UI

  Agent->>Observer: emit tool/LLM/lifecycle event
  Observer->>Trace: append event + update metrics
  Persist->>Trace: snapshot active trace
  Persist->>Repo: persist trace snapshot
  Repo->>DB: write runtime_events, calls, metrics
  UI->>Trace: GET /ui/runs/{id}/stream while active
  UI->>DB: GET /ui/runs/{id} after completion
```

## Metrics Class Diagram

```mermaid
classDiagram
  class RunMetrics {
    +str run_id
    +str url
    +datetime started_at
    +datetime finished_at
    +int total_tokens_in
    +int total_cached_input_tokens
    +int total_new_input_tokens
    +int total_tokens_out
    +int total_llm_calls
    +int total_cache_hit_calls
    +int total_tool_calls
    +int total_messages
    +float estimated_input_cost_usd
    +float estimated_cached_input_cost_usd
    +float estimated_cache_write_cost_usd
    +float estimated_output_cost_usd
    +float estimated_total_cost_usd
    +list~AgentType~ agents_invoked
    +list~ModelUsage~ model_usage
  }

  class ModelUsage {
    +str model_name
    +str provider
    +int llm_calls
    +int cache_hit_calls
    +int input_tokens
    +int cached_input_tokens
    +int new_input_tokens
    +int output_tokens
    +float estimated_total_cost_usd
  }

  RunMetrics --> ModelUsage
```

## Telemetry Data Flow

```mermaid
flowchart LR
  LLM["Gemini response metadata"]
  Tool["MCP tool result"]
  Events["runtime_events"]
  LLMCalls["llm_calls"]
  ToolCalls["tool_calls"]
  Usage["run_model_usage"]
  Rollups["agent_rollups<br/>stage_rollups"]
  UI["Run detail and dashboard"]

  LLM --> Events
  LLM --> LLMCalls
  LLMCalls --> Usage
  Tool --> Events
  Tool --> ToolCalls
  Events --> Rollups
  LLMCalls --> Rollups
  ToolCalls --> Rollups
  Usage --> UI
  Rollups --> UI
  Events --> UI
```

## Important Event Kinds

| Event | Meaning |
| --- | --- |
| `pipeline_started` / `pipeline_finished` | workflow lifecycle |
| `orchestrator_decision` | route choice, handoff, skip reason, or final routing explanation |
| `agent_started` / `agent_finished` / `agent_failed` | agent lifecycle |
| `prompt_compiled` | prompt hash, sections, cache mode, provider cache eligibility |
| `tool_session_connecting` / `tool_session_ready` / `tool_session_closed` | MCP session lifecycle |
| `tool_call_started` / `tool_call_finished` | tool execution and error surface |
| `llm_turn_started` / `llm_response` | model invocation and output |
| `llm_retry_scheduled` | transient provider retry handling |
| `llm_timeout` / `llm_rate_limited` / `llm_error` | provider failure visibility |
| `agent_stop_requested` | cancellation and cooperative stop |

