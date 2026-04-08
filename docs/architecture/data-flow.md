# Data Flow

## Workflow

```text
Incoming URL
  -> ClassificationAgent
  -> Orchestrator decision
  -> LandingPageAgent or HostingPageAgent or EmbeddedPageAgent
  -> Stream extraction
  -> Provider analysis
  -> Takedown email drafting
  -> Persistence to Postgres
  -> Streaming + dashboards in Next.js
```

## Detailed Steps

1. The user or UI starts a workflow through `POST /run` or `POST /ui/workflows/run`.
2. The orchestrator creates a run observer in the in-memory registry.
3. Classification determines whether the page is landing, hosting, or embedded.
4. The orchestrator routes into the appropriate specialized agent path.
5. Agents call MCP tools through profile-scoped tool sessions.
6. The observer records runtime events, tool calls, token usage, and estimated costs.
7. Provider analysis and takedown generation run after stream extraction.
8. The final result and normalized telemetry are persisted to Postgres.
9. The operator console reads persisted data and, for active runs, subscribes to SSE streaming.

## Observability Flow

```text
agent/tool activity
  -> RunObserver
  -> Runtime events + metrics
  -> RunRepository normalized writes
  -> OperatorConsoleRepository queries
  -> Next.js dashboards and drill-downs
```

## Evaluation Flow

```text
evaluation suite
  -> synthetic / mocked / live execution
  -> rule-based scoring
  -> evaluation_runs + evaluation_case_results
  -> evaluation dashboard
```
