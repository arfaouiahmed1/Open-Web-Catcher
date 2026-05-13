# Operator Console

The operator console lives in [`web/`](../../web) and is served on port `3000`.

## Pages

- `/` overview dashboard
- `/live` live workflow studio
- `/agents` redirect to `/live`
- `/tools` tool playground
- `/providers` provider intel
- `/runs` runs explorer
- `/runs/[runId]` run detail
- `/database` database explorer
- `/datasets` Postgres-backed dataset management and batch runs
- `/prompts` prompt management
- `/settings` runtime and pricing settings

## Frontend Structure

The console is now organized around thin route entrypoints and feature-owned component folders:

- `web/app/**/page.js` contains route entrypoints only
- `web/components/console/layout` contains shared shell modules
- `web/components/console/common` contains reusable page-level building blocks
- `web/components/console/<feature>` contains route-owned UI and helpers
- `web/components/ui` contains shadcn-style primitives and Radix wrappers

See [Frontend Console](../architecture/frontend-console.md) for the maintainer-facing module guide.

## Design Model

The console is built for operator workflows:

- graph-based workflow views
- structured live event streaming
- token and cost visibility
- drill-down into runs, tools, and LLM activity
- clean Postgres inspection without direct SQL

## Live Streaming

The UI shows:

- event summaries
- tool requests
- tool result previews
- model content previews
- token totals
- estimated cost totals

Live event stream now also includes explicit lifecycle and failure markers:

- MCP tool session lifecycle:
	- `tool_session_connecting`
	- `tool_session_ready`
	- `tool_session_failed`
	- `tool_session_closed`
- LLM lifecycle and failure classes:
	- `llm_turn_started`
	- `llm_response`
	- `llm_timeout`
	- `llm_rate_limited` (provider quota/capacity)
	- `llm_error` (non-timeout provider/model failures)

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
- origin (`playground`)
- related run id when applicable

`GET /ui/tools/history` returns persisted operator tool-call history for the console.

## Provider Intel

`POST /ui/providers/lookup` accepts a batch of stream URLs and performs deterministic IP/provider lookup using the backend provider-intelligence path.

The response includes:

- resolved rows for each checked URL
- per-batch stats for IP resolution, provider matches, abuse contacts, and uniqueness counts

`GET /ui/providers/history` returns persisted provider lookup history and aggregate trends from `provider_lookup_checks`.

## Database Explorer

The database explorer is read-only and limited to allowlisted tables exposed by the backend. It includes the normalized observability tables plus pricing and tool-playground history tables.

## Pricing

Pricing rows can be edited from the console. They are:

- persisted to Postgres
- merged into runtime pricing defaults
- used for future cost estimates

Model provider/model runtime config can also be managed from the console via:

- `GET /ui/config`
- `PUT /ui/config`

Run detail and overview surfaces focus on runtime health, provider and tool behavior, token usage, and cost telemetry.
