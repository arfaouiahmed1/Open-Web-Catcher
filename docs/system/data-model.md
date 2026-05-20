# Data Model And Persistence

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Deployment](./deployment.md) | Next: [Caching And Observability](./caching-observability.md)

Postgres stores both the final run result and the observability detail needed by the operator console. The central table is `pipeline_runs`; most runtime records link back to it by `pipeline_run_id`.

The schema is intentionally normalized because the dashboard asks different questions than the final pipeline output. A takedown review needs stream, provider, screenshot, and email evidence. A debugging session needs tool calls, model calls, prompt compilations, runtime events, and background job state. Storing those separately avoids treating the final JSON snapshot as the only source of truth.

## Table Families

| Family | Tables | Why it exists |
| --- | --- | --- |
| Run identity and summary | `pipeline_runs`, `run_snapshots`, legacy `runs` | stable run row, final status, aggregate counts, fallback full snapshot |
| Background execution | `background_jobs` | durable queued/running/retrying/cancelled job state before and after `pipeline_runs` exists |
| Agent observability | `agent_runs`, `agent_outputs`, `runtime_events` | actor-level timeline, stage status, normalized output summaries |
| Model telemetry | `llm_calls`, `run_model_usage`, `prompt_versions`, `prompt_compilations` | provider/model usage, cache fields, costs, prompt lineage |
| Tool telemetry | `tool_calls`, `tool_playground_calls` | browser tool attempts, result previews, playground history, reliability views |
| Evidence | `run_streams`, `run_screenshots`, `provider_analyses`, `takedown_emails` | final investigation evidence and email drafts |
| Operator annotations | `run_decisions`, `run_tasks` | event-derived or manually edited decisions/tasks in the run-detail UI |
| Memory | `memory_entries`, `memory_hints_used` | domain/page hints used as soft guidance |
| Datasets | `dataset_sites`, `dataset_batches`, `dataset_site_runs` | batch workflow testing and site-run tracking |
| Pricing | `pricing_configs` | provider/model pricing and context windows used by UI estimates |

## Run Observability ER Diagram

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
    int total_tokens_in
    int total_cached_input_tokens
    int total_new_input_tokens
    int total_tokens_out
    float estimated_total_cost_usd
  }

  AGENT_RUNS {
    int id PK
    int pipeline_run_id FK
    string actor
    string agent_type
    text target_url
    string status
    int tool_calls_made
    int llm_calls_made
    bool prompt_compiled
    bool memory_injected
    int invocation_index
  }

  LLM_CALLS {
    int id PK
    int agent_run_id FK
    string provider
    string model_name
    string prompt_hash
    string cache_mode
    int input_tokens
    int cached_input_tokens
    int new_input_tokens
    int output_tokens
    float estimated_total_cost_usd
  }

  TOOL_CALLS {
    int id PK
    int agent_run_id FK
    string tool_name
    string status
    json args_json
    text result_preview
    text error_text
  }
```

## Runtime Schema Class Diagram

```mermaid
classDiagram
  class PipelineResult {
    +str run_id
    +str url
    +ClassificationResult? classification
    +list~MatchInfo~ matches
    +list~ExtractionResult~ extraction_results
    +ExtractionStatus final_status
    +list~StreamURL~ all_streams
    +list~str~ all_screenshots
    +list~ProviderInfo~ provider_analysis
    +list~TakedownEmail~ takedown_emails
    +RunMetrics? metrics
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
    +str participants
    +str channel
    +list~str~ iframes
    +list~str~ video_srcs
    +list~str~ player_urls
    +str route
    +str route_source
    +list~str~ redirect_chain
    +dict patterns
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
    +int tool_calls_used
    +float duration_seconds
    +str error_message
    +dict metadata
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
    +str detected_channel
    +list~dict~ network_diagnostics
    +list~dict~ iframe_diagnostics
  }

  class StreamURL {
    +str url
    +str protocol
    +str quality
    +str source_layer
    +str channel_name
    +datetime captured_at
  }

  PipelineResult --> ClassificationResult
  PipelineResult --> MatchInfo
  PipelineResult --> ExtractionResult
  PipelineResult --> StreamURL
  ExtractionResult --> ServerResult
  ExtractionResult --> StreamURL
```

## Provider And Email Evidence Diagram

```mermaid
classDiagram
  class ProviderInfo {
    +str stream_url
    +str ip
    +str hostname
    +str org
    +str provider
    +str country
    +str region
    +str city
    +str abuse_email
    +str whois_raw
  }

  class StreamEvidence {
    +str stream_url
    +str protocol
    +str source_layer
    +str server_label
    +str channel_name
    +list~str~ screenshot_urls
    +str page_url
    +str provider_hostname
    +str ocr_text
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
    +list~str~ server_labels
    +list~StreamEvidence~ stream_evidence
    +ProviderInfo? provider_info
    +str rights_owner_reference_url
    +datetime generated_at
  }

  TakedownEmail --> ProviderInfo
  TakedownEmail --> StreamEvidence
```

## Dataset ER Diagram

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
    int requested_count
    int completed_count
    int passed_count
    int failed_count
    int cancelled_count
    json urls_json
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

## Prompt And Memory ER Diagram

```mermaid
erDiagram
  PROMPT_VERSIONS ||--o{ PROMPT_COMPILATIONS : compiles
  AGENT_RUNS ||--o{ PROMPT_COMPILATIONS : owns
  AGENT_RUNS ||--o{ MEMORY_HINTS_USED : used
  MEMORY_ENTRIES ||--o{ MEMORY_HINTS_USED : referenced

  PROMPT_VERSIONS {
    int id PK
    string agent_id
    text source_path
    string content_hash
    bool active
  }

  PROMPT_COMPILATIONS {
    int id PK
    int prompt_version_id FK
    int agent_run_id FK
    string cache_mode
    string compiled_prompt_hash
    text provider_cache_key
    bool provider_cache_eligible
    bool static_cache_hit
    bool memory_injected
    json sections_json
  }

  MEMORY_ENTRIES {
    int id PK
    string domain
    string page_type
    string source_run_id
    string status
    bool success
    text url
    json data_json
  }

  MEMORY_HINTS_USED {
    int id PK
    int agent_run_id FK
    int memory_entry_id FK
  }
```

## Persistence Flow

```mermaid
sequenceDiagram
  participant Runtime as Agent/orchestrator runtime
  participant Observer as RunObserver
  participant Repo as RunRepository
  participant DB as Postgres
  participant UIRepo as OperatorConsoleRepository
  participant UI as Next.js dashboard

  Runtime->>Observer: emit events and add usage
  Runtime->>Repo: save_trace_snapshot periodically
  Repo->>DB: upsert run_snapshots and runtime_events
  Runtime->>Repo: save PipelineResult at finish
  Repo->>DB: write pipeline_runs, agent_runs, llm_calls, tool_calls, evidence
  UI->>UIRepo: GET /ui/runs/{run_id}
  UIRepo->>DB: read normalized rows and job state
  UIRepo-->>UI: assembled payload
```

## Why Snapshot And Normalized Rows Both Exist

`run_snapshots` preserves a broad trace/result payload that can be used as fallback when a run is still active or when normalization did not capture every field. Normalized rows make dashboards, filters, cost rollups, and provider/email views practical.

The dashboard should prefer normalized rows when available because they support table views and aggregation. It can fall back to snapshots or `background_jobs.result_json` to avoid a blank detail page when a run failed before full persistence.
