# 2026-04-08 Agent Debugging and Fixes

This report documents the full debugging pass for stuck agent runs, missing live inference visibility, MCP connectivity failures, schema conversion failures, and provider quota handling.

## Scope

Validated from Dockerized runtime only:

- FastAPI backend (`owc`)
- MCP tools service (`owc-tools`)
- Next.js console (`owc-web`)
- Postgres persistence (`postgres`)

## Initial Symptoms

- Agent runs appeared to stream forever with little or no visible inference progress.
- Live event stream often stopped after startup events.
- Historical backend logs contained repeated `LLM timeout` and mixed stack traces.

## Root Causes Confirmed

1. Missing timeout boundaries around background workflow and agent tasks.
2. Missing lifecycle events for MCP session and LLM turn start/error states.
3. MCP server POST message handler mismatch with current SDK expectations, causing HTTP 400 during MCP messaging.
4. Gemini tool-schema conversion crash (`IndexError`) triggered by one tool schema (`query_elements`) shape.
5. External provider quotas (`429 RESOURCE_EXHAUSTED`) causing valid runs to fail after wiring was fixed.
6. Duplicate `pipeline_failed` terminal events in workflow failure path.

## Code Changes

### Backend runtime protections and observability

- `src/api/app.py`
  - Added timeout protection to background workflow and background single-agent execution.
  - Added helper to avoid duplicate terminal failure event emission (`_emit_failure_once`).
  - Added runtime config endpoints used by UI (`GET /ui/config`, `PUT /ui/config`).

- `src/agents/base.py`
  - Added per-tool timeout guard in tool execution path.
  - Added LLM turn timeout guard.
  - Added explicit LLM failure events:
    - `llm_turn_started`
    - `llm_timeout`
    - `llm_rate_limited`
    - `llm_error`
  - Added retry-delay parsing helper for quota error details.

- `src/tools/mcp_client.py`
  - Added MCP session lifecycle events:
    - `tool_session_connecting`
    - `tool_session_ready`
    - `tool_session_failed`
    - `tool_session_closed`
  - Added timeout handling when loading tools.
  - Added fallback tool-loading path using direct MCP session tool loading.

### Agent wiring updates

- `src/agents/classification.py`
- `src/agents/landing_page.py`
- `src/agents/hosting_page.py`
- `src/agents/embedded_page.py`

Each agent now passes observer context into MCP tool session creation so lifecycle events are visible in stream output.

### MCP server and tool schema fixes

- `tools_js/mcp-server.js`
  - Fixed MCP POST message handling to pass parsed body correctly to transport handler.
  - Resolved MCP HTTP 400 failures during tool session bootstrap.

- `tools_js/tool-registry.js`
- `tools_js/tools/context-tools.js`
- `tools_js/shared/tool-runtime.js`

Flattened `query_elements` attribute filter schema and kept backward compatibility in runtime handlers to avoid Gemini schema conversion crash.

### Next.js live stream visibility

- `web/components/run-studio.js`
  - Added rendering labels and feed inclusion for:
    - MCP session lifecycle events
    - `llm_turn_started`
    - `llm_timeout`
    - `llm_rate_limited`
    - `llm_error`

## Validation Performed

- Rebuilt and restarted affected containers after source edits.
- Validated MCP tools loading from live container runtime.
- Re-ran single-agent tests through API paths used by the operator console.
- Re-ran workflow path through API/SSE stream.
- Verified duplicate workflow failure event issue was fixed.
- Verified quota failures are now surfaced with explicit `llm_rate_limited` event.

### Commands used for verification

- `docker compose up -d --build owc`
- `docker compose up -d --build owc-web`
- `docker exec owc pytest -q tests/test_agent_api.py tests/test_mcp_client.py`
- Direct API smoke calls against:
  - `POST /ui/agents/test`
  - `POST /ui/workflows/run`
  - `GET /runs/{run_id}/events`
  - `GET /ui/runs/{run_id}/stream`

## Test Results

- `tests/test_agent_api.py`: pass
- `tests/test_mcp_client.py`: pass
- Combined run: `32 passed`

## Current Known External Blockers

1. Provider quota limits (Gemini free-tier or project quota)
   - Failure mode: `ChatGoogleGenerativeAIError`
   - Error class in stream: `llm_rate_limited`
   - Typical message: `429 RESOURCE_EXHAUSTED`

2. Cloudinary placeholder key still produces screenshot upload warnings
   - This does not block core agent loop execution.

## Operational Guidance

When debugging similar incidents:

1. Confirm container images were rebuilt after source edits.
2. Check run trace events first, not only aggregate status.
3. Verify MCP session lifecycle reaches `tool_session_ready`.
4. If `llm_rate_limited` appears, treat as provider-capacity issue, not runtime wiring.
5. Use `tests/test_agent_api.py` and `tests/test_mcp_client.py` as baseline regression checks.
