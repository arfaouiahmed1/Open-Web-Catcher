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
- `POST /ui/tools/call`
- `GET /ui/pricing`
- `PUT /ui/pricing`
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
