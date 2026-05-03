"""FastAPI application for Open Web Catcher."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import time as _time
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError

from src.agents.base import RunCancelledError
from src.evaluation.datasets import build_dataset_examples, export_dataset_examples
from src.evaluation.deepeval_bridge import EXPECTED_TOOLS_BY_PROFILE
from src.evaluation.scoring import evaluate_case_artifact
from src.evaluation.tracing import setup_tracing_from_settings
from src.models.schemas import (
    AgentTestRequest,
    ClassificationResult,
    DatabaseTableResponse,
    EvaluationAssertionResult,
    EvaluationCase,
    EvaluationCaseResult,
    EvaluationRunRequest,
    EvaluationSuite,
    ExtractionResult,
    OperatorOverview,
    PipelineResult,
    PricingConfig,
    ProviderLookupRequest,
    ToolPlaygroundRequest,
    WorkflowRunRequest,
)
from src.storage.database import create_tables, get_session
from src.storage.dataset_repository import DatasetRepository
from src.storage.repositories import BackgroundJobRepository, RunRepository
from src.storage.ui_repository import OperatorConsoleRepository
from src.tools.mcp_client import REQUIRED_TOOLS_BY_PROFILE, agent_tools
from src.utils.browser_runtime import (
    normalize_browser_runtime,
    normalize_disabled_tools_by_browser_profile,
)
from src.utils.config import Settings, build_browser_runtime_sync_status
from src.utils.console_state import (
    JOB_ACTIVE_STATUSES,
    JOB_TERMINAL_STATUSES,
    normalize_job_display_status,
)
from src.utils.ipinfo import lookup_multiple
from src.utils.logging import get_logger, setup_logging
from src.utils.observability import get_observability_status, run_registry
from src.utils.provider_models import (
    ProviderModelCatalogError,
    get_provider_model_catalog,
    normalize_agent_model_config,
    normalize_llm_tuning,
    resolve_agent_model_selection,
)
from src.utils.provider_pricing import ProviderPricingSyncError, fetch_provider_pricing
from src.utils.service_health import probe_browser, probe_mcp

logger = get_logger(__name__)

_settings: Settings | None = None

# ── Simple in-memory TTL cache for expensive read endpoints ──────────────
_TTL_CACHE: dict[str, tuple[float, Any]] = {}
_OVERVIEW_CACHE_TTL_SECONDS = 6.0  # overview is polled every 5–8 s; cache for 6 s
_SSE_KEEPALIVE_SECONDS = 20.0  # send SSE `: heartbeat` comment every 20 s


def _cache_get(key: str, ttl: float) -> Any | None:
    entry = _TTL_CACHE.get(key)
    if entry is None:
        return None
    ts, value = entry
    if _time.monotonic() - ts > ttl:
        _TTL_CACHE.pop(key, None)
        return None
    return value


def _cache_set(key: str, value: Any) -> None:
    _TTL_CACHE[key] = (_time.monotonic(), value)


def _cache_bust(prefix: str) -> None:
    for key in list(_TTL_CACHE.keys()):
        if key.startswith(prefix):
            _TTL_CACHE.pop(key, None)


@dataclass
class _PlaygroundToolSession:
    profile: str
    manager: Any
    tools: list[Any]
    opened_at: float
    last_used_at: float


_PLAYGROUND_SESSION_TTL_SECONDS = 15 * 60
_playground_tool_sessions: dict[str, _PlaygroundToolSession] = {}
_playground_tool_session_lock = asyncio.Lock()
_background_worker_task: asyncio.Task | None = None
_active_run_tasks: dict[str, asyncio.Task] = {}


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


class PromptUpdateRequest(BaseModel):
    content: str = ""


class PromptDryRunRequest(BaseModel):
    agent: str
    url: str
    content: str = ""


PROMPTS_DIR = Path("configs/prompts").resolve()
EVALUATION_MODES = {"hybrid", "synthetic", "mocked", "live"}
DEEPEVAL_DEFAULT_METRICS = [
    {
        "id": "hallucination",
        "label": "Hallucination",
        "threshold": 0.5,
        "kind": "llm_judge",
        "description": "Flags unsupported stream, provider, and evidence claims.",
    },
    {
        "id": "faithfulness",
        "label": "Faithfulness",
        "threshold": 0.7,
        "kind": "llm_judge",
        "description": "Checks whether takedown output stays grounded in tool evidence.",
    },
    {
        "id": "tool_correctness",
        "label": "Tool correctness",
        "threshold": 0.6,
        "kind": "deterministic",
        "description": "Verifies that the expected browser tools were actually used.",
    },
    {
        "id": "answer_relevancy",
        "label": "Answer relevancy",
        "threshold": 0.7,
        "kind": "llm_judge",
        "description": "Measures whether the final output stays relevant to the source URL.",
    },
    {
        "id": "task_completion",
        "label": "Task completion",
        "threshold": 0.6,
        "kind": "llm_judge",
        "description": "Measures whether the pipeline completed the takedown workflow goal.",
    },
]


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = Settings.from_yaml()
        try:
            _settings.save_browser_runtime_bridge()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not refresh browser runtime bridge on startup: %s", exc)
    return _settings


async def _close_playground_tool_session(profile: str) -> None:
    session: _PlaygroundToolSession | None = None
    async with _playground_tool_session_lock:
        session = _playground_tool_sessions.pop(profile, None)

    if session is None:
        return

    try:
        await session.manager.__aexit__(None, None, None)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Failed to close playground MCP session for '%s': %s", profile, exc)


async def _close_all_playground_tool_sessions() -> None:
    profiles: list[str]
    async with _playground_tool_session_lock:
        profiles = list(_playground_tool_sessions.keys())

    for profile in profiles:
        await _close_playground_tool_session(profile)


async def _cleanup_expired_playground_tool_sessions() -> None:
    now = perf_counter()
    profiles_to_close: list[str] = []
    async with _playground_tool_session_lock:
        for profile, session in list(_playground_tool_sessions.items()):
            if (now - session.last_used_at) >= _PLAYGROUND_SESSION_TTL_SECONDS:
                profiles_to_close.append(profile)

    for profile in profiles_to_close:
        await _close_playground_tool_session(profile)


def _track_run_task(run_id: str, task: asyncio.Task) -> asyncio.Task:
    _active_run_tasks[run_id] = task

    def _cleanup(completed_task: asyncio.Task) -> None:
        current = _active_run_tasks.get(run_id)
        if current is completed_task:
            _active_run_tasks.pop(run_id, None)

    task.add_done_callback(_cleanup)
    return task


async def _cancel_active_run_task(run_id: str) -> bool:
    task = _active_run_tasks.get(run_id)
    if task is None or task.done():
        return False
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    return True


async def _get_playground_tools(profile: str, settings: Settings) -> list[Any]:
    await _cleanup_expired_playground_tool_sessions()
    now = perf_counter()

    async with _playground_tool_session_lock:
        existing = _playground_tool_sessions.get(profile)
        if existing is not None:
            existing.last_used_at = now
            return existing.tools

    manager = agent_tools(profile, settings)
    tools = await manager.__aenter__()

    async with _playground_tool_session_lock:
        existing = _playground_tool_sessions.get(profile)
        if existing is None:
            _playground_tool_sessions[profile] = _PlaygroundToolSession(
                profile=profile,
                manager=manager,
                tools=tools,
                opened_at=now,
                last_used_at=now,
            )
            return tools

    # Another request initialized this profile first; close this duplicate.
    await manager.__aexit__(None, None, None)
    async with _playground_tool_session_lock:
        surviving = _playground_tool_sessions[profile]
        surviving.last_used_at = now
        return surviving.tools


async def _invoke_named_tool(
    tools: list[Any], profile: str, tool_name: str, args: dict[str, Any]
) -> dict[str, Any]:
    tool = next((item for item in tools if item.name == tool_name), None)
    if tool is None:
        raise HTTPException(
            status_code=404, detail=f"Tool '{tool_name}' not found for profile '{profile}'"
        )

    result = await tool.ainvoke(args)
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except json.JSONDecodeError:
            parsed = {"raw": result}
    else:
        parsed = result
    return parsed if isinstance(parsed, dict) else {"result": parsed}


def _cors_origins(settings: Settings) -> list[str]:
    return [item.strip() for item in settings.ui_cors_origins.split(",") if item.strip()]


def _normalize_evaluation_mode(value: str) -> str:
    normalized = str(value or "hybrid").strip().lower() or "hybrid"
    if normalized not in EVALUATION_MODES:
        raise HTTPException(status_code=400, detail=f"Unsupported evaluation mode '{value}'")
    return normalized


def _normalize_manual_batch_urls(values: list[str], *, max_urls: int = 40) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()

    for raw_value in values or []:
        url = str(raw_value or "").strip()
        if not url:
            continue
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise HTTPException(status_code=400, detail=f"Invalid website URL '{url}'")
        if url in seen:
            continue
        seen.add(url)
        normalized.append(url)

    if not normalized:
        raise HTTPException(
            status_code=400, detail="Provide at least one website URL for the manual batch."
        )
    if len(normalized) > max_urls:
        raise HTTPException(
            status_code=400, detail=f"Manual batches are limited to {max_urls} websites per run."
        )
    return normalized


def _manual_batch_case_name(url: str, index: int) -> str:
    host = (urlparse(url).netloc or "").replace("www.", "").strip()
    return host or f"website-{index:02d}"


def _build_manual_evaluation_suite(req: EvaluationRunRequest) -> EvaluationSuite:
    urls = _normalize_manual_batch_urls(req.urls)
    batch_name = str(req.batch_name or "").strip()
    effective_mode = _normalize_evaluation_mode(req.mode)
    if effective_mode not in {"hybrid", "live"}:
        raise HTTPException(
            status_code=400,
            detail="Manual website batches only support 'live' or 'hybrid' mode.",
        )
    return EvaluationSuite(
        name=batch_name or f"Manual Website Batch ({len(urls)})",
        description=f"Ad hoc website batch submitted from the operator console ({len(urls)} targets).",
        mode="live" if effective_mode == "hybrid" else effective_mode,
        active=True,
        config={
            "origin": "manual_batch",
            "input_urls": urls,
            "submitted_from": "ui",
        },
        cases=[
            EvaluationCase(
                name=_manual_batch_case_name(url, index + 1),
                description=url,
                mode="live",
                target_type="workflow",
                active=True,
                input={"url": url},
                assertions={
                    "required_tools": ["open_url"],
                    "forbidden_tools": ["delete_data"],
                },
                metadata={
                    "origin": "manual_batch",
                    "url": url,
                    "host": _manual_batch_case_name(url, index + 1),
                },
            )
            for index, url in enumerate(urls)
        ],
    )


def _evaluation_failure_result(
    case: EvaluationCase,
    *,
    message: str,
    artifact: dict[str, Any] | None = None,
    trace: dict[str, Any] | None = None,
    latency_ms: float = 0.0,
    total_cost_usd: float = 0.0,
) -> EvaluationCaseResult:
    safe_artifact = dict(artifact or {})
    if case.input.get("url") and not safe_artifact.get("url"):
        safe_artifact["url"] = case.input.get("url")
    safe_artifact.setdefault("final_status", "failed")
    safe_artifact.setdefault("status", "failed")
    safe_artifact.setdefault("error_message", message)

    return EvaluationCaseResult(
        case_id=case.id,
        case_name=case.name,
        status="failed",
        target_type=case.target_type,
        latency_ms=latency_ms,
        total_cost_usd=total_cost_usd,
        hallucination_score=1.0,
        tool_accuracy_score=0.0,
        reliability_score=0.0,
        assertion_results=[
            EvaluationAssertionResult(
                name="runtime_error",
                passed=False,
                expected="case execution completes",
                actual=message,
                message="The evaluation case raised an exception before it could be scored normally.",
            )
        ],
        output=safe_artifact,
        trace=trace or {"events": []},
    )


async def _execute_evaluation_case(
    case: EvaluationCase,
    *,
    requested_mode: str,
    settings: Settings,
    run_id: str,
) -> EvaluationCaseResult:
    artifact: dict[str, Any] = {}
    trace_payload: dict[str, Any] = {}
    latency_ms = 0.0
    total_cost = 0.0
    observer = None
    mode = case.mode if requested_mode == "hybrid" else requested_mode

    try:
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

            result = await _run_pipeline(
                url=case.input.get("url", ""), settings=settings, observer=observer
            )
            await _persist_pipeline_result(result)
            artifact = result.model_dump(mode="json")
            trace_model = observer.trace()
            trace_payload = trace_model.model_dump(mode="json")
            latency_ms = (
                trace_model.metrics.total_duration_seconds if trace_model.metrics else 0.0
            ) * 1000.0
            total_cost = (
                trace_model.metrics.estimated_total_cost_usd if trace_model.metrics else 0.0
            )
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
            latency_ms = (
                trace_model.metrics.total_duration_seconds if trace_model.metrics else 0.0
            ) * 1000.0
            total_cost = (
                trace_model.metrics.estimated_total_cost_usd if trace_model.metrics else 0.0
            )
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
        else:
            raise ValueError(f"Unsupported evaluation target_type '{case.target_type}'")

        return evaluate_case_artifact(
            case,
            artifact=artifact,
            trace=trace_payload,
            latency_ms=latency_ms,
            total_cost_usd=total_cost,
        )
    except Exception as exc:  # noqa: BLE001
        if observer is not None and not trace_payload:
            try:
                trace_model = observer.trace()
            except Exception:  # noqa: BLE001
                trace_model = None
            if trace_model is not None:
                trace_payload = trace_model.model_dump(mode="json")
                latency_ms = (
                    trace_model.metrics.total_duration_seconds if trace_model.metrics else 0.0
                ) * 1000.0
                total_cost = (
                    trace_model.metrics.estimated_total_cost_usd if trace_model.metrics else 0.0
                )

        logger.exception(
            "Evaluation case execution failed | eval_run=%s | case=%s | target_type=%s | mode=%s",
            run_id,
            case.name,
            case.target_type,
            mode,
        )
        return _evaluation_failure_result(
            case,
            message=str(exc) or exc.__class__.__name__,
            artifact=artifact,
            trace=trace_payload,
            latency_ms=latency_ms,
            total_cost_usd=total_cost,
        )


def _deepeval_lab_payload(settings: Settings) -> dict[str, Any]:
    deepeval_available = importlib.util.find_spec("deepeval") is not None
    openai_available = importlib.util.find_spec("openai") is not None
    openrouter_api_key_configured = bool(
        os.environ.get("OPENROUTER_API_KEY") or settings.openrouter_api_key
    )
    warnings: list[str] = []

    if not deepeval_available:
        warnings.append("deepeval is not installed in the current Python environment.")
    if not openai_available:
        warnings.append("The openai package used by the OpenRouter judge is not installed.")
    if not openrouter_api_key_configured:
        warnings.append(
            "OPENROUTER_API_KEY is not configured, so the LLM-judge metrics cannot run."
        )

    return {
        "ready": deepeval_available and openai_available and openrouter_api_key_configured,
        "deepeval_available": deepeval_available,
        "openai_package_available": openai_available,
        "openrouter_api_key_configured": openrouter_api_key_configured,
        "judge_model": os.environ.get("OPENROUTER_MODEL", "openai/gpt-4o-mini"),
        "metrics": DEEPEVAL_DEFAULT_METRICS,
        "profiles": [
            {"profile": profile, "expected_tools": tools}
            for profile, tools in EXPECTED_TOOLS_BY_PROFILE.items()
        ],
        "commands": {
            "pytest": "pytest tests/test_deepeval_metrics.py -v",
            "pytest_skip_marker": 'pytest -m "not deepeval"',
            "deepeval": "deepeval test run tests/test_deepeval_metrics.py",
        },
        "warnings": warnings,
    }


def _merged_pricing_config(settings: Settings, config: PricingConfig) -> dict[str, dict[str, Any]]:
    try:
        merged = json.loads(settings.model_pricing_json or "{}")
    except json.JSONDecodeError:
        merged = {}
    if not isinstance(merged, dict):
        merged = {}
    payload = {
        "provider": config.provider,
        "input_per_million": config.input_per_million,
        "output_per_million": config.output_per_million,
        "cached_input_per_million": config.cached_input_per_million,
        "cache_write_per_million": config.cache_write_per_million,
        "context_window": int(config.context_window or 0),
    }
    model_key = str(config.model_name or "").strip()
    provider_key = str(config.provider or "").strip().lower()
    if model_key:
        merged[model_key] = payload
        if provider_key:
            merged[f"{provider_key}::{model_key}"] = payload
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
            payload = {
                "provider": config.provider,
                "input_per_million": config.input_per_million,
                "output_per_million": config.output_per_million,
                "cached_input_per_million": config.cached_input_per_million,
                "cache_write_per_million": config.cache_write_per_million,
                "context_window": int(config.context_window or 0),
            }
            model_key = str(config.model_name or "").strip()
            provider_key = str(config.provider or "").strip().lower()
            if model_key:
                merged[model_key] = payload
                if provider_key:
                    merged[f"{provider_key}::{model_key}"] = payload
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
        max_models=max_models
        if max_models is not None
        else max(1, int(settings.provider_pricing_max_models)),
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
    if provider == "openrouter" and not (settings.openrouter_api_key or "").strip():
        logger.info("Provider pricing sync skipped: OPENROUTER_API_KEY is not set.")
        return

    try:
        payload = _sync_provider_pricing_to_db(settings, provider=provider)
    except NotImplementedError:
        logger.info("Provider pricing sync skipped: provider '%s' is not supported.", provider)
    except ProviderPricingSyncError as exc:
        logger.warning("Provider pricing sync failed for '%s': %s", provider, exc)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Unexpected provider pricing sync failure for '%s': %s", provider, exc)
    else:
        logger.info(
            "Provider pricing sync complete: provider=%s models=%d",
            payload["provider"],
            payload["stored"],
        )


def _recover_background_jobs() -> int:
    session = get_session()
    try:
        return BackgroundJobRepository(session).recover_stale_running(stale_after_seconds=180)
    except Exception as exc:  # noqa: BLE001
        logger.debug("Skipping background job recovery: %s", exc)
        return 0
    finally:
        session.close()


async def _process_background_job() -> bool:
    session = get_session()
    try:
        repo = BackgroundJobRepository(session)
        job = repo.claim_next(lease_seconds=90)
        if job is not None:
            DatasetRepository(session).mark_site_run_running(job.run_id)
    finally:
        session.close()

    if job is None:
        return False

    if run_registry.get(job.run_id) is None and not _restore_trace_from_db(job.run_id):
        observer = run_registry.create(
            run_id=job.run_id,
            root_actor=job.actor or ("orchestrator" if job.job_type == "workflow" else "agent"),
            observability=get_observability_status(get_settings()),
        )
        observer.set_url(job.url or "")

    if job.job_type == "workflow":
        execution = await _track_run_task(
            job.run_id,
            asyncio.create_task(_background_workflow(job.run_id, job.url)),
        )
    elif job.job_type == "agent":
        payload = job.payload_json or {}
        execution = await _track_run_task(
            job.run_id,
            asyncio.create_task(
                _background_agent(
                    job.run_id,
                    str(payload.get("agent", "") or job.actor or "classification"),
                    job.url,
                    prompt_override=str(payload.get("prompt_override", "") or ""),
                )
            ),
        )
    else:
        execution = {"ok": False, "error": f"Unsupported job type '{job.job_type}'"}

    session = get_session()
    try:
        repo = BackgroundJobRepository(session)
        dataset_repo = DatasetRepository(session)
        if execution.get("ok"):
            repo.mark_succeeded(job.run_id, result_json=execution.get("result") or {})
            result_payload = execution.get("result") or {}
            dataset_repo.finalize_site_run(
                job.run_id,
                display_status=str(result_payload.get("final_status", "") or "success"),
                result_json=result_payload,
            )
        elif execution.get("cancelled"):
            repo.mark_cancelled(job.run_id, reason=str(execution.get("error", "Cancelled")))
            dataset_repo.finalize_site_run(
                job.run_id,
                display_status="cancelled",
                result_json=execution.get("result") or {},
                error_text=str(execution.get("error", "Cancelled")),
            )
        else:
            failed_job = repo.mark_failed(
                job.run_id, error_text=str(execution.get("error", "background_job_failed"))
            )
            failed_status = (
                normalize_job_display_status(str(failed_job.status or ""))
                if failed_job is not None
                else "failed"
            )
            if failed_status == "running":
                dataset_repo.mark_site_run_running(job.run_id)
            else:
                dataset_repo.finalize_site_run(
                    job.run_id,
                    display_status=failed_status,
                    result_json=execution.get("result") or {},
                    error_text=str(execution.get("error", "background_job_failed")),
                )
    finally:
        session.close()
    return True


async def _background_worker_loop() -> None:
    while True:
        try:
            processed = await _process_background_job()
            await asyncio.sleep(0.2 if processed else 0.8)
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            logger.exception("Background worker iteration failed: %s", exc)
            await asyncio.sleep(1.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _background_worker_task
    settings = get_settings()
    setup_logging(level=settings.log_level, log_file=settings.log_file)
    setup_tracing_from_settings(settings)
    create_tables()
    recovered_jobs = _recover_background_jobs()
    cleanup = {"runtime_events_deleted": 0, "run_screenshots_deleted": 0}
    session = get_session()
    try:
        cleanup = RunRepository(session).cleanup_old_artifacts(
            retention_days=settings.background_job_retention_days
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("Skipping startup artifact cleanup: %s", exc)
    finally:
        session.close()
    _refresh_pricing_from_db(settings)
    _auto_sync_provider_pricing(settings)
    _background_worker_task = asyncio.create_task(_background_worker_loop())
    logger.info(
        "Open Web Catcher API started | orchestrator=%s | agents=%s | recovered_jobs=%d | cleanup=%s",
        settings.orchestrator_model,
        settings.agent_model,
        recovered_jobs,
        cleanup,
    )
    yield
    if _background_worker_task is not None:
        _background_worker_task.cancel()
        with suppress(asyncio.CancelledError):
            await _background_worker_task
        _background_worker_task = None
    for run_id in list(_active_run_tasks.keys()):
        await _cancel_active_run_task(run_id)
    await _close_all_playground_tool_sessions()
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
    total_cost = metrics.estimated_total_cost_usd if metrics else 0.0
    total_tokens_in = int(metrics.total_tokens_in or 0) if metrics else 0
    total_tokens_out = int(metrics.total_tokens_out or 0) if metrics else 0
    status = "running"
    if trace.completed:
        if trace.cancel_requested or str(
            (metrics.failure_mode if metrics else "") or ""
        ).lower() in {"runcancellederror", "cancelled", "canceled"}:
            status = "cancelled"
        else:
            status = "success" if (metrics and metrics.success) else "failed"

    return {
        "run_id": trace.run_id,
        "root_actor": trace.root_actor,
        "url": metrics.url if metrics else "",
        "status": status,
        "event_count": len(trace.events),
        "completed": trace.completed,
        "cancel_requested": trace.cancel_requested,
        "started_at": trace.started_at.isoformat(),
        "total_tokens_in": total_tokens_in,
        "total_tokens_out": total_tokens_out,
        "total_tokens": total_tokens_in + total_tokens_out,
        "total_tool_calls": metrics.total_tool_calls if metrics else 0,
        "total_llm_calls": metrics.total_llm_calls if metrics else 0,
        "estimated_total_cost_usd": total_cost,
        "total_cost_usd": total_cost,
    }


def _background_job_row(job: Any) -> dict[str, Any]:
    display_status = _background_job_display_status(job)
    started_at = getattr(job, "started_at", None)
    finished_at = getattr(job, "finished_at", None)
    created_at = getattr(job, "created_at", None)
    return {
        "run_id": job.run_id,
        "url": job.url,
        "page_type": "unknown",
        "status": display_status,
        "final_status": display_status,
        "stream_count": 0,
        "screenshot_count": 0,
        "email_count": 0,
        "provider_analysis_count": 0,
        "success": display_status == "success",
        "duration_seconds": 0.0,
        "total_tool_calls": 0,
        "total_llm_calls": 0,
        "total_tokens_in": 0,
        "total_tokens_out": 0,
        "estimated_total_cost_usd": 0.0,
        "total_cost_usd": 0.0,
        "total_messages": 0,
        "created_at": created_at.isoformat() if created_at else "",
        "started_at": started_at.isoformat() if started_at else "",
        "finished_at": finished_at.isoformat() if finished_at else "",
        "root_actor": job.actor,
        "job_type": job.job_type,
        "attempts": int(job.attempts or 0),
        "max_attempts": int(job.max_attempts or 0),
        "job_state": display_status,
        "job": _background_job_state(job),
        "max_parallel_agents": 0,
    }


def _background_job_display_status(job: Any) -> str:
    return normalize_job_display_status(str(getattr(job, "status", "") or ""))


def _background_job_state(job: Any) -> dict[str, Any]:
    return {
        "job_id": str(getattr(job, "job_id", "") or ""),
        "run_id": str(getattr(job, "run_id", "") or ""),
        "job_type": str(getattr(job, "job_type", "") or ""),
        "actor": str(getattr(job, "actor", "") or ""),
        "status": str(getattr(job, "status", "") or ""),
        "display_status": _background_job_display_status(job),
        "attempts": int(getattr(job, "attempts", 0) or 0),
        "max_attempts": int(getattr(job, "max_attempts", 0) or 0),
        "error_text": str(getattr(job, "error_text", "") or ""),
        "created_at": getattr(job, "created_at", None).isoformat()
        if getattr(job, "created_at", None)
        else "",
        "started_at": getattr(job, "started_at", None).isoformat()
        if getattr(job, "started_at", None)
        else "",
        "finished_at": getattr(job, "finished_at", None).isoformat()
        if getattr(job, "finished_at", None)
        else "",
        "heartbeat_at": getattr(job, "heartbeat_at", None).isoformat()
        if getattr(job, "heartbeat_at", None)
        else "",
    }


def _emit_failure_once(observer, kind: str, message: str) -> None:
    """Emit a terminal failure event only when it is not already present at the tail."""
    trace = run_registry.get(observer.run_id)
    if trace is not None and trace.events:
        last = trace.events[-1]
        if last.kind == kind and last.message == message:
            return
    observer.emit(kind, message, status="error")


def _emit_cancel_once(observer, message: str) -> None:
    trace = run_registry.get(observer.run_id)
    if trace is not None and trace.events:
        last = trace.events[-1]
        if last.kind in {"run_cancelled", "cancel_requested"} and last.message == message:
            return
    observer.emit("run_cancelled", message, status="cancelled")


async def _run_selected_agent(agent_key: str, url: str, observer):
    normalized = (agent_key or "").strip().lower()
    settings = get_settings()
    prompt_override = ""
    if isinstance(observer, dict):
        prompt_override = str(observer.get("prompt_override", "") or "")
        observer = observer.get("observer")
    if normalized == "classification":
        from src.agents.classification import ClassificationAgent

        agent = ClassificationAgent(settings)
        if prompt_override.strip():
            agent._system_prompt = prompt_override
        return await agent.run(url=url, observer=observer)
    if normalized == "landing":
        from src.agents.landing_page import LandingPageAgent

        agent = LandingPageAgent(settings)
        if prompt_override.strip():
            agent._system_prompt = prompt_override
        return await agent.run(url=url, observer=observer)
    if normalized == "hosting":
        from src.agents.hosting_page import HostingPageAgent

        agent = HostingPageAgent(settings)
        if prompt_override.strip():
            agent._system_prompt = prompt_override
        return await agent.run(url=url, observer=observer)
    if normalized == "embedded":
        from src.agents.embedded_page import EmbeddedPageAgent

        agent = EmbeddedPageAgent(settings)
        if prompt_override.strip():
            agent._system_prompt = prompt_override
        return await agent.run(url=url, observer=observer)
    raise ValueError(f"Unknown agent '{agent_key}'")


async def _persist_pipeline_result(result: PipelineResult) -> None:
    session = get_session()
    try:
        RunRepository(session).save(result, trace=run_registry.get(result.run_id))
    finally:
        session.close()


def _persist_trace_snapshot(run_id: str, *, root_actor: str, url: str) -> None:
    trace = run_registry.get(run_id)
    if trace is None:
        return
    session = get_session()
    try:
        RunRepository(session).save_trace_snapshot(
            run_id=run_id, root_actor=root_actor, url=url, trace=trace
        )
        BackgroundJobRepository(session).heartbeat(run_id)
    except SQLAlchemyError as exc:
        logger.debug("Skipping trace snapshot persistence for run_id=%s: %s", run_id, exc)
    finally:
        session.close()


def _restore_trace_from_db(run_id: str) -> bool:
    session = get_session()
    try:
        job = BackgroundJobRepository(session).get_by_run_id(run_id)
        if job is None or job.status in {"succeeded", "failed", "dead_letter", "cancelled"}:
            return False
        events = RunRepository(session).list_runtime_events(run_id)
    except SQLAlchemyError:
        return False
    finally:
        session.close()
    if not events:
        return False
    observer = run_registry.create(
        run_id=run_id,
        root_actor=job.actor or ("orchestrator" if job.job_type == "workflow" else "agent"),
        observability=get_observability_status(get_settings()),
    )
    observer.set_url(job.url or "")
    for event in events:
        observer.child(str(event.get("actor", "") or observer.actor)).emit(
            str(event.get("kind", "event") or "event"),
            str(event.get("message", "") or ""),
            status=str(event.get("status", "info") or "info"),
            details=event.get("details") if isinstance(event.get("details"), dict) else {},
        )
    return True


async def _trace_persist_loop(
    run_id: str,
    *,
    root_actor: str,
    url: str,
    interval_seconds: float = 1.2,
) -> None:
    try:
        while True:
            _persist_trace_snapshot(run_id, root_actor=root_actor, url=url)
            trace = run_registry.get(run_id)
            if trace is None or trace.completed:
                break
            await asyncio.sleep(max(0.3, float(interval_seconds)))
    except asyncio.CancelledError:
        return
    except Exception as exc:  # noqa: BLE001
        logger.debug("Trace persistence loop failed for run_id=%s: %s", run_id, exc)


async def _background_workflow(run_id: str, url: str) -> dict[str, Any]:
    from src.agents.orchestrator import run_pipeline as _run_pipeline

    settings = get_settings()
    observer = run_registry.create(
        run_id=run_id,
        root_actor="orchestrator",
        observability=get_observability_status(settings),
    )
    observer.set_url(url)
    persist_task = asyncio.create_task(
        _trace_persist_loop(run_id, root_actor="orchestrator", url=url)
    )
    try:
        timeout_seconds = max(1, int(settings.agent_timeout_seconds))
        result = await asyncio.wait_for(
            _run_pipeline(url=url, settings=settings, observer=observer),
            timeout=timeout_seconds,
        )
        await _persist_pipeline_result(result)
        return {"ok": True, "result": result.model_dump(mode="json")}
    except asyncio.TimeoutError:
        message = f"Workflow timed out after {max(1, int(settings.agent_timeout_seconds))}s"
        _emit_failure_once(observer, "pipeline_failed", message)
        observer.finish(success=False, failure_mode="TimeoutError")
        _persist_trace_snapshot(run_id, root_actor="orchestrator", url=url)
        logger.error(
            "Background workflow timed out: run_id=%s timeout=%ss",
            run_id,
            max(1, int(settings.agent_timeout_seconds)),
        )
        return {"ok": False, "error": message}
    except RunCancelledError as exc:
        _emit_cancel_once(observer, str(exc) or "Run cancelled.")
        observer.finish(success=False, failure_mode="cancelled")
        _persist_trace_snapshot(run_id, root_actor="orchestrator", url=url)
        return {"ok": False, "cancelled": True, "error": str(exc)}
    except asyncio.CancelledError:
        message = "Run cancelled while the workflow was still active."
        _emit_cancel_once(observer, message)
        observer.finish(success=False, failure_mode="cancelled")
        _persist_trace_snapshot(run_id, root_actor="orchestrator", url=url)
        return {"ok": False, "cancelled": True, "error": message}
    except Exception as exc:
        _emit_failure_once(observer, "pipeline_failed", str(exc))
        observer.finish(success=False, failure_mode=type(exc).__name__)
        _persist_trace_snapshot(run_id, root_actor="orchestrator", url=url)
        logger.exception("Background workflow failed: %s", exc)
        return {"ok": False, "error": str(exc)}
    finally:
        persist_task.cancel()
        with suppress(asyncio.CancelledError):
            await persist_task


async def _background_agent(
    run_id: str, agent: str, url: str, prompt_override: str = ""
) -> dict[str, Any]:
    settings = get_settings()
    observer = run_registry.create(
        run_id=run_id,
        root_actor=agent,
        observability=get_observability_status(settings),
    )
    observer.set_url(url)
    persist_task = asyncio.create_task(_trace_persist_loop(run_id, root_actor=agent, url=url))
    try:
        timeout_seconds = max(1, int(settings.agent_timeout_seconds))
        result = await asyncio.wait_for(
            _run_selected_agent(
                agent,
                url,
                {"observer": observer, "prompt_override": prompt_override},
            ),
            timeout=timeout_seconds,
        )
        success = True
        failure_mode = ""
        if isinstance(result, ExtractionResult):
            success = result.status.value in {"success", "partial"}
            failure_mode = "" if success else result.status.value
        observer.finish(success=success, failure_mode=failure_mode)
        _persist_trace_snapshot(run_id, root_actor=agent, url=url)
        return {
            "ok": success,
            "result": result.model_dump(mode="json") if hasattr(result, "model_dump") else {},
        }
    except asyncio.TimeoutError:
        message = f"Agent timed out after {max(1, int(settings.agent_timeout_seconds))}s"
        _emit_failure_once(observer, "agent_failed", message)
        observer.finish(success=False, failure_mode="TimeoutError")
        _persist_trace_snapshot(run_id, root_actor=agent, url=url)
        logger.error(
            "Background agent run timed out: run_id=%s agent=%s timeout=%ss",
            run_id,
            agent,
            max(1, int(settings.agent_timeout_seconds)),
        )
        return {"ok": False, "error": message}
    except RunCancelledError as exc:
        _emit_cancel_once(observer, str(exc) or "Run cancelled.")
        observer.finish(success=False, failure_mode="cancelled")
        _persist_trace_snapshot(run_id, root_actor=agent, url=url)
        return {"ok": False, "cancelled": True, "error": str(exc)}
    except asyncio.CancelledError:
        message = f"Run cancelled while the {agent} agent was still active."
        _emit_cancel_once(observer, message)
        observer.finish(success=False, failure_mode="cancelled")
        _persist_trace_snapshot(run_id, root_actor=agent, url=url)
        return {"ok": False, "cancelled": True, "error": message}
    except Exception as exc:
        _emit_failure_once(observer, "agent_failed", str(exc))
        observer.finish(success=False, failure_mode=type(exc).__name__)
        _persist_trace_snapshot(run_id, root_actor=agent, url=url)
        logger.exception("Background agent run failed: %s", exc)
        return {"ok": False, "error": str(exc)}
    finally:
        persist_task.cancel()
        with suppress(asyncio.CancelledError):
            await persist_task


async def _call_mcp_tool(
    profile: str,
    tool_name: str,
    args: dict[str, Any],
    *,
    reuse_playground_session: bool = False,
) -> dict[str, Any]:
    settings = get_settings()

    if reuse_playground_session:
        try:
            tools = await _get_playground_tools(profile, settings)
            return await _invoke_named_tool(tools, profile, tool_name, args)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "Playground MCP call failed for profile '%s', reopening session once: %s",
                profile,
                exc,
            )
            await _close_playground_tool_session(profile)
            tools = await _get_playground_tools(profile, settings)
            return await _invoke_named_tool(tools, profile, tool_name, args)

    async with agent_tools(profile, settings) as tools:
        return await _invoke_named_tool(tools, profile, tool_name, args)


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
        result = await _call_mcp_tool(
            profile,
            tool_name,
            args,
            reuse_playground_session=(origin == "playground"),
        )
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


def _resolve_prompt_file(name: str) -> Path:
    candidate = (PROMPTS_DIR / name).resolve()
    if not candidate.is_file() or candidate.parent != PROMPTS_DIR:
        raise HTTPException(status_code=404, detail=f"Prompt '{name}' not found")
    return candidate


def _extract_screenshot_url_from_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value.strip()
        if text.startswith("http") or text.startswith("data:image/"):
            return text
        try:
            parsed = json.loads(text)
            return _extract_screenshot_url_from_value(parsed)
        except Exception:
            return ""
    if isinstance(value, list):
        for item in value:
            nested = _extract_screenshot_url_from_value(item)
            if nested:
                return nested
        return ""
    if isinstance(value, dict):
        direct = value.get("screenshot_url")
        if isinstance(direct, str) and direct.strip():
            return direct.strip()
        urls = value.get("screenshot_urls")
        if isinstance(urls, list):
            for url in urls:
                if isinstance(url, str) and url.strip():
                    return url.strip()
        for nested in value.values():
            candidate = _extract_screenshot_url_from_value(nested)
            if candidate:
                return candidate
    return ""


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
    results = lookup_multiple(
        cleaned, ipinfo_token=settings.ipinfo_token, deduplicate_by_provider=False
    )
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        return repo.record_provider_lookup_batch(str(uuid.uuid4()), results)
    finally:
        session.close()


def _background_job_health() -> dict[str, Any]:
    session = get_session()
    try:
        repo = BackgroundJobRepository(session)
        rows = repo.list_active(limit=1000)
        queued = sum(1 for row in rows if row.status in {"queued", "retrying"})
        running = sum(1 for row in rows if row.status == "running")
        return {
            "healthy": True,
            "worker_running": _background_worker_task is not None
            and not _background_worker_task.done(),
            "queued": queued,
            "running": running,
            "queue_lag": queued,
        }
    except Exception:
        return {
            "healthy": False,
            "worker_running": _background_worker_task is not None
            and not _background_worker_task.done(),
            "queued": 0,
            "running": 0,
            "queue_lag": 0,
        }
    finally:
        session.close()


async def _stream_trace(run_id: str, request: Request | None = None):
    last_seq = 0
    first_tick = True
    _sse_keepalive_last = [_time.monotonic()]
    try:
        while True:
            if request is not None and await request.is_disconnected():
                return

            trace = run_registry.get(run_id)
            if trace is None:
                if _restore_trace_from_db(run_id):
                    await asyncio.sleep(0)
                    continue
                session = get_session()
                try:
                    repo = RunRepository(session)
                    db_events = repo.list_runtime_events(run_id)
                    if db_events:
                        payload = {
                            "run_id": run_id,
                            "events": [
                                event for event in db_events if int(event.get("seq", 0)) > last_seq
                            ],
                            "metrics": None,
                            "completed": True,
                            "cancel_requested": False,
                            "cancel_reason": "",
                            "source": "database",
                        }
                        if payload["events"]:
                            last_seq = int(payload["events"][-1].get("seq", last_seq))
                        yield f"data: {json.dumps(payload, default=str)}\n\n"
                        break
                    job = BackgroundJobRepository(session).get_by_run_id(run_id)
                    if job is not None:
                        display_status = _background_job_display_status(job)
                        synthetic_events: list[dict[str, Any]] = []
                        if job.status in JOB_TERMINAL_STATUSES:
                            event_kind = ""
                            if display_status == "cancelled":
                                event_kind = "run_cancelled"
                            elif display_status in {"success", "partial"}:
                                event_kind = (
                                    "pipeline_finished"
                                    if str(job.job_type or "") == "workflow"
                                    else "agent_finished"
                                )
                            elif display_status == "failed":
                                event_kind = (
                                    "pipeline_failed"
                                    if str(job.job_type or "") == "workflow"
                                    else "agent_failed"
                                )
                            if event_kind:
                                synthetic_events.append(
                                    {
                                        "seq": last_seq + 1,
                                        "kind": event_kind,
                                        "actor": str(job.actor or ""),
                                        "status": "success"
                                        if display_status in {"success", "partial"}
                                        else "error",
                                        "message": str(job.error_text or "") or display_status,
                                        "timestamp": (
                                            job.finished_at or job.updated_at or job.created_at
                                        ).isoformat(),
                                        "details": {
                                            "job_status": str(job.status or ""),
                                            "display_status": display_status,
                                            "error": str(job.error_text or ""),
                                        },
                                    }
                                )
                        payload = {
                            "run_id": run_id,
                            "events": synthetic_events,
                            "completed": job.status in JOB_TERMINAL_STATUSES,
                            "cancel_requested": job.status == "cancelled",
                            "cancel_reason": job.error_text if job.status == "cancelled" else "",
                            "job_status": job.status,
                            "display_status": display_status,
                            "job": _background_job_state(job),
                            "source": "background_job",
                        }
                        if synthetic_events:
                            last_seq = int(synthetic_events[-1].get("seq", last_seq))
                        yield f"data: {json.dumps(payload, default=str)}\n\n"
                        if payload["completed"]:
                            break
                        await asyncio.sleep(0.8)
                        continue
                finally:
                    session.close()

                payload = {
                    "run_id": run_id,
                    "events": [],
                    "completed": True,
                    "error": "run_not_found",
                }
                yield f"data: {json.dumps(payload, default=str)}\n\n"
                break

            new_events = [
                event.model_dump(mode="json") for event in trace.events if event.seq > last_seq
            ]
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
            # Emit a keep-alive comment every _SSE_KEEPALIVE_SECONDS to prevent proxy timeouts
            if _time.monotonic() - _sse_keepalive_last[0] > _SSE_KEEPALIVE_SECONDS:
                yield ": heartbeat\n\n"
                _sse_keepalive_last[0] = _time.monotonic()
    except (asyncio.CancelledError, GeneratorExit):
        # Client disconnected; terminate stream silently to avoid noisy
        # ExceptionGroup/TaskGroup traces from the ASGI response task group.
        return
    except Exception as exc:
        logger.warning(
            "Run stream terminated unexpectedly", extra={"run_id": run_id, "error": str(exc)}
        )
        if request is not None:
            with suppress(Exception):
                if await request.is_disconnected():
                    return
        payload = {
            "run_id": run_id,
            "events": [],
            "completed": True,
            "error": "stream_failed",
        }
        try:
            yield f"data: {json.dumps(payload, default=str)}\n\n"
        except (asyncio.CancelledError, GeneratorExit, BrokenPipeError, ConnectionError):
            return


@app.get("/health")
def health():
    settings = get_settings()
    mcp_status = probe_mcp(settings.mcp_server_url)
    browser_status = probe_browser(settings.browser_ws_endpoint)
    background_status = _background_job_health()

    # In isolated mode, MCP launches and manages per-session browsers.
    # The shared CDP endpoint is only a fallback and may be intentionally absent.
    if mcp_status.get("healthy") and str(mcp_status.get("browser_mode", "")).lower() == "isolated":
        browser_status = {
            **browser_status,
            "healthy": True,
            "mode": "isolated",
            "note": "Shared browser probe is informational in isolated mode.",
        }

    return {
        "status": "ok",
        "orchestrator_model": settings.orchestrator_model,
        "agent_model": settings.agent_model,
        "browser_ws_endpoint": settings.browser_ws_endpoint,
        "mcp_server_url": settings.mcp_server_url,
        "dependencies": {
            "browser": browser_status,
            "mcp": mcp_status,
            "background_jobs": background_status,
        },
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
                "estimated_total_cost_usd": ((r.result_json or {}).get("metrics") or {}).get(
                    "estimated_total_cost_usd", 0.0
                ),
                "total_cost_usd": ((r.result_json or {}).get("metrics") or {}).get(
                    "estimated_total_cost_usd", 0.0
                ),
                "llm_calls": ((r.result_json or {}).get("metrics") or {}).get("total_llm_calls", 0),
                "message_count": ((r.result_json or {}).get("metrics") or {}).get(
                    "total_messages", 0
                ),
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
            raise HTTPException(
                status_code=404, detail=f"No prompt compilations found for '{run_id}'"
            )
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
    if trace is not None:
        return trace.model_dump(mode="json")
    session = get_session()
    try:
        events = RunRepository(session).list_runtime_events(run_id)
        if not events:
            raise HTTPException(status_code=404, detail=f"Run trace '{run_id}' not found")
        return {"run_id": run_id, "events": events, "completed": True, "source": "database"}
    finally:
        session.close()


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
        export_path = export_dataset_examples(
            examples, settings=settings, dataset_name=req.dataset_name, path=req.path or None
        )
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
    active = [_active_trace_row(trace) for trace in run_registry.list_recent(limit=limit)]
    # Fast path: return cached overview if fresh enough
    cache_key = f"overview:{len(active)}"
    cached = _cache_get(cache_key, _OVERVIEW_CACHE_TTL_SECONDS)
    if cached is not None:
        # Always inject fresh active-trace data even on cache hit
        return {**cached, "active_runs": active}
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        result = repo.get_overview(active_traces=active, limit=limit)
        _cache_set(cache_key, result)
        return result
    finally:
        session.close()


@app.get("/ui/events/recent")
def ui_recent_runtime_events(limit: int = Query(30, ge=1, le=200)):
    session = get_session()
    try:
        return {
            "events": OperatorConsoleRepository(session).list_recent_runtime_events(limit=limit)
        }
    finally:
        session.close()


@app.get("/ui/runs")
def ui_runs(
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
    status: str = "",
    page_type: str = "",
    query: str = "",
    actor: str = "",
):
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        persisted_status = "" if status == "queued" else status
        payload = repo.list_runs(
            limit=limit + offset + 400,
            offset=0,
            status=persisted_status,
            page_type=page_type,
            query=query,
            actor="",
        )
        jobs = BackgroundJobRepository(session).list_all(limit=400)
        job_map = {str(job.run_id or ""): job for job in jobs}
        query_text = str(query or "").strip().lower()
        actor_text = str(actor or "").strip().lower()

        def matches_filters(row: dict[str, Any]) -> bool:
            display_status = (
                str(row.get("final_status", "") or row.get("status", "") or "").strip().lower()
            )
            if status and display_status != status:
                return False
            if actor_text and actor_text != str(row.get("root_actor", "") or "").strip().lower():
                return False
            if query_text:
                haystack = " ".join(
                    [
                        str(row.get("run_id", "") or ""),
                        str(row.get("url", "") or ""),
                        str(row.get("page_type", "") or ""),
                        str(row.get("final_status", "") or ""),
                        str(row.get("failure_mode", "") or ""),
                        str(row.get("root_actor", "") or ""),
                        str(row.get("primary_provider", "") or ""),
                        str(row.get("primary_model", "") or ""),
                    ]
                ).lower()
                if query_text not in haystack:
                    return False
            return True

        merged_rows = []
        seen_run_ids: set[str] = set()
        for row in payload.get("rows", []):
            run_id = str(row.get("run_id", "") or "")
            job = job_map.get(run_id)
            if job is not None:
                row = {
                    **row,
                    "status": _background_job_display_status(job),
                    "final_status": _background_job_display_status(job),
                    "job_state": _background_job_display_status(job),
                    "job": _background_job_state(job),
                    "root_actor": str(job.actor or row.get("root_actor", "") or ""),
                }
            if matches_filters(row):
                merged_rows.append(row)
            seen_run_ids.add(run_id)

        pending_rows = []
        for job in jobs:
            if job.run_id in seen_run_ids:
                continue
            pending_row = _background_job_row(job)
            if matches_filters(pending_row):
                pending_rows.append(pending_row)
        rows = pending_rows + merged_rows
        rows.sort(key=lambda row: str(row.get("created_at", "") or ""), reverse=True)
        sliced = rows[offset : offset + limit]
        return {
            "total": len(rows),
            "rows": sliced,
        }
    finally:
        session.close()


@app.get("/ui/runs/{run_id}")
def ui_run_detail(run_id: str):
    active = run_registry.get(run_id)
    if active is None and _restore_trace_from_db(run_id):
        active = run_registry.get(run_id)
    if active is not None and not active.completed:
        return {"active_trace": active.model_dump(mode="json")}

    session = get_session()
    try:
        payload = OperatorConsoleRepository(session).get_run_detail(run_id)
        if payload is None:
            job = BackgroundJobRepository(session).get_by_run_id(run_id)
            if job is None:
                raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
            return {
                "run": _background_job_row(job),
                "snapshot": job.result_json or {},
                "agent_runs": [],
                "agent_outputs": [],
                "agent_rollups": [],
                "stage_rollups": [],
                "parallelism": {
                    "current_parallel_agents": 0,
                    "max_parallel_agents": 0,
                    "by_stage": [],
                },
                "tool_calls": [],
                "llm_calls": [],
                "events": [],
                "job": _background_job_state(job),
                "job_state": _background_job_state(job),
            }
        return payload
    finally:
        session.close()


@app.get("/ui/runs/{run_id}/stream")
async def ui_run_stream(run_id: str, request: Request):
    return StreamingResponse(
        _stream_trace(run_id, request=request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/ui/runs/{run_id}/cancel")
async def ui_cancel_run(run_id: str):
    reason = "Cancelled from the Next.js operator console."
    success = run_registry.request_cancel(run_id, reason=reason)
    if await _cancel_active_run_task(run_id):
        success = True
    session = get_session()
    try:
        job_repo = BackgroundJobRepository(session)
        job = job_repo.get_by_run_id(run_id)
        if job is not None:
            job_repo.mark_cancelled(run_id, reason=reason)
            success = True
    except SQLAlchemyError as exc:
        logger.debug("Skipping background-job cancellation persistence for %s: %s", run_id, exc)
    finally:
        session.close()
    if not success:
        raise HTTPException(
            status_code=404, detail=f"Run '{run_id}' not found or already completed"
        )
    _cache_bust("overview")
    return {"ok": True, "run_id": run_id}


@app.post("/ui/runs/cancel-active")
async def ui_cancel_active_runs():
    reason = "Bulk-cancelled from the Next.js operator console."
    run_ids: list[str] = []
    session = get_session()
    try:
        job_repo = BackgroundJobRepository(session)
        run_ids = [str(item.run_id) for item in job_repo.list_active(limit=500) if item.run_id]
        for run_id in run_ids:
            job_repo.mark_cancelled(run_id, reason=reason)
    except SQLAlchemyError as exc:
        logger.debug("Skipping bulk cancellation persistence because the job table is unavailable: %s", exc)
    finally:
        session.close()

    run_ids = list(dict.fromkeys([*run_ids, *_active_run_tasks.keys()]))
    for run_id in run_ids:
        run_registry.request_cancel(run_id, reason=reason)
        await _cancel_active_run_task(run_id)

    _cache_bust("overview")
    return {"ok": True, "cancelled": len(run_ids), "run_ids": run_ids}


@app.delete("/ui/runs/{run_id}")
def ui_delete_run(run_id: str):
    active = run_registry.get(run_id)
    if active is not None and not active.completed:
        raise HTTPException(status_code=409, detail="Cancel this run before deleting it.")

    session = get_session()
    try:
        job_repo = BackgroundJobRepository(session)
        job = job_repo.get_by_run_id(run_id)
        if job is not None and str(job.status or "") in JOB_ACTIVE_STATUSES:
            raise HTTPException(status_code=409, detail="Cancel this run before deleting it.")
        deleted = RunRepository(session).hard_delete_run(run_id)
    finally:
        session.close()

    if not any(int(value or 0) > 0 for value in deleted.values()):
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
    return {"ok": True, "run_id": run_id, "deleted": deleted}


def _enqueue_background_job(
    *,
    run_id: str,
    job_type: str,
    url: str,
    actor: str,
    payload: dict[str, Any] | None = None,
    idempotency_key: str = "",
) -> dict[str, Any]:
    session = get_session()
    try:
        repo = BackgroundJobRepository(session)
        record = repo.enqueue(
            run_id=run_id,
            job_type=job_type,
            url=url,
            actor=actor,
            payload=payload,
            idempotency_key=idempotency_key,
        )
        return {
            "run_id": record.run_id,
            "root_actor": record.actor,
            "job_status": record.status,
            "job_id": record.job_id,
            "idempotency_key": record.idempotency_key or "",
        }
    except SQLAlchemyError as exc:
        logger.warning(
            "Background job table unavailable; falling back to in-memory task execution: %s", exc
        )
        if job_type == "workflow":
            _track_run_task(run_id, asyncio.create_task(_background_workflow(run_id, url)))
        else:
            _track_run_task(
                run_id,
                asyncio.create_task(
                    _background_agent(
                        run_id,
                        str((payload or {}).get("agent", "") or actor),
                        url,
                        prompt_override=str((payload or {}).get("prompt_override", "") or ""),
                    )
                )
            )
        return {
            "run_id": run_id,
            "root_actor": actor,
            "job_status": "queued",
            "job_id": "",
            "idempotency_key": idempotency_key,
            "fallback": "in_memory",
        }
    finally:
        session.close()


@app.post("/ui/workflows/run")
async def ui_workflow_run(req: WorkflowRunRequest):
    run_id = str(uuid.uuid4())
    key = (req.idempotency_key or "").strip()
    _cache_bust("overview")
    return _enqueue_background_job(
        run_id=run_id,
        job_type="workflow",
        url=req.url,
        actor="orchestrator",
        payload={"url": req.url},
        idempotency_key=key,
    )


@app.post("/ui/agents/test")
async def ui_agent_test(req: AgentTestRequest):
    run_id = str(uuid.uuid4())
    key = (req.idempotency_key or "").strip()
    return _enqueue_background_job(
        run_id=run_id,
        job_type="agent",
        url=req.url,
        actor=req.agent,
        payload={"agent": req.agent, "url": req.url, "prompt_override": req.prompt_override},
        idempotency_key=key,
    )


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


@app.get("/ui/tools/list")
def ui_tools_list(profile: str = Query("", description="agent profile")):
    normalized = profile.strip().lower()
    if normalized and normalized not in REQUIRED_TOOLS_BY_PROFILE:
        raise HTTPException(status_code=400, detail=f"Unknown profile '{profile}'")
    if normalized:
        names = sorted(REQUIRED_TOOLS_BY_PROFILE[normalized])
        return {"profile": normalized, "tools": names, "count": len(names)}
    return {"profiles": {key: sorted(value) for key, value in REQUIRED_TOOLS_BY_PROFILE.items()}}


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
        payload = repo.list_tool_playground_calls(
            limit=limit, offset=offset, profile=profile, origin=origin
        )
        payload["limit"] = limit
        payload["offset"] = offset
        return payload
    finally:
        session.close()


@app.get("/ui/tools/reliability")
def ui_tool_reliability(limit: int = Query(500, ge=1, le=2000)):
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        payload = repo.list_tool_playground_calls(limit=limit, offset=0, profile="", origin="")
        stats: dict[tuple[str, str], dict[str, Any]] = {}
        for row in payload.get("rows", []):
            tool = str(row.get("tool_name", "") or "").strip()
            profile = str(row.get("profile", "") or "").strip()
            if not tool or not profile:
                continue
            key = (tool, profile)
            item = stats.setdefault(
                key,
                {
                    "tool_name": tool,
                    "profile": profile,
                    "calls": 0,
                    "successes": 0,
                    "errors": 0,
                    "avg_duration_seconds": 0.0,
                },
            )
            item["calls"] += 1
            if row.get("status") == "success":
                item["successes"] += 1
            else:
                item["errors"] += 1
            item["avg_duration_seconds"] += float(row.get("duration_seconds") or 0.0)
        rows: list[dict[str, Any]] = []
        for item in stats.values():
            calls = max(1, int(item["calls"]))
            item["success_rate"] = round(float(item["successes"]) / calls, 4)
            item["avg_duration_seconds"] = round(float(item["avg_duration_seconds"]) / calls, 4)
            rows.append(item)
        rows.sort(key=lambda value: (value["tool_name"], value["profile"]))
        return {"rows": rows, "total": len(rows)}
    finally:
        session.close()


@app.post("/ui/providers/lookup")
def ui_provider_lookup(req: ProviderLookupRequest):
    rows = _provider_lookup_urls(req.stream_urls, get_settings())
    provider_counts: dict[str, int] = {}
    country_counts: dict[str, dict[str, Any]] = {}
    for row in rows:
        provider = str(row.get("provider", "") or "")
        country = str(row.get("country", "") or "")
        if provider:
            provider_counts[provider] = provider_counts.get(provider, 0) + 1
        if country:
            entry = country_counts.setdefault(
                country,
                {
                    "country": country,
                    "country_code": str(row.get("country_code", "") or ""),
                    "flag": str(row.get("flag", "") or ""),
                    "count": 0,
                },
            )
            entry["count"] += 1
    top_countries = sorted(
        country_counts.values(), key=lambda item: (-int(item["count"]), item["country"])
    )
    return {
        "rows": rows,
        "stats": _provider_lookup_stats(rows),
        "top_providers": [
            {"provider": provider, "count": count}
            for provider, count in sorted(
                provider_counts.items(), key=lambda item: (-int(item[1]), item[0])
            )[:8]
        ],
        "top_countries": top_countries[:8],
        "country_map": {
            "points": top_countries[:8],
            "covered_country_codes": [
                row["country_code"] for row in top_countries if row.get("country_code")
            ],
        },
    }


@app.get("/ui/providers/history")
def ui_provider_history(
    limit: int = Query(25, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    session = get_session()
    try:
        payload = OperatorConsoleRepository(session).get_provider_lookup_history(
            limit=limit, offset=offset
        )
        payload["limit"] = limit
        payload["offset"] = offset
        return payload
    finally:
        session.close()


class ModelConfigRequest(BaseModel):
    llm_provider: str | None = None
    agent_model: str | None = None
    orchestrator_model: str | None = None
    gemini_temperature: float | None = None
    llm_tuning: dict | None = None
    agent_model_config: dict | None = None
    provider_cache_enabled: bool | None = None
    gemini_explicit_cache_enabled: bool | None = None
    gemini_explicit_cache_ttl_seconds: int | None = None
    gemini_explicit_cache_refresh_lead_seconds: int | None = None
    tool_result_cache_enabled: bool | None = None
    tool_result_cache_min_identical_observations: int | None = None
    browser_engine: str | None = None
    disabled_tools_by_profile: dict | None = None
    disabled_tools_by_browser_profile: dict | None = None
    browser_runtime: dict | None = None
    deepeval_provider: str | None = None
    deepeval_model: str | None = None
    deepeval_temperature: float | None = None


class PricingSyncRequest(BaseModel):
    provider: str = ""
    max_models: int | None = None


def _ui_config_payload(
    settings: Settings,
    *,
    config_persisted: bool | None = None,
    config_persist_path: str = "",
    config_persist_error: str = "",
) -> dict[str, Any]:
    payload = {
        "llm_provider": settings.llm_provider,
        "agent_model": settings.agent_model,
        "orchestrator_model": settings.orchestrator_model,
        "gemini_temperature": settings.gemini_temperature,
        "llm_tuning": normalize_llm_tuning(getattr(settings, "llm_tuning", {})),
        "agent_model_config": normalize_agent_model_config(
            settings, getattr(settings, "agent_model_config", {})
        ),
        "provider_cache_enabled": settings.provider_cache_enabled,
        "gemini_explicit_cache_enabled": settings.gemini_explicit_cache_enabled,
        "gemini_explicit_cache_ttl_seconds": settings.gemini_explicit_cache_ttl_seconds,
        "gemini_explicit_cache_refresh_lead_seconds": settings.gemini_explicit_cache_refresh_lead_seconds,
        "tool_result_cache_enabled": settings.tool_result_cache_enabled,
        "tool_result_cache_min_identical_observations": settings.tool_result_cache_min_identical_observations,
        "browser_engine": settings.browser_engine,
        "mcp_server_url_puppeteer": settings.mcp_server_url_puppeteer,
        "mcp_server_url_playwright": settings.mcp_server_url_playwright,
        "disabled_tools_by_profile": settings.disabled_tools_by_profile,
        "disabled_tools_by_browser_profile": normalize_disabled_tools_by_browser_profile(
            getattr(settings, "disabled_tools_by_browser_profile", {}),
            legacy=getattr(settings, "disabled_tools_by_profile", {}),
        ),
        "browser_runtime": normalize_browser_runtime(getattr(settings, "browser_runtime", {})),
        "browser_runtime_sync_status": build_browser_runtime_sync_status(),
        "deepeval_provider": getattr(settings, "deepeval_provider", "openai"),
        "deepeval_model": getattr(settings, "deepeval_model", "gpt-4o"),
        "deepeval_temperature": getattr(settings, "deepeval_temperature", 0.0),
        "api_keys": {
            "google": bool(settings.google_api_key),
            "openai": bool(settings.openai_api_key),
            "anthropic": bool(settings.anthropic_api_key),
            "openrouter": bool(settings.openrouter_api_key),
            "nvidia": bool(settings.nvidia_api_key),
        },
    }
    if config_persisted is not None:
        payload["config_persisted"] = config_persisted
        payload["config_persist_path"] = config_persist_path
        payload["config_persist_error"] = config_persist_error
    return payload


@app.get("/ui/config")
def ui_get_config():
    """Return current LLM provider/model config and API key status."""
    return _ui_config_payload(get_settings())


@app.get("/ui/providers/models")
def ui_provider_models(
    provider: str = Query(..., min_length=2), max_models: int = Query(default=200, ge=1, le=1000)
):
    """Return provider-backed model catalog and tuning metadata."""
    try:
        return get_provider_model_catalog(get_settings(), provider=provider, max_models=max_models)
    except ProviderModelCatalogError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


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
    if body.llm_tuning is not None:
        s.llm_tuning = normalize_llm_tuning(body.llm_tuning)
    if body.agent_model_config is not None:
        s.agent_model_config = normalize_agent_model_config(s, body.agent_model_config)
        classification_selection = resolve_agent_model_selection(s, "classification")
        orchestrator_selection = resolve_agent_model_selection(s, "orchestrator")
        s.agent_model = classification_selection.get("model", s.agent_model)
        s.orchestrator_model = orchestrator_selection.get("model", s.orchestrator_model)
    if body.provider_cache_enabled is not None:
        s.provider_cache_enabled = body.provider_cache_enabled
    if body.gemini_explicit_cache_enabled is not None:
        s.gemini_explicit_cache_enabled = body.gemini_explicit_cache_enabled
    if body.gemini_explicit_cache_ttl_seconds is not None:
        s.gemini_explicit_cache_ttl_seconds = max(60, int(body.gemini_explicit_cache_ttl_seconds))
    if body.gemini_explicit_cache_refresh_lead_seconds is not None:
        s.gemini_explicit_cache_refresh_lead_seconds = max(
            5,
            int(body.gemini_explicit_cache_refresh_lead_seconds),
        )
    if body.tool_result_cache_enabled is not None:
        s.tool_result_cache_enabled = body.tool_result_cache_enabled
    if body.tool_result_cache_min_identical_observations is not None:
        s.tool_result_cache_min_identical_observations = max(
            1,
            int(body.tool_result_cache_min_identical_observations),
        )
    if body.browser_engine in ("puppeteer", "playwright"):
        s.browser_engine = body.browser_engine
        s.mcp_server_url = (
            s.mcp_server_url_playwright
            if body.browser_engine == "playwright"
            else s.mcp_server_url_puppeteer
        )
    if body.disabled_tools_by_profile is not None:
        s.disabled_tools_by_profile = body.disabled_tools_by_profile
    if body.disabled_tools_by_browser_profile is not None:
        s.disabled_tools_by_browser_profile = normalize_disabled_tools_by_browser_profile(
            body.disabled_tools_by_browser_profile,
            legacy=body.disabled_tools_by_profile
            if body.disabled_tools_by_profile is not None
            else s.disabled_tools_by_profile,
        )
    else:
        s.disabled_tools_by_browser_profile = normalize_disabled_tools_by_browser_profile(
            getattr(s, "disabled_tools_by_browser_profile", {}),
            legacy=s.disabled_tools_by_profile,
        )
    if body.browser_runtime is not None:
        s.browser_runtime = normalize_browser_runtime(body.browser_runtime)
    else:
        s.browser_runtime = normalize_browser_runtime(getattr(s, "browser_runtime", {}))
    if body.deepeval_provider is not None:
        s.deepeval_provider = body.deepeval_provider
    if body.deepeval_model is not None:
        s.deepeval_model = body.deepeval_model
    if body.deepeval_temperature is not None:
        s.deepeval_temperature = max(0.0, float(body.deepeval_temperature))
    if body.agent_model_config is None:
        s.agent_model_config = normalize_agent_model_config(s, getattr(s, "agent_model_config", {}))
    persist_path = ""
    persist_error = ""
    config_persisted = True
    try:
        persist_path = str(s.save_yaml())
    except Exception as exc:
        config_persisted = False
        persist_error = str(exc)
        logger.warning("Could not persist runtime settings: %s", exc)
    try:
        s.save_browser_runtime_bridge()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not persist browser runtime bridge: %s", exc)

    pricing_sync: dict[str, Any] = {}
    if s.provider_pricing_sync_enabled:
        try:
            pricing_sync = _sync_provider_pricing_to_db(s, provider=s.llm_provider)
        except Exception as exc:  # noqa: BLE001
            pricing_sync = {"provider": s.llm_provider, "error": str(exc)}
            logger.warning("Provider pricing sync after config update failed: %s", exc)

    payload = _ui_config_payload(
        s,
        config_persisted=config_persisted,
        config_persist_path=persist_path,
        config_persist_error=persist_error,
    )
    payload["pricing_sync"] = pricing_sync
    return payload


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
        if provider in {"", "all"}:
            providers = ["google", "openai", "anthropic", "openrouter"]
            results: list[dict[str, Any]] = []
            for item in providers:
                if item == "openrouter" and not (settings.openrouter_api_key or "").strip():
                    continue
                results.append(
                    _sync_provider_pricing_to_db(settings, provider=item, max_models=max_models)
                )
            return {
                "provider": "all",
                "results": results,
                "stored": sum(int(row.get("stored", 0) or 0) for row in results),
                "synced": sum(int(row.get("synced", 0) or 0) for row in results),
                "models": [model for row in results for model in (row.get("models", []) or [])],
            }
        return _sync_provider_pricing_to_db(settings, provider=provider, max_models=max_models)
    except NotImplementedError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ProviderPricingSyncError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.get("/ui/settings/estimate-costs")
def ui_estimate_costs(
    provider: str = Query(..., description="Provider name"),
    model: str = Query(..., description="Model name"),
    input_tokens: int = Query(1000, ge=0, description="Input token count"),
    output_tokens: int = Query(1000, ge=0, description="Output token count"),
    cached_input_tokens: int = Query(0, ge=0, description="Cached input token count"),
):
    """Estimate cost for a given provider, model, and token counts."""
    from src.utils.instrumentation import estimate_usage_cost, resolve_model_pricing

    settings = get_settings()
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        pricing_configs = repo.list_pricing_configs()

        # Build pricing lookup
        pricing_by_key = {}
        for config in pricing_configs:
            key = f"{config.provider}::{config.model_name}"
            pricing_by_key[key] = config
            if not config.provider:
                pricing_by_key[config.model_name] = config

        # Find pricing for this model
        pricing_config = None
        search_keys = [
            f"{provider}::{model}",
            model,
            f"{provider}::{model.split('::')[0]}",
        ]
        for key in search_keys:
            if key in pricing_by_key:
                pricing_config = pricing_by_key[key]
                break

        if not pricing_config:
            # No pricing found
            return {
                "provider": provider,
                "model": model,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "cached_input_tokens": cached_input_tokens,
                "input_cost_usd": 0.0,
                "output_cost_usd": 0.0,
                "total_cost_usd": 0.0,
                "pricing_source": "no_pricing_available",
            }

        # Calculate costs
        # Cached tokens often don't count toward cost, or count at reduced rate
        chargeable_input_tokens = input_tokens + cached_input_tokens  # Conservative: count all
        costs = estimate_usage_cost(
            input_tokens=chargeable_input_tokens,
            output_tokens=output_tokens,
            input_per_million=pricing_config.input_per_million,
            output_per_million=pricing_config.output_per_million,
        )

        return {
            "provider": provider,
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_input_tokens": cached_input_tokens,
            "input_cost_usd": costs["estimated_input_cost_usd"],
            "output_cost_usd": costs["estimated_output_cost_usd"],
            "total_cost_usd": costs["estimated_total_cost_usd"],
            "pricing_source": "database",
        }
    finally:
        session.close()


@app.get("/ui/evaluations/suites")
def ui_evaluation_suites():
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        repo.ensure_default_evaluation_suites()
        return {
            "suites": [suite.model_dump(mode="json") for suite in repo.list_evaluation_suites()]
        }
    finally:
        session.close()


@app.get("/ui/evaluations/lab")
def ui_evaluation_lab():
    return _deepeval_lab_payload(get_settings())


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
        requested_mode = _normalize_evaluation_mode(req.mode)
        if req.urls:
            suite = _build_manual_evaluation_suite(req)
            suite_source = "manual_batch"
        else:
            suites = repo.ensure_default_evaluation_suites()
            suite = next(
                (item for item in suites if item.id == req.suite_id), suites[0] if suites else None
            )
            suite_source = "saved_suite"
            if suite is None:
                raise HTTPException(status_code=404, detail="No evaluation suites available")

        run_id = str(uuid.uuid4())
        run_name = str(req.batch_name or "").strip() or suite.name
        repo.create_evaluation_run(
            suite.id, run_name, requested_mode if requested_mode != "hybrid" else suite.mode, run_id
        )

        case_results: list[EvaluationCaseResult] = []
        for case in [item for item in suite.cases if item.active]:
            case_results.append(
                await _execute_evaluation_case(
                    case,
                    requested_mode=requested_mode,
                    settings=settings,
                    run_id=run_id,
                )
            )

        summary = {
            "suite_name": run_name,
            "mode": requested_mode if requested_mode != "hybrid" else suite.mode,
            "case_count": len(case_results),
            "pass_count": sum(1 for item in case_results if item.status == "passed"),
            "source": suite_source,
            "input_urls": [
                case.input.get("url")
                for case in suite.cases
                if case.active and case.input.get("url")
            ],
        }
        finalized = repo.finalize_evaluation_run(run_id, case_results=case_results, summary=summary)
        return finalized.model_dump(mode="json")
    finally:
        session.close()


@app.get("/ui/prompts")
def ui_prompts():
    prompts: list[dict[str, Any]] = []
    for file_path in sorted(PROMPTS_DIR.glob("*.md")):
        stat = file_path.stat()
        prompts.append(
            {
                "name": file_path.name,
                "size_bytes": stat.st_size,
                "updated_at": stat.st_mtime,
            }
        )
    return {"prompts": prompts}


@app.get("/ui/prompts/{name}")
def ui_prompt_read(name: str):
    prompt_path = _resolve_prompt_file(name)
    return {"name": prompt_path.name, "content": prompt_path.read_text(encoding="utf-8")}


@app.put("/ui/prompts/{name}")
def ui_prompt_update(name: str, req: PromptUpdateRequest):
    prompt_path = _resolve_prompt_file(name)
    try:
        prompt_path.write_text(req.content or "", encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=403, detail=f"Prompt file is not writable: {exc}") from exc
    return {"name": prompt_path.name, "saved": True}


@app.post("/ui/prompts/test")
async def ui_prompt_test(req: PromptDryRunRequest):
    run_id = str(uuid.uuid4())
    payload = _enqueue_background_job(
        run_id=run_id,
        job_type="agent",
        url=req.url,
        actor=req.agent,
        payload={"agent": req.agent, "url": req.url, "prompt_override": req.content},
    )
    return {**payload, "override_applied": True}


@app.get("/ui/runs/{run_id}/screenshot")
def ui_run_latest_screenshot(run_id: str):
    trace = run_registry.get(run_id)
    if trace is None:
        session = get_session()
        try:
            detail = OperatorConsoleRepository(session).get_run_detail(run_id)
            if detail:
                screenshots = (detail.get("snapshot") or {}).get("all_screenshots") or []
                if screenshots:
                    return {
                        "run_id": run_id,
                        "screenshot_url": str(screenshots[-1]),
                        "event_seq": None,
                        "timestamp": None,
                        "source": "database_snapshot",
                    }
            job = BackgroundJobRepository(session).get_by_run_id(run_id)
            if job is not None and job.result_json:
                screenshot = _extract_screenshot_url_from_value(job.result_json)
                if screenshot:
                    return {
                        "run_id": run_id,
                        "screenshot_url": screenshot,
                        "event_seq": None,
                        "timestamp": None,
                        "source": "background_job_result",
                    }
        finally:
            session.close()
        raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")

    for event in reversed(trace.events):
        details = event.details if isinstance(event.details, dict) else {}
        candidate = (
            _extract_screenshot_url_from_value(details.get("result_full"))
            or _extract_screenshot_url_from_value(details.get("result_preview"))
            or _extract_screenshot_url_from_value(details)
        )
        if candidate:
            return {
                "run_id": run_id,
                "screenshot_url": candidate,
                "event_seq": event.seq,
                "timestamp": event.timestamp.isoformat(),
            }
    return {"run_id": run_id, "screenshot_url": "", "event_seq": None, "timestamp": None}


@app.get("/ui/browser/screenshot")
async def ui_browser_live_screenshot(
    profile: str = Query("landing", description="Agent profile for MCP session"),
):
    """Capture a live screenshot of the current browser session via the MCP tool server."""
    try:
        result = await _call_mcp_tool(profile, "screenshot", {}, reuse_playground_session=True)
        # Check for base64 image content in MCP response format
        content_list = result.get("content", []) if isinstance(result, dict) else []
        for item in content_list if isinstance(content_list, list) else []:
            if isinstance(item, dict) and item.get("type") == "image":
                data = item.get("data", "")
                mime = item.get("mimeType", "image/jpeg")
                if data:
                    return {
                        "screenshot": f"data:{mime};base64,{data}",
                        "source": "mcp_base64",
                        "error": None,
                    }
        # Fall back to URL extraction from result
        screenshot_url = _extract_screenshot_url_from_value(result)
        return {
            "screenshot": screenshot_url,
            "source": "mcp_url",
            "error": None,
        }
    except HTTPException as exc:
        return {"screenshot": "", "source": "error", "error": str(exc.detail)}
    except Exception as exc:
        return {"screenshot": "", "source": "error", "error": str(exc)}


@app.get("/ui/browser/status")
def ui_browser_status():
    """Return browser and MCP server health status."""
    settings = get_settings()
    browser_status = probe_browser(settings.browser_ws_endpoint)
    mcp_status = probe_mcp(settings.mcp_server_url)
    return {
        "browser": browser_status,
        "mcp": mcp_status,
        "browser_engine": settings.browser_engine,
        "browser_ws_endpoint": settings.browser_ws_endpoint,
        "mcp_server_url": settings.mcp_server_url,
    }


@app.get("/ui/database/tables")
def ui_database_tables():
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        rows: list[dict[str, Any]] = []
        for name in sorted(repo.TABLE_MAP.keys()):
            model = repo.TABLE_MAP[name]
            try:
                row_count = int(session.query(model).count())
            except SQLAlchemyError:
                row_count = 0
            rows.append({"name": name, "row_count": row_count})
        return {"tables": [row["name"] for row in rows], "entries": rows}
    finally:
        session.close()


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


# Dataset endpoints
from src.api.datasets import router as datasets_router

app.include_router(datasets_router)
