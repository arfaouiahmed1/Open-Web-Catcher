# FastAPI API

The backend entrypoint is [`src/api/app.py`](../../src/api/app.py). It serves the core execution API and the operator-console API.

## Core Execution Routes

- `GET /health`
- `POST /classify`
- `POST /extract`
- `POST /run`
- `GET /runs`
- `GET /runs/{run_id}`
- `GET /runs/{run_id}/emails`
- `GET /runs/{run_id}/agents`
- `GET /runs/{run_id}/llm-calls`
- `GET /runs/{run_id}/tool-calls`
- `GET /runs/{run_id}/prompts`
- `GET /runs/{run_id}/events`
- `GET /memory`
- `GET /datasets/examples`
- `POST /datasets/export`
- `GET /observability`

## Operator Console Routes

- `GET /ui/overview`
- `GET /ui/runs`
- `GET /ui/runs/{run_id}`
- `GET /ui/runs/{run_id}/stream`
- `POST /ui/runs/{run_id}/cancel`
- `POST /ui/workflows/run`
- `POST /ui/agents/test`
- `GET /ui/config`
- `PUT /ui/config`
- `POST /ui/tools/call`
- `GET /ui/pricing`
- `PUT /ui/pricing`
- `POST /ui/pricing/sync`
- `GET /ui/evaluations/suites`
- `GET /ui/evaluations/runs`
- `GET /ui/evaluations/runs/{run_id}`
- `POST /ui/evaluations/run`
- `GET /ui/database/tables`
- `GET /ui/database/{table}`

## Streaming

`GET /ui/runs/{run_id}/stream` uses server-sent events. The payload includes:

- `run_id`
- `root_actor`
- `events`
- `metrics`
- `completed`
- `cancel_requested`
- `cancel_reason`

This is the feed used by the live workflow and agent labs.

Common event kinds include:

- `agent_started`
- `prompt_compiled`
- `tool_session_connecting`
- `tool_session_ready`
- `tool_session_failed`
- `tool_session_closed`
- `llm_turn_started`
- `llm_response`
- `llm_timeout`
- `llm_rate_limited`
- `llm_error`
- `tool_call_started`
- `tool_call_finished`
- `agent_finished`
- `agent_failed`
- `pipeline_started`
- `pipeline_failed`

## Runtime Model Config

The operator console can read and update active provider/model settings:

- `GET /ui/config`
- `PUT /ui/config`

`PUT /ui/config` updates in-memory runtime settings and attempts to persist non-secret fields to `configs/settings.yaml`.

## Provider Pricing Sync

`POST /ui/pricing/sync` fetches model pricing from provider APIs where supported, stores rows in Postgres, and refreshes runtime pricing config.

Current direct API sync support:

- `openrouter`

## Cost and Token Accounting

The backend computes first-party usage estimates from:

- token usage recorded during LLM calls
- pricing rows in Postgres
- `MODEL_PRICING_JSON` defaults from config

## Evaluations

Evaluation runs support:

- `synthetic`
- `mocked`
- `hybrid`
- `live`

Scoring is rule-based and stored in Postgres. It does not claim access to hidden chain-of-thought.
