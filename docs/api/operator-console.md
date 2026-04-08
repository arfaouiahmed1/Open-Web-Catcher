# Operator Console

The operator console lives in [`web/`](../../web) and is served on port `3001`.

## Pages

- `/` overview dashboard
- `/live` live workflow studio
- `/agents` agent lab
- `/tools` tool playground
- `/providers` provider intel
- `/runs` runs explorer
- `/runs/[runId]` run detail
- `/evaluations` evaluation lab
- `/database` database explorer
- `/settings` pricing settings

## Design Model

The console is built for operator workflows:

- graph-based workflow views
- structured live event streaming
- token and cost visibility
- drill-down into runs, tools, and LLM activity
- evaluation scoring and success rates
- clean Postgres inspection without direct SQL

## Live Streaming

The UI shows:

- event summaries
- tool requests
- tool result previews
- model content previews
- token totals
- estimated cost totals

It intentionally does not claim to show private hidden reasoning.

## Overview Metrics

The overview page reads from normalized Postgres tables and calculates:

- run counts and status percentages
- total and average cost
- total tokens, LLM calls, and tool calls
- tool success and failure rates
- stream yield and takedown-email yield
- model usage breakdown from `run_model_usage`
- provider breakdown from `provider_analyses`
- top-tool reliability from `tool_calls`
- seven-day run, token, cost, and latency trends

## Tool Playground

`POST /ui/tools/call` executes an MCP tool and persists a `tool_playground_calls` row with:

- profile
- tool name
- args
- status
- duration
- result payload
- error text
- origin (`playground` or `evaluation`)
- related run id when applicable

`GET /ui/tools/history` returns persisted operator and evaluation tool-call history for the console.

## Provider Intel

`POST /ui/providers/lookup` accepts a batch of stream URLs and performs deterministic IP/provider lookup using the backend provider-intelligence path.

The response includes:

- resolved rows for each checked URL
- per-batch stats for IP resolution, provider matches, abuse contacts, and uniqueness counts

`GET /ui/providers/history` returns persisted provider lookup history and aggregate trends from `provider_lookup_checks`.

## Database Explorer

The database explorer is read-only and limited to allowlisted tables exposed by the backend. It includes the normalized observability tables plus pricing, evaluation, and tool-playground history tables.

## Pricing

Pricing rows can be edited from the console. They are:

- persisted to Postgres
- merged into runtime pricing defaults
- used for future cost estimates

## Evaluations

The evaluation lab surfaces:

- success rate
- hallucination rate
- tool accuracy rate
- reliability rate
- average latency
- average cost
- per-case assertion outcomes
