"""FastAPI application for Open Web Catcher."""

from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from time import perf_counter
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.evaluation.datasets import build_dataset_examples, export_dataset_examples
from src.evaluation.scoring import evaluate_case_artifact
from src.evaluation.tracing import setup_tracing_from_settings
from src.models.schemas import (
    AgentTestRequest,
    ClassificationResult,
    DatabaseTableResponse,
    EvaluationRunRequest,
    ExtractionResult,
    OperatorOverview,
    PipelineResult,
    PricingConfig,
    ProviderLookupRequest,
    ToolPlaygroundRequest,
    WorkflowRunRequest,
)
from src.storage.database import create_tables, get_session
from src.storage.repositories import RunRepository
from src.storage.ui_repository import OperatorConsoleRepository
from src.tools.mcp_client import agent_tools
from src.utils.config import Settings
from src.utils.ipinfo import lookup_multiple
from src.utils.logging import get_logger, setup_logging
from src.utils.observability import get_observability_status, run_registry
from src.utils.provider_pricing import ProviderPricingSyncError, fetch_provider_pricing
from src.utils.service_health import probe_browser, probe_mcp

logger = get_logger(__name__)

_settings: Settings | None = None


class ClassifyRequest(BaseModel):
    url: str


class ExtractRequest(BaseModel):
    url: str
    page_type: Literal["landing_page", "hosting_page", "embedded_page"]


class RunRequest(BaseModel):
    url: str


class DatasetExportRequest(BaseModel):
    dataset_name: str = ""
    limit: int = 25
    path: str = ""


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.from_yaml()
    return _settings


def _cors_origins(settings: Settings) -> list[str]:
    return [item.strip() for item in settings.ui_cors_origins.split(",") if item.strip()]


def _merged_pricing_config(settings: Settings, config: PricingConfig) -> dict[str, dict[str, Any]]:
    try:
        merged = json.loads(settings.model_pricing_json or "{}")
    except json.JSONDecodeError:
        merged = {}
    if not isinstance(merged, dict):
        merged = {}
    merged[config.model_name] = {
        "provider": config.provider,
        "input_per_million": config.input_per_million,
        "output_per_million": config.output_per_million,
    }
    return merged


def _refresh_pricing_from_db(settings: Settings) -> None:
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        merged: dict[str, dict[str, Any]]
        try:
            merged = json.loads(settings.model_pricing_json or "{}")
        except json.JSONDecodeError:
            merged = {}
        if not isinstance(merged, dict):
            merged = {}
        try:
            configs = repo.list_pricing_configs()
        except Exception as exc:
            logger.warning("Skipping pricing refresh from database: %s", exc)
            return
        for config in configs:
            merged[config.model_name] = {
                "provider": config.provider,
                "input_per_million": config.input_per_million,
                "output_per_million": config.output_per_million,
            }
        settings.model_pricing_json = json.dumps(merged)
    finally:
        session.close()


def _sync_provider_pricing_to_db(
    settings: Settings,
    *,
    provider: str,
    max_models: int | None = None,
) -> dict[str, Any]:
    effective_provider = (provider or settings.llm_provider or "").strip().lower()
    rows = fetch_provider_pricing(
        settings,
        provider=effective_provider,
        timeout_seconds=max(1, int(settings.provider_pricing_timeout_seconds)),
        max_models=max_models if max_models is not None else max(1, int(settings.provider_pricing_max_models)),
    )

    session = get_session()
    try:
        stored = OperatorConsoleRepository(session).upsert_pricing_configs(rows)
    finally:
        session.close()

    _refresh_pricing_from_db(settings)
    return {
        "provider": effective_provider,
        "synced": len(rows),
        "stored": stored,
        "models": [item.model_name for item in rows],
    }


def _auto_sync_provider_pricing(settings: Settings) -> None:
    if not settings.provider_pricing_sync_enabled:
        return

    provider = (settings.llm_provider or "").strip().lower()
    try:
        payload = _sync_provider_pricing_to_db(settings, provider=provider)
    except NotImplementedError:
        logger.info("Provider pricing sync skipped: provider '%s' is not API-sync supported.", provider)
    except ProviderPricingSyncError as exc:
        logger.warning("Provider pricing sync failed: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Unexpected provider pricing sync failure: %s", exc)
    else:
        logger.info(
            "Provider pricing sync complete: provider=%s models=%d",
            payload["provider"],
            payload["stored"],
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    setup_logging(level=settings.log_level, log_file=settings.log_file)
    setup_tracing_from_settings(settings)
    create_tables()
    _refresh_pricing_from_db(settings)
    _auto_sync_provider_pricing(settings)
    logger.info(
        "Open Web Catcher API started | orchestrator=%s | agents=%s",
        settings.orchestrator_model,
        settings.agent_model,
    )
    yield
    logger.info("Open Web Catcher API shutting down")


app = FastAPI(
    title="Open Web Catcher",
    description=(
        "Multi-agent anti-piracy pipeline with a Next.js operator console: "
        "classify -> extract streams -> provider analysis -> takedown emails."
    ),
    version="0.2.0",
    lifespan=lifespan,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(get_settings()),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _active_trace_row(trace: Any) -> dict[str, Any]:
    metrics = trace.metrics
    return {
        "run_id": trace.run_id,
        "root_actor": trace.root_actor,
        "event_count": len(trace.events),
        "completed": trace.completed,
        "cancel_requested": trace.cancel_requested,
        "started_at": trace.started_at.isoformat(),
        "total_tool_calls": metrics.total_tool_calls if metrics else 0,
        "total_llm_calls": metrics.total_llm_calls if metrics else 0,
        "estimated_total_cost_usd": metrics.estimated_total_cost_usd if metrics else 0.0,
    }


def _emit_failure_once(observer, kind: str, message: str) -> None:
    """Emit a terminal failure event only when it is not already present at the tail."""
    trace = run_registry.get(observer.run_id)
    if trace is not None and trace.events:
        last = trace.events[-1]
        if last.kind == kind and last.message == message:
            return
    observer.emit(kind, message, status="error")


async def _run_selected_agent(agent_key: str, url: str, observer):
    normalized = (agent_key or "").strip().lower()
    settings = get_settings()
    if normalized == "classification":
        from src.agents.classification import ClassificationAgent

        return await ClassificationAgent(settings).run(url=url, observer=observer)
    if normalized == "landing":
        from src.agents.landing_page import LandingPageAgent

        return await LandingPageAgent(settings).run(url=url, observer=observer)
    if normalized == "hosting":
        from src.agents.hosting_page import HostingPageAgent

        return await HostingPageAgent(settings).run(url=url, observer=observer)
    if normalized == "embedded":
        from src.agents.embedded_page import EmbeddedPageAgent

        return await EmbeddedPageAgent(settings).run(url=url, observer=observer)
    raise ValueError(f"Unknown agent '{agent_key}'")


async def _persist_pipeline_result(result: PipelineResult) -> None:
    session = get_session()
    try:
        RunRepository(session).save(result, trace=run_registry.get(result.run_id))
    finally:
        session.close()


async def _background_workflow(run_id: str, url: str) -> None:
    from src.agents.orchestrator import run_pipeline as _run_pipeline

    settings = get_settings()
    observer = run_registry.create(
        run_id=run_id,
        root_actor="orchestrator",
        observability=get_observability_status(settings),
    )
    try:
        timeout_seconds = max(1, int(settings.agent_timeout_seconds))
        result = await asyncio.wait_for(
            _run_pipeline(url=url, settings=settings, observer=observer),
            timeout=timeout_seconds,
        )
        await _persist_pipeline_result(result)
    except asyncio.TimeoutError:
        message = f"Workflow timed out after {max(1, int(settings.agent_timeout_seconds))}s"
        _emit_failure_once(observer, "pipeline_failed", message)
        observer.finish(success=False, failure_mode="TimeoutError")
        logger.error("Background workflow timed out: run_id=%s timeout=%ss", run_id, max(1, int(settings.agent_timeout_seconds)))
    except Exception as exc:
        _emit_failure_once(observer, "pipeline_failed", str(exc))
        observer.finish(success=False, failure_mode=type(exc).__name__)
        logger.exception("Background workflow failed: %s", exc)


async def _background_agent(run_id: str, agent: str, url: str) -> None:
    settings = get_settings()
    observer = run_registry.create(
        run_id=run_id,
        root_actor=agent,
        observability=get_observability_status(settings),
    )
    observer.set_url(url)
    try:
        timeout_seconds = max(1, int(settings.agent_timeout_seconds))
        result = await asyncio.wait_for(_run_selected_agent(agent, url, observer), timeout=timeout_seconds)
        success = True
        failure_mode = ""
        if isinstance(result, ExtractionResult):
            success = result.status.value in {"success", "partial"}
            failure_mode = "" if success else result.status.value
        observer.finish(success=success, failure_mode=failure_mode)
    except asyncio.TimeoutError:
        message = f"Agent timed out after {max(1, int(settings.agent_timeout_seconds))}s"
        _emit_failure_once(observer, "agent_failed", message)
        observer.finish(success=False, failure_mode="TimeoutError")
        logger.error(
            "Background agent run timed out: run_id=%s agent=%s timeout=%ss",
            run_id,
            agent,
            max(1, int(settings.agent_timeout_seconds)),
        )
    except Exception as exc:
        _emit_failure_once(observer, "agent_failed", str(exc))
        observer.finish(success=False, failure_mode=type(exc).__name__)
        logger.exception("Background agent run failed: %s", exc)


async def _call_mcp_tool(profile: str, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    settings = get_settings()
    async with agent_tools(profile, settings) as tools:
        tool = next((item for item in tools if item.name == tool_name), None)
        if tool is None:
            raise HTTPException(status_code=404, detail=f"Tool '{tool_name}' not found for profile '{profile}'")
        result = await tool.ainvoke(args)
        if isinstance(result, str):
            try:
                parsed = json.loads(result)
            except json.JSONDecodeError:
                parsed = {"raw": result}
        else:
            parsed = result
        return parsed if isinstance(parsed, dict) else {"result": parsed}


def _persist_tool_playground_call(
    *,
    call_id: str,
    profile: str,
    tool_name: str,
    args: dict[str, Any],
    status: str,
    duration_seconds: float,
    result: dict[str, Any] | None = None,
    error_text: str = "",
    origin: str = "playground",
    related_run_id: str = "",
) -> dict[str, Any]:
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        return repo.record_tool_playground_call(
            call_id=call_id,
            profile=profile,
            tool_name=tool_name,
            args=args,
            status=status,
            duration_seconds=duration_seconds,
            result=result,
            error_text=error_text,
            origin=origin,
            related_run_id=related_run_id,
        )
    finally:
        session.close()


async def _execute_tool_call_with_telemetry(
    profile: str,
    tool_name: str,
    args: dict[str, Any],
    *,
    origin: str = "playground",
    related_run_id: str = "",
) -> dict[str, Any]:
    call_id = str(uuid.uuid4())
    started = perf_counter()
    try:
        result = await _call_mcp_tool(profile, tool_name, args)
    except HTTPException as exc:
        _persist_tool_playground_call(
            call_id=call_id,
            profile=profile,
            tool_name=tool_name,
            args=args,
            status="error",
            duration_seconds=perf_counter() - started,
            error_text=str(exc.detail),
            origin=origin,
            related_run_id=related_run_id,
        )
        raise
    except Exception as exc:
        _persist_tool_playground_call(
            call_id=call_id,
            profile=profile,
            tool_name=tool_name,
            args=args,
            status="error",
            duration_seconds=perf_counter() - started,
            error_text=str(exc),
            origin=origin,
            related_run_id=related_run_id,
        )
        raise

    record = _persist_tool_playground_call(
        call_id=call_id,
        profile=profile,
        tool_name=tool_name,
        args=args,
        status="success",
        duration_seconds=perf_counter() - started,
        result=result,
        origin=origin,
        related_run_id=related_run_id,
    )
    return {
        "call_id": call_id,
        "result": result,
        "record": record,
    }


def _provider_lookup_stats(rows: list[dict[str, Any]]) -> dict[str, Any]:
    providers = {row.get("provider", "") for row in rows if row.get("provider")}
    hosts = {row.get("hostname", "") for row in rows if row.get("hostname")}
    countries = {row.get("country", "") for row in rows if row.get("country")}
    return {
        "total_urls": len(rows),
        "resolved_ips": sum(1 for row in rows if row.get("ip")),
        "provider_matches": sum(1 for row in rows if row.get("provider")),
        "abuse_contacts_found": sum(1 for row in rows if row.get("abuse_email")),
        "unique_providers": len(providers),
        "unique_hosts": len(hosts),
        "unique_countries": len(countries),
        "unresolved_urls": sum(1 for row in rows if not row.get("ip")),
    }


def _provider_lookup_urls(stream_urls: list[str], settings: Settings) -> list[dict[str, Any]]:
    cleaned = [item.strip() for item in stream_urls if item and item.strip()]
    if not cleaned:
        raise HTTPException(status_code=400, detail="At least one stream URL is required")
    results = lookup_multiple(cleaned, ipinfo_token=settings.ipinfo_token, deduplicate_by_provider=False)
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        return repo.record_provider_lookup_batch(str(uuid.uuid4()), results)
    finally:
        session.close()


async def _stream_trace(run_id: str):
    last_seq = 0
    first_tick = True
    while True:
        trace = run_registry.get(run_id)
        if trace is None:
            payload = {"run_id": run_id, "events": [], "completed": True, "error": "run_not_found"}
            yield f"data: {json.dumps(payload, default=str)}\n\n"
            break

        new_events = [event.model_dump(mode="json") for event in trace.events if event.seq > last_seq]
        if first_tick or new_events or trace.completed:
            if new_events:
                last_seq = new_events[-1]["seq"]
            payload = {
                "run_id": run_id,
                "root_actor": trace.root_actor,
                "events": new_events,
                "metrics": trace.metrics.model_dump(mode="json") if trace.metrics else None,
                "completed": trace.completed,
                "cancel_requested": trace.cancel_requested,
                "cancel_reason": trace.cancel_reason,
            }
            yield f"data: {json.dumps(payload, default=str)}\n\n"
            first_tick = False

        if trace.completed:
            break
        await asyncio.sleep(0.8)


@app.get("/health")
def health():
    settings = get_settings()
    mcp_status = probe_mcp(settings.mcp_server_url)
    browser_status = probe_browser(settings.browser_ws_endpoint)
    return {
        "status": "ok",
        "orchestrator_model": settings.orchestrator_model,
        "agent_model": settings.agent_model,
        "browser_ws_endpoint": settings.browser_ws_endpoint,
        "mcp_server_url": settings.mcp_server_url,
        "dependencies": {"browser": browser_status, "mcp": mcp_status},
        "observability": get_observability_status(settings).model_dump(),
    }


@app.post("/classify", response_model=ClassificationResult)
async def classify(req: ClassifyRequest):
    from src.agents.classification import ClassificationAgent

    return await ClassificationAgent(get_settings()).run(url=req.url)


@app.post("/extract", response_model=ExtractionResult)
async def extract(req: ExtractRequest):
    settings = get_settings()
    if req.page_type == "landing_page":
        from src.agents.landing_page import LandingPageAgent

        return await LandingPageAgent(settings).run(req.url)
    if req.page_type == "hosting_page":
        from src.agents.hosting_page import HostingPageAgent

        return await HostingPageAgent(settings).run(req.url)
    if req.page_type == "embedded_page":
        from src.agents.embedded_page import EmbeddedPageAgent

        return await EmbeddedPageAgent(settings).run(req.url)
    raise HTTPException(status_code=400, detail=f"Unknown page_type: {req.page_type}")


@app.post("/run", response_model=PipelineResult)
async def run_pipeline(req: RunRequest):
    from src.agents.orchestrator import run_pipeline as _run_pipeline

    settings = get_settings()
    result = await _run_pipeline(url=req.url, settings=settings)
    await _persist_pipeline_result(result)
    return result


@app.get("/runs")
def list_runs(limit: int = 50):
    session = get_session()
    try:
        records = RunRepository(session).list_recent(limit=limit)
        return [
            {
                "run_id": r.run_id,
                "url": r.url,
                "page_type": r.page_type,
                "status": r.status,
                "streams_found": r.streams_found,
                "emails_generated": len((r.result_json or {}).get("takedown_emails", [])),
                "success": r.success,
                "duration_seconds": r.duration_seconds,
                "tool_calls": r.tool_calls,
                "tokens_in": r.tokens_in,
                "tokens_out": r.tokens_out,
                "estimated_total_cost_usd": ((r.result_json or {}).get("metrics") or {}).get("estimated_total_cost_usd", 0.0),
                "llm_calls": ((r.result_json or {}).get("metrics") or {}).get("total_llm_calls", 0),
                "message_count": ((r.result_json or {}).get("metrics") or {}).get("total_messages", 0),
                "created_at": r.created_at.isoformat(),
            }
            for r in records
        ]
    finally:
        session.close()


@app.get("/runs/{run_id}", response_model=PipelineResult)
def get_run(run_id: str):
    session = get_session()
    try:
        snapshot = RunRepository(session).get_run_snapshot(run_id)
        if snapshot is None:
            raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
        return snapshot
    finally:
        session.close()


@app.get("/runs/{run_id}/emails")
def get_run_emails(run_id: str):
    session = get_session()
    try:
        payload = RunRepository(session).get_run_emails(run_id)
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
        return payload
    finally:
        session.close()


@app.get("/runs/{run_id}/agents")
def get_run_agents(run_id: str):
    session = get_session()
    try:
        repo = RunRepository(session)
        rows = repo.list_agent_runs(run_id)
        if not rows:
            raise HTTPException(status_code=404, detail=f"No agent runs found for '{run_id}'")
        return {"run_id": run_id, "agent_runs": rows}
    finally:
        session.close()


@app.get("/runs/{run_id}/llm-calls")
def get_run_llm_calls(run_id: str):
    session = get_session()
    try:
        repo = RunRepository(session)
        rows = repo.list_llm_calls(run_id)
        if not rows:
            raise HTTPException(status_code=404, detail=f"No llm calls found for '{run_id}'")
        return {"run_id": run_id, "llm_calls": rows}
    finally:
        session.close()


@app.get("/runs/{run_id}/tool-calls")
def get_run_tool_calls(run_id: str):
    session = get_session()
    try:
        repo = RunRepository(session)
        rows = repo.list_tool_calls(run_id)
        if not rows:
            raise HTTPException(status_code=404, detail=f"No tool calls found for '{run_id}'")
        return {"run_id": run_id, "tool_calls": rows}
    finally:
        session.close()


@app.get("/runs/{run_id}/prompts")
def get_run_prompt_compilations(run_id: str):
    session = get_session()
    try:
        repo = RunRepository(session)
        rows = repo.list_prompt_compilations(run_id)
        if not rows:
            raise HTTPException(status_code=404, detail=f"No prompt compilations found for '{run_id}'")
        return {"run_id": run_id, "prompts": rows}
    finally:
        session.close()


@app.get("/memory")
def get_memory_entries(domain: str = "", page_type: str = "", limit: int = 50):
    session = get_session()
    try:
        repo = RunRepository(session)
        return {
            "domain": domain or None,
            "page_type": page_type or None,
            "entries": repo.list_memory_entries(
                domain=domain or None,
                page_type=page_type or None,
                limit=limit,
            ),
        }
    finally:
        session.close()


@app.get("/runs/{run_id}/events")
def get_run_events(run_id: str):
    trace = run_registry.get(run_id)
    if trace is None:
        raise HTTPException(status_code=404, detail=f"Run trace '{run_id}' not found")
    return trace.model_dump(mode="json")


@app.get("/datasets/examples")
def dataset_examples(limit: int = 25):
    settings = get_settings()
    session = get_session()
    try:
        records = RunRepository(session).list_recent(limit=limit)
        results: list[PipelineResult] = []
        for record in records:
            if not record.result_json:
                continue
            try:
                results.append(PipelineResult.model_validate(record.result_json))
            except Exception as exc:
                logger.warning("Skipping run '%s' during dataset build: %s", record.run_id, exc)
        examples = build_dataset_examples(results)
        return {
            "dataset_name": settings.default_dataset_name,
            "example_count": len(examples),
            "examples": [example.model_dump(mode="json") for example in examples],
        }
    finally:
        session.close()


@app.post("/datasets/export")
def export_dataset(req: DatasetExportRequest):
    settings = get_settings()
    session = get_session()
    try:
        records = RunRepository(session).list_recent(limit=req.limit)
        results: list[PipelineResult] = []
        for record in records:
            if not record.result_json:
                continue
            try:
                results.append(PipelineResult.model_validate(record.result_json))
            except Exception as exc:
                logger.warning("Skipping run '%s' during dataset export: %s", record.run_id, exc)
        examples = build_dataset_examples(results)
        export_path = export_dataset_examples(examples, settings=settings, dataset_name=req.dataset_name, path=req.path or None)
        return {
            "dataset_name": req.dataset_name or settings.default_dataset_name,
            "example_count": len(examples),
            "path": str(export_path),
        }
    finally:
        session.close()


@app.get("/observability")
def observability(limit: int = 10):
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        active = [_active_trace_row(trace) for trace in run_registry.list_recent(limit=limit)]
        return {
            "observability": get_observability_status(get_settings()).model_dump(),
            "overview": repo.get_overview(active_traces=active, limit=limit),
        }
    finally:
        session.close()


@app.get("/ui/overview", response_model=OperatorOverview)
def ui_overview(limit: int = 8):
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        active = [_active_trace_row(trace) for trace in run_registry.list_recent(limit=limit)]
        return repo.get_overview(active_traces=active, limit=limit)
    finally:
        session.close()


@app.get("/ui/runs")
def ui_runs(
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: str = "",
    page_type: str = "",
):
    session = get_session()
    try:
        return OperatorConsoleRepository(session).list_runs(limit=limit, offset=offset, status=status, page_type=page_type)
    finally:
        session.close()


@app.get("/ui/runs/{run_id}")
def ui_run_detail(run_id: str):
    active = run_registry.get(run_id)
    if active is not None and not active.completed:
        return {"active_trace": active.model_dump(mode="json")}

    session = get_session()
    try:
        payload = OperatorConsoleRepository(session).get_run_detail(run_id)
        if payload is None:
            raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
        return payload
    finally:
        session.close()


@app.get("/ui/runs/{run_id}/stream")
async def ui_run_stream(run_id: str):
    return StreamingResponse(_stream_trace(run_id), media_type="text/event-stream")


@app.post("/ui/runs/{run_id}/cancel")
def ui_cancel_run(run_id: str):
    success = run_registry.request_cancel(run_id, reason="Cancelled from the Next.js operator console.")
    if not success:
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found or already completed")
    return {"ok": True, "run_id": run_id}


@app.post("/ui/workflows/run")
async def ui_workflow_run(req: WorkflowRunRequest):
    run_id = str(uuid.uuid4())
    asyncio.create_task(_background_workflow(run_id, req.url))
    return {"run_id": run_id, "root_actor": "orchestrator"}


@app.post("/ui/agents/test")
async def ui_agent_test(req: AgentTestRequest):
    run_id = str(uuid.uuid4())
    asyncio.create_task(_background_agent(run_id, req.agent, req.url))
    return {"run_id": run_id, "root_actor": req.agent}


@app.post("/ui/tools/call")
async def ui_tool_call(req: ToolPlaygroundRequest):
    execution = await _execute_tool_call_with_telemetry(req.profile, req.tool_name, req.args)
    return {
        "call_id": execution["call_id"],
        "profile": req.profile,
        "tool_name": req.tool_name,
        "args": req.args,
        "result": execution["result"],
        "record": execution["record"],
    }


@app.get("/ui/tools/history")
def ui_tool_history(
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    profile: str = "",
    origin: str = "",
):
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        payload = repo.list_tool_playground_calls(limit=limit, offset=offset, profile=profile, origin=origin)
        payload["limit"] = limit
        payload["offset"] = offset
        return payload
    finally:
        session.close()


@app.post("/ui/providers/lookup")
def ui_provider_lookup(req: ProviderLookupRequest):
    rows = _provider_lookup_urls(req.stream_urls, get_settings())
    return {
        "rows": rows,
        "stats": _provider_lookup_stats(rows),
    }


@app.get("/ui/providers/history")
def ui_provider_history(
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    session = get_session()
    try:
        payload = OperatorConsoleRepository(session).get_provider_lookup_history(limit=limit, offset=offset)
        payload["limit"] = limit
        payload["offset"] = offset
        return payload
    finally:
        session.close()


class ModelConfigRequest(BaseModel):
    llm_provider: str = "google"
    agent_model: str = ""
    orchestrator_model: str = ""
    gemini_temperature: float | None = None
    provider_cache_enabled: bool | None = None
    tool_result_cache_enabled: bool | None = None
    tool_result_cache_min_identical_observations: int | None = None


class PricingSyncRequest(BaseModel):
    provider: str = ""
    max_models: int | None = None


@app.get("/ui/config")
def ui_get_config():
    """Return current LLM provider/model config and API key status."""
    s = get_settings()
    return {
        "llm_provider": s.llm_provider,
        "agent_model": s.agent_model,
        "orchestrator_model": s.orchestrator_model,
        "gemini_temperature": s.gemini_temperature,
        "provider_cache_enabled": s.provider_cache_enabled,
        "tool_result_cache_enabled": s.tool_result_cache_enabled,
        "tool_result_cache_min_identical_observations": s.tool_result_cache_min_identical_observations,
        "api_keys": {
            "google":      bool(s.google_api_key),
            "openai":      bool(s.openai_api_key),
            "anthropic":   bool(s.anthropic_api_key),
            "openrouter":  bool(s.openrouter_api_key),
        },
    }


@app.put("/ui/config")
def ui_update_config(body: ModelConfigRequest):
    """Update active LLM provider/model at runtime and persist to settings.yaml."""
    s = get_settings()
    if body.llm_provider:
        s.llm_provider = body.llm_provider
    if body.agent_model:
        s.agent_model = body.agent_model
    if body.orchestrator_model:
        s.orchestrator_model = body.orchestrator_model
    if body.gemini_temperature is not None:
        s.gemini_temperature = body.gemini_temperature
    if body.provider_cache_enabled is not None:
        s.provider_cache_enabled = body.provider_cache_enabled
    if body.tool_result_cache_enabled is not None:
        s.tool_result_cache_enabled = body.tool_result_cache_enabled
    if body.tool_result_cache_min_identical_observations is not None:
        s.tool_result_cache_min_identical_observations = max(
            1,
            int(body.tool_result_cache_min_identical_observations),
        )
    try:
        s.save_yaml()
    except Exception as exc:
        logger.warning("Could not persist settings.yaml: %s", exc)
    return ui_get_config()


@app.get("/ui/pricing")
def ui_pricing():
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        stored = [item.model_dump(mode="json") for item in repo.list_pricing_configs()]
        try:
            env_defaults = json.loads(get_settings().model_pricing_json or "{}")
        except json.JSONDecodeError:
            env_defaults = {}
        return {
            "stored": stored,
            "env_defaults": env_defaults,
            "effective_models": get_observability_status(get_settings()).pricing_models,
        }
    finally:
        session.close()


@app.put("/ui/pricing")
def ui_update_pricing(config: PricingConfig):
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        saved = repo.upsert_pricing_config(config)
        settings = get_settings()
        settings.model_pricing_json = json.dumps(_merged_pricing_config(settings, saved))
        return saved.model_dump(mode="json")
    finally:
        session.close()


@app.post("/ui/pricing/sync")
def ui_sync_pricing(req: PricingSyncRequest):
    settings = get_settings()
    provider = (req.provider or settings.llm_provider or "").strip().lower()
    max_models = req.max_models

    try:
        return _sync_provider_pricing_to_db(settings, provider=provider, max_models=max_models)
    except NotImplementedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProviderPricingSyncError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/ui/evaluations/suites")
def ui_evaluation_suites():
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        repo.ensure_default_evaluation_suites()
        return {"suites": [suite.model_dump(mode="json") for suite in repo.list_evaluation_suites()]}
    finally:
        session.close()


@app.get("/ui/evaluations/runs")
def ui_evaluation_runs(limit: int = 20):
    session = get_session()
    try:
        return {"runs": OperatorConsoleRepository(session).list_evaluation_runs(limit=limit)}
    finally:
        session.close()


@app.get("/ui/evaluations/runs/{run_id}")
def ui_evaluation_run_detail(run_id: str):
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        try:
            return repo.get_evaluation_run(run_id).model_dump(mode="json")
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    finally:
        session.close()


@app.post("/ui/evaluations/run")
async def ui_evaluation_run(req: EvaluationRunRequest):
    settings = get_settings()
    session = get_session()
    repo = OperatorConsoleRepository(session)
    try:
        suites = repo.ensure_default_evaluation_suites()
        suite = next((item for item in suites if item.id == req.suite_id), suites[0] if suites else None)
        if suite is None:
            raise HTTPException(status_code=404, detail="No evaluation suites available")

        run_id = str(uuid.uuid4())
        repo.create_evaluation_run(suite.id, suite.name, req.mode or suite.mode, run_id)

        case_results = []
        for case in [item for item in suite.cases if item.active]:
            artifact: dict[str, Any] = {}
            trace_payload: dict[str, Any] = {}
            latency_ms = 0.0
            total_cost = 0.0
            mode = case.mode if req.mode == "hybrid" else req.mode

            if mode in {"synthetic", "mocked"}:
                artifact = case.input.get("artifact", {})
                trace_payload = case.input.get("trace", {})
            elif case.target_type == "workflow":
                observer = run_registry.create(
                    run_id=str(uuid.uuid4()),
                    root_actor="orchestrator",
                    observability=get_observability_status(settings),
                )
                from src.agents.orchestrator import run_pipeline as _run_pipeline

                result = await _run_pipeline(url=case.input.get("url", ""), settings=settings, observer=observer)
                await _persist_pipeline_result(result)
                artifact = result.model_dump(mode="json")
                trace_model = observer.trace()
                trace_payload = trace_model.model_dump(mode="json")
                latency_ms = (trace_model.metrics.total_duration_seconds if trace_model.metrics else 0.0) * 1000.0
                total_cost = trace_model.metrics.estimated_total_cost_usd if trace_model.metrics else 0.0
            elif case.target_type == "agent":
                agent_name = case.input.get("agent", "classification")
                observer = run_registry.create(
                    run_id=str(uuid.uuid4()),
                    root_actor=agent_name,
                    observability=get_observability_status(settings),
                )
                observer.set_url(case.input.get("url", ""))
                result = await _run_selected_agent(agent_name, case.input.get("url", ""), observer)
                observer.finish(success=True, failure_mode="")
                artifact = result.model_dump(mode="json") if hasattr(result, "model_dump") else {}
                trace_model = observer.trace()
                trace_payload = trace_model.model_dump(mode="json")
                latency_ms = (trace_model.metrics.total_duration_seconds if trace_model.metrics else 0.0) * 1000.0
                total_cost = trace_model.metrics.estimated_total_cost_usd if trace_model.metrics else 0.0
            elif case.target_type == "tool":
                artifact = {
                    "result": (
                        await _execute_tool_call_with_telemetry(
                            case.input.get("profile", "hosting"),
                            case.input.get("tool_name", ""),
                            case.input.get("args", {}),
                            origin="evaluation",
                            related_run_id=run_id,
                        )
                    )["result"]
                }
                trace_payload = {"events": []}

            case_results.append(
                evaluate_case_artifact(
                    case,
                    artifact=artifact,
                    trace=trace_payload,
                    latency_ms=latency_ms,
                    total_cost_usd=total_cost,
                )
            )

        summary = {
            "suite_name": suite.name,
            "mode": req.mode,
            "case_count": len(case_results),
            "pass_count": sum(1 for item in case_results if item.status == "passed"),
        }
        finalized = repo.finalize_evaluation_run(run_id, case_results=case_results, summary=summary)
        return finalized.model_dump(mode="json")
    finally:
        session.close()


@app.get("/ui/database/tables")
def ui_database_tables():
    return {"tables": sorted(OperatorConsoleRepository.TABLE_MAP.keys())}


@app.get("/ui/database/{table}", response_model=DatabaseTableResponse)
def ui_database_table(
    table: str,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        try:
            return repo.list_database_table(table, limit=limit, offset=offset)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
    finally:
        session.close()
