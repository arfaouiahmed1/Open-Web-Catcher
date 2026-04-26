# Troubleshooting

This page captures practical steps for diagnosing agent and workflow execution issues in the Dockerized environment.

## Quick Triage

1. Confirm services are healthy.
2. Confirm the run has live events.
3. Confirm MCP tools session reached ready state.
4. Confirm LLM failure class (timeout, quota, generic error).
5. Confirm containers were rebuilt after code edits.

## 1) Check Container Health

From repository root:

```powershell
docker compose ps
```

Expected healthy services:

- `owc`
- `owc-tools`
- `owc-web`
- `postgres`

## 2) Check Live Run Stream

Start a run from UI or API, then inspect event stream:

- `GET /ui/runs/{run_id}/stream`
- `GET /runs/{run_id}/events`

Look for this sequence:

1. `agent_started`
2. `prompt_compiled`
3. `tool_session_connecting`
4. `tool_session_ready`
5. `agent_loop_started`
6. `llm_turn_started`

If this sequence stops early, root cause is usually MCP connectivity, provider issue, or timeout.

## 3) MCP Session Diagnostics

Healthy MCP bootstrapping should emit:

- `tool_session_connecting`
- `tool_session_ready`
- later `tool_session_closed`

Failure signal:

- `tool_session_failed`

Typical causes:

- tools service unavailable
- route mismatch
- stale container image running old MCP server code

## 4) LLM Failure Diagnostics

### Timeout

Event:

- `llm_timeout`

Action:

- inspect model responsiveness
- tune timeout only after verifying provider health

### Quota / Rate limit

Event:

- `llm_rate_limited`

Typical message:

- `429 RESOURCE_EXHAUSTED`

Action:

- wait for retry window
- switch model/provider capacity
- use non-free-tier key/project as needed

### Generic provider/model failure

Event:

- `llm_error`

Action:

- inspect `error_type` and `error_preview` in event details

## 5) Rebuild Requirement (Critical)

This stack copies source code into Docker images at build time. Local source edits are not reflected until image rebuild.

Use:

```powershell
docker compose up -d --build owc owc-web owc-tools
```

If behavior does not match source code, verify active container file contents before deeper debugging.

## 6) Regression Test Baseline

Run the baseline API and MCP tests in backend container:

```powershell
docker exec owc pytest -q tests/test_agent_api.py tests/test_mcp_client.py
```

Expected result for current baseline:

- all tests pass

If you are running tests on the host instead of inside Docker, use the project virtualenv explicitly:

```powershell
.venv\Scripts\python.exe -m pytest tests/
```

If `pytest` is missing from `.venv`, reinstall the dev environment:

```powershell
uv venv .venv --python 3.11
uv pip install --python .venv\Scripts\python.exe -e ".[dev]"
```

For the web console, verify both the production build and the Vitest suite:

```powershell
cd web
npm run build
npm test
```

## 7) Known Non-Blocking Warnings

### Cloudinary key placeholder

Tools may report screenshot upload warnings when placeholder credentials are used. This does not block core extraction logic.

### Pydantic deprecation warnings

Current tool wrappers may emit class-config deprecation warnings. These are not functional blockers.
