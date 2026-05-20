# Troubleshooting

> **Navigation:** [Docs Home](../README.md) | [Section Index](./README.md) | Previous: [Validation](./validation.md) | Next: [Azure Container Apps Job](./azure-container-app-job-service-bus.md)

## Runtime Triage

```mermaid
flowchart TD
  Symptom["Run failed or UI looks wrong"]
  Health["GET /health"]
  Browser["GET /ui/browser/status"]
  RunPayload["GET /ui/runs/{run_id}"]
  Events["Check runtime_events"]
  Tools["Check tool_calls"]
  LLM["Check llm_calls"]
  Logs["docker compose logs owc / owc-tools / owc-web"]

  Symptom --> Health
  Health --> Browser
  Browser --> RunPayload
  RunPayload --> Events
  RunPayload --> Tools
  RunPayload --> LLM
  Events --> Logs
  Tools --> Logs
  LLM --> Logs
```

## Common Cases

| Symptom | First check |
| --- | --- |
| Launch blocked | `/ui/browser/status` and structured `blocking_reasons` |
| Run page blank | browser console/CORS plus `GET /ui/runs/{run_id}` |
| Agent stopped early | runtime events for `agent_stop_requested`, `llm_error`, `llm_timeout`, repeated tool/no-progress |
| No provider rows | verify `all_streams` and stream-like URLs |
| No emails | verify `provider_analysis` and `extraction_results` have stream evidence |
| Model setting ignored | `/ui/config` `model_selection_details` and `model_config_warnings` |
| Browser tools look stale | rebuild/restart `owc-tools` or `owc-tools-playwright` |

## Failure Diagnosis Sequence

```mermaid
sequenceDiagram
  participant Operator
  participant API as FastAPI
  participant DB as Postgres
  participant Tools as MCP Tools
  participant Logs as Docker Logs

  Operator->>API: GET /health
  Operator->>API: GET /ui/browser/status
  Operator->>API: GET /ui/runs/{run_id}
  API->>DB: fetch normalized run rows
  Operator->>API: GET /ui/database/runtime_events?limit=...
  Operator->>API: GET /ui/database/tool_calls?limit=...
  Operator->>API: GET /ui/database/llm_calls?limit=...
  Operator->>Tools: check MCP /health ports if needed
  Operator->>Logs: inspect container logs last
```

