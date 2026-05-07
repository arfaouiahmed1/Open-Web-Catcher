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
from src.models.enums import AgentType, Confidence, ExtractionStatus
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
from src.storage.models import PricingConfigRecord
from src.storage.repositories import (
    BackgroundJobRepository,
    RunRepository,
    normalize_runtime_event_payload,
)
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
from src.utils.observability import RunTrace, get_observability_status, run_registry
from src.utils.provider_models import (
    ProviderModelCatalogError,
    get_provider_model_catalog,
    normalize_agent_model_config,
    normalize_llm_tuning,
    resolve_agent_model_selection,
)
from src.utils.provider_pricing import ProviderPricingSyncError, fetch_provider_pricing
from src.utils.service_health import (
    build_runtime_preflight,
    probe_browser,
    probe_mcp,
)

logger = get_logger(__name__)

_settings: Settings | None = None
RUNTIME_TOOL_PROFILES = ("classification", "landing", "hosting", "embedded")

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


def _runtime_dependency_snapshot(settings: Settings) -> dict[str, Any]:
    browser_status = probe_browser(settings.browser_ws_endpoint)
    mcp_status = probe_mcp(settings.mcp_server_url)
    preflight = build_runtime_preflight(
        browser_status,
        mcp_status,
        required_profiles=RUNTIME_TOOL_PROFILES,
        require_browser=True,
    )
    return {
        "browser": browser_status,
        "mcp": mcp_status,
        "preflight": preflight,
    }


def _ensure_launch_runtime_ready(settings: Settings) -> dict[str, Any]:
    runtime = _runtime_dependency_snapshot(settings)
    if runtime["preflight"]["launch_ready"]:
        return runtime
    raise HTTPException(
        status_code=503,
        detail={
            "message": "Runtime dependencies are not ready for a new run.",
            "runtime": runtime,
        },
    )


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


class RunDecisionUpsertRequest(BaseModel):
    title: str
    summary: str = ""
    actor: str = ""
    category: str = ""
    status: str = "open"
    details: dict[str, Any] = {}


class RunTaskUpsertRequest(BaseModel):
    title: str
    description: str = ""
    actor: str = ""
    priority: str = "medium"
    status: str = "open"
    details: dict[str, Any] = {}


class RunAutoDecisionSyncItem(BaseModel):
    auto_key: str
    title: str
    summary: str = ""
    actor: str = ""
    category: str = ""
    status: str = "open"
    details: dict[str, Any] = {}


class RunAutoLogsSyncRequest(BaseModel):
    decisions: list[RunAutoDecisionSyncItem] = []


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


def _pricing_sync_provider_ids() -> list[str]:
    return ["google"]


def _provider_api_key_available(settings: Settings, provider: str) -> bool:
    provider_key = str(provider or "").strip().lower()
    if provider_key == "google":
        return bool(str(settings.google_api_key or "").strip())
    if provider_key == "google-vertex":
        return bool(str(settings.google_vertex_api_key or "").strip())
    if provider_key == "openai":
        return bool(str(settings.openai_api_key or "").strip())
    if provider_key == "anthropic":
        return bool(str(settings.anthropic_api_key or "").strip())
    if provider_key == "openrouter":
        return bool(str(settings.openrouter_api_key or "").strip())
    if provider_key == "nvidia":
        return bool(str(settings.nvidia_api_key or "").strip())
    return False


def _provider_pricing_status_payload(session, settings: Settings) -> dict[str, dict[str, Any]]:
    rows = session.query(PricingConfigRecord).all()
    grouped: dict[str, list[PricingConfigRecord]] = {}
    for row in rows:
        provider_key = str(row.provider or "").strip().lower()
        if not provider_key:
            continue
        grouped.setdefault(provider_key, []).append(row)

    status: dict[str, dict[str, Any]] = {}
    for provider_key in _pricing_sync_provider_ids():
        provider_rows = grouped.get(provider_key, [])
        updated_at = max((row.updated_at for row in provider_rows if getattr(row, "updated_at", None)), default=None)
        status[provider_key] = {
            "provider": provider_key,
            "api_key_set": _provider_api_key_available(settings, provider_key),
            "configured": provider_key == "openrouter" or _provider_api_key_available(settings, provider_key),
            "model_count": len(provider_rows),
            "available": len(provider_rows) > 0,
            "last_sync_at": updated_at.isoformat() if updated_at else "",
        }
    return status


def _auto_sync_provider_pricing(settings: Settings) -> None:
    if not settings.provider_pricing_sync_enabled:
        return

    provider = (settings.llm_provider or "").strip().lower()
    if provider != "openrouter" and not _provider_api_key_available(settings, provider):
        logger.info("Provider pricing sync skipped: provider '%s' is not configured.", provider)
        return
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
        failure_mode = str((metrics.failure_mode if metrics else "") or "").lower()
        if trace.cancel_requested or failure_mode in {"runcancellederror", "cancelled", "canceled"}:
            status = "cancelled"
        elif failure_mode == "partial":
            status = "partial"
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


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value or default)
    except (TypeError, ValueError):
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value or default)
    except (TypeError, ValueError):
        return default


def _background_job_result_summary(job: Any) -> dict[str, Any]:
    result = getattr(job, "result_json", None)
    snapshot = result if isinstance(result, dict) else {}
    classification = snapshot.get("classification") if isinstance(snapshot.get("classification"), dict) else {}
    extraction_results = snapshot.get("extraction_results") if isinstance(snapshot.get("extraction_results"), list) else []
    first_extraction = extraction_results[0] if extraction_results and isinstance(extraction_results[0], dict) else {}
    metrics = snapshot.get("metrics") if isinstance(snapshot.get("metrics"), dict) else {}
    raw_events = snapshot.get("events")
    if not isinstance(raw_events, list):
        raw_trace = snapshot.get("trace") if isinstance(snapshot.get("trace"), dict) else {}
        raw_events = raw_trace.get("events") if isinstance(raw_trace.get("events"), list) else []
    events = [normalize_runtime_event_payload(event) for event in raw_events if isinstance(event, dict)]

    screenshots = _extract_screenshot_urls_from_value(snapshot.get("all_screenshots", []))
    _extract_screenshot_urls_from_value(snapshot, screenshots)
    streams = snapshot.get("all_streams") if isinstance(snapshot.get("all_streams"), list) else []
    if not streams and first_extraction:
        streams = first_extraction.get("streams") if isinstance(first_extraction.get("streams"), list) else []

    page_type = str(
        snapshot.get("page_type")
        or snapshot.get("top_level_page_type")
        or classification.get("page_type")
        or first_extraction.get("page_type")
        or ""
    ).strip()
    confidence = str(snapshot.get("confidence") or classification.get("confidence") or "").strip()
    reasoning = str(snapshot.get("reasoning") or classification.get("reasoning") or "").strip()
    agent_type = str(
        snapshot.get("agent_type")
        or classification.get("agent_type")
        or first_extraction.get("agent_type")
        or getattr(job, "actor", "")
        or ""
    ).strip()

    llm_calls = _safe_int(metrics.get("total_llm_calls"))
    if not llm_calls:
        llm_calls = sum(1 for event in events if event.get("kind") == "llm_response")
    tool_calls = _safe_int(metrics.get("total_tool_calls"))
    if not tool_calls:
        tool_calls = sum(1 for event in events if event.get("kind") == "tool_call_started")
    tokens_in = _safe_int(metrics.get("total_tokens_in"))
    tokens_out = _safe_int(metrics.get("total_tokens_out"))
    total_messages = _safe_int(metrics.get("total_messages"))
    total_cost = _safe_float(metrics.get("estimated_total_cost_usd"))
    duration = _safe_float(metrics.get("total_duration_seconds"))
    if duration <= 0:
        started_at = getattr(job, "started_at", None)
        finished_at = getattr(job, "finished_at", None)
        if started_at is not None and finished_at is not None:
            with suppress(Exception):
                duration = max((finished_at - started_at).total_seconds(), 0.0)

    has_telemetry = bool(metrics or events)
    telemetry_status = str(snapshot.get("telemetry_status") or "").strip()
    if not telemetry_status:
        telemetry_status = "job_result" if has_telemetry else "missing"
    telemetry_message = str(snapshot.get("telemetry_message") or "").strip()
    if not telemetry_message:
        telemetry_message = (
            "Recovered metrics from the background job result payload."
            if has_telemetry
            else (
                "This job only stored the final agent answer. LLM, tool, token, "
                "stream, and screenshot telemetry was not persisted for this run."
            )
        )

    final_status = str(snapshot.get("final_status") or _background_job_display_status(job) or "").strip()
    if final_status == "succeeded":
        final_status = "success"

    return {
        "snapshot": snapshot,
        "page_type": page_type,
        "confidence": confidence,
        "reasoning": reasoning,
        "agent_type": agent_type,
        "events": events,
        "all_screenshots": screenshots,
        "all_streams": streams,
        "stream_count": len(streams),
        "screenshot_count": len(screenshots),
        "email_count": len(snapshot.get("takedown_emails", []) or []),
        "provider_analysis_count": len(snapshot.get("provider_analysis", []) or []),
        "total_llm_calls": llm_calls,
        "total_tool_calls": tool_calls,
        "total_tokens_in": tokens_in,
        "total_tokens_out": tokens_out,
        "total_messages": total_messages,
        "estimated_total_cost_usd": total_cost,
        "duration_seconds": duration,
        "final_status": final_status,
        "telemetry_status": telemetry_status,
        "telemetry_message": telemetry_message,
    }


def _background_job_row(job: Any) -> dict[str, Any]:
    display_status = _background_job_display_status(job)
    started_at = getattr(job, "started_at", None)
    finished_at = getattr(job, "finished_at", None)
    created_at = getattr(job, "created_at", None)
    summary = _background_job_result_summary(job)
    final_status = summary["final_status"] or display_status
    job_url = str(getattr(job, "url", "") or summary["snapshot"].get("url") or "")
    return {
        "run_id": job.run_id,
        "url": job_url,
        "page_type": summary["page_type"] or "unknown",
        "status": final_status,
        "final_status": final_status,
        "stream_count": summary["stream_count"],
        "screenshot_count": summary["screenshot_count"],
        "email_count": summary["email_count"],
        "provider_analysis_count": summary["provider_analysis_count"],
        "success": final_status == "success",
        "duration_seconds": summary["duration_seconds"],
        "total_tool_calls": summary["total_tool_calls"],
        "total_llm_calls": summary["total_llm_calls"],
        "total_tokens_in": summary["total_tokens_in"],
        "total_tokens_out": summary["total_tokens_out"],
        "estimated_total_cost_usd": summary["estimated_total_cost_usd"],
        "total_cost_usd": summary["estimated_total_cost_usd"],
        "total_messages": summary["total_messages"],
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
        "top_level_page_type": summary["page_type"] or "unknown",
        "classification_confidence": summary["confidence"],
        "classification_reasoning": summary["reasoning"],
        "telemetry_status": summary["telemetry_status"],
        "telemetry_message": summary["telemetry_message"],
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


def _background_llm_rows(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seq = 0
    for event in events:
        if event.get("kind") != "llm_response":
            continue
        seq += 1
        details = event.get("details") if isinstance(event.get("details"), dict) else {}
        usage = details.get("usage_metadata") if isinstance(details.get("usage_metadata"), dict) else {}
        if not usage:
            usage = details.get("usage_metadata_json") if isinstance(details.get("usage_metadata_json"), dict) else {}
        cost_source = str(details.get("cost_source") or usage.get("cost_source") or "")
        rows.append(
            {
                "agent_run_id": 0,
                "seq": seq,
                "actor": str(event.get("actor") or ""),
                "provider": str(details.get("provider") or ""),
                "model_name": str(details.get("model_name") or ""),
                "prompt_version": str((details.get("prompt") or {}).get("prompt_version", ""))
                if isinstance(details.get("prompt"), dict)
                else "",
                "prompt_hash": str((details.get("prompt") or {}).get("prompt_hash", ""))
                if isinstance(details.get("prompt"), dict)
                else "",
                "cache_mode": str((details.get("prompt") or {}).get("cache_mode", ""))
                if isinstance(details.get("prompt"), dict)
                else "",
                "input_tokens": _safe_int(details.get("input_tokens")),
                "output_tokens": _safe_int(details.get("output_tokens")),
                "context_window": _safe_int(details.get("context_window")) or None,
                "estimated_total_cost_usd": _safe_float(details.get("estimated_total_cost_usd")),
                "total_cost_usd": _safe_float(details.get("estimated_total_cost_usd")),
                "cost_source": cost_source,
                "tool_calls_requested": _safe_int(details.get("tool_calls")),
                "tools_requested": details.get("tool_call_names", []) or [],
                "content_preview": str(details.get("content_preview") or ""),
                "usage_metadata_json": usage,
                "created_at": str(event.get("timestamp") or event.get("created_at") or ""),
            }
        )
    return rows


def _background_tool_rows(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    pending: dict[str, dict[str, Any]] = {}
    rows: list[dict[str, Any]] = []
    seq = 0
    for event in events:
        kind = str(event.get("kind") or "")
        details = event.get("details") if isinstance(event.get("details"), dict) else {}
        if kind == "tool_call_started":
            seq += 1
            tool_call_id = str(details.get("tool_call_id") or f"seq-{seq}")
            pending[tool_call_id] = {
                "seq": seq,
                "actor": str(event.get("actor") or ""),
                "tool_name": str(details.get("tool_name") or ""),
                "args": details.get("tool_args") if isinstance(details.get("tool_args"), dict) else {},
                "created_at": str(event.get("timestamp") or event.get("created_at") or ""),
            }
            continue
        if kind != "tool_call_finished":
            continue
        tool_call_id = str(details.get("tool_call_id") or "")
        started = pending.pop(tool_call_id, None) if tool_call_id else None
        if started is None and pending:
            fallback_key = next(reversed(pending))
            started = pending.pop(fallback_key)
        tool_name = str(details.get("tool_name") or (started or {}).get("tool_name") or "")
        args = (started or {}).get("args", {})
        status = str(details.get("status") or event.get("status") or "success")
        rows.append(
            {
                "agent_run_id": 0,
                "seq": _safe_int((started or {}).get("seq"), len(rows) + 1),
                "actor": str(event.get("actor") or (started or {}).get("actor") or ""),
                "tool_name": tool_name,
                "args_json": args,
                "target_summary": tool_name,
                "status": status,
                "duration_seconds": _safe_float(details.get("duration_seconds")),
                "result_preview": str(details.get("result_preview") or ""),
                "error_text": str(details.get("result_preview") or "") if status == "error" else "",
                "created_at": str((started or {}).get("created_at") or event.get("timestamp") or event.get("created_at") or ""),
            }
        )
    for started in pending.values():
        rows.append(
            {
                "agent_run_id": 0,
                "seq": _safe_int(started.get("seq"), len(rows) + 1),
                "actor": str(started.get("actor") or ""),
                "tool_name": str(started.get("tool_name") or ""),
                "args_json": started.get("args") or {},
                "target_summary": str(started.get("tool_name") or ""),
                "status": "running",
                "duration_seconds": 0.0,
                "result_preview": "",
                "error_text": "",
                "created_at": str(started.get("created_at") or ""),
            }
        )
    return rows


def _build_pipeline_result_from_agent_result(
    *,
    run_id: str,
    url: str,
    result: ClassificationResult | ExtractionResult,
    trace: RunTrace | None,
) -> PipelineResult:
    metrics = trace.metrics.model_copy(deep=True) if trace and trace.metrics is not None else None
    if metrics is not None:
        metrics.run_id = run_id
        metrics.url = url

    if isinstance(result, ClassificationResult):
        all_screenshots = _trace_screenshot_urls(trace)
        return PipelineResult(
            run_id=run_id,
            url=url,
            classification=result,
            final_status=ExtractionStatus.SUCCESS,
            all_streams=[],
            all_screenshots=all_screenshots,
            metrics=metrics,
        )

    all_screenshots = _extract_screenshot_urls_from_value(result.screenshots or [])
    for screenshot in _trace_screenshot_urls(trace):
        if screenshot not in all_screenshots:
            all_screenshots.append(screenshot)
    return PipelineResult(
        run_id=run_id,
        url=url,
        extraction_results=[result],
        final_status=result.status,
        all_streams=list(result.streams or []),
        all_screenshots=all_screenshots,
        metrics=metrics,
    )


def _background_result_payload(result: PipelineResult, trace: RunTrace | None) -> dict[str, Any]:
    payload = result.model_dump(mode="json")
    if trace is not None:
        payload["events"] = [
            normalize_runtime_event_payload(event.model_dump(mode="json"))
            for event in trace.events
        ]
        payload["telemetry_status"] = "trace_payload"
        payload["telemetry_message"] = "Run telemetry was mirrored into the background job result."
    return payload


def _build_trace_detail_payload(
    *,
    run_id: str,
    trace: RunTrace,
    job_state: dict[str, Any] | None = None,
    snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    metrics = trace.metrics
    snapshot_payload = snapshot if isinstance(snapshot, dict) else {}
    status = "running"
    if trace.completed:
        failure_mode = str((metrics.failure_mode if metrics else "") or "").lower()
        if trace.cancel_requested or failure_mode in {"runcancellederror", "cancelled", "canceled"}:
            status = "cancelled"
        elif failure_mode == "partial":
            status = "partial"
        elif metrics and metrics.success:
            status = "success"
        else:
            status = "failed"

    run_row = {
        "run_id": run_id,
        "url": str((metrics.url if metrics else "") or snapshot_payload.get("url") or ""),
        "page_type": str(
            snapshot_payload.get("page_type")
            or snapshot_payload.get("classification", {}).get("page_type")
            or "unknown"
        ),
        "status": status,
        "final_status": status,
        "stream_count": len(snapshot_payload.get("all_streams", []) or []),
        "screenshot_count": len(snapshot_payload.get("all_screenshots", []) or []),
        "email_count": len(snapshot_payload.get("takedown_emails", []) or []),
        "provider_analysis_count": len(snapshot_payload.get("provider_analysis", []) or []),
        "success": bool(metrics.success) if metrics and trace.completed else False,
        "duration_seconds": float(metrics.total_duration_seconds or 0.0) if metrics else 0.0,
        "total_tool_calls": int(metrics.total_tool_calls or 0) if metrics else 0,
        "total_llm_calls": int(metrics.total_llm_calls or 0) if metrics else 0,
        "total_tokens_in": int(metrics.total_tokens_in or 0) if metrics else 0,
        "total_cached_input_tokens": int(metrics.total_cached_input_tokens or 0) if metrics else 0,
        "total_new_input_tokens": int(metrics.total_new_input_tokens or 0) if metrics else 0,
        "total_tokens_out": int(metrics.total_tokens_out or 0) if metrics else 0,
        "total_cache_hit_calls": int(metrics.total_cache_hit_calls or 0) if metrics else 0,
        "estimated_input_cost_usd": float(metrics.estimated_input_cost_usd or 0.0) if metrics else 0.0,
        "estimated_cached_input_cost_usd": float(metrics.estimated_cached_input_cost_usd or 0.0) if metrics else 0.0,
        "estimated_cache_write_cost_usd": float(metrics.estimated_cache_write_cost_usd or 0.0) if metrics else 0.0,
        "estimated_output_cost_usd": float(metrics.estimated_output_cost_usd or 0.0) if metrics else 0.0,
        "estimated_total_cost_usd": float(metrics.estimated_total_cost_usd or 0.0) if metrics else 0.0,
        "total_cost_usd": float(metrics.estimated_total_cost_usd or 0.0) if metrics else 0.0,
        "total_messages": int(metrics.total_messages or 0) if metrics else 0,
        "created_at": trace.started_at.isoformat(),
        "started_at": trace.started_at.isoformat(),
        "finished_at": trace.finished_at.isoformat() if trace.finished_at else "",
        "root_actor": trace.root_actor,
        "job_type": str((job_state or {}).get("job_type") or ("workflow" if trace.root_actor == "orchestrator" else "agent")),
        "attempts": int((job_state or {}).get("attempts", 0) or 0),
        "max_attempts": int((job_state or {}).get("max_attempts", 0) or 0),
        "job_state": str((job_state or {}).get("display_status") or status),
        "max_parallel_agents": 0,
        "top_level_page_type": str(
            snapshot_payload.get("page_type")
            or snapshot_payload.get("classification", {}).get("page_type")
            or "unknown"
        ),
        "classification_confidence": str(
            snapshot_payload.get("classification", {}).get("confidence")
            or ""
        ),
        "classification_reasoning": str(
            snapshot_payload.get("classification", {}).get("reasoning")
            or ""
        ),
        "source": "active_trace",
    }
    if job_state is not None:
        run_row["job"] = job_state

    return {
        "run": run_row,
        "snapshot": snapshot_payload,
        "provider_analysis": snapshot_payload.get("provider_analysis", []) or [],
        "takedown_emails": snapshot_payload.get("takedown_emails", []) or [],
        "all_streams": snapshot_payload.get("all_streams", []) or [],
        "all_screenshots": snapshot_payload.get("all_screenshots", []) or [],
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
        "events": [normalize_runtime_event_payload(event.model_dump(mode="json")) for event in trace.events],
        "job": job_state,
        "job_state": job_state,
        "source": "active_trace",
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
        repo = RunRepository(session)
        events = repo.list_runtime_events(run_id)
        snapshot = repo.get_run_snapshot(run_id) or {}
    except SQLAlchemyError:
        return False
    finally:
        session.close()
    if not events:
        return False
    observability = get_observability_status(get_settings())
    metrics_payload = snapshot.get("metrics") if isinstance(snapshot, dict) else {}
    started_at = (
        metrics_payload.get("started_at")
        if isinstance(metrics_payload, dict)
        else None
    ) or getattr(job, "started_at", None) or getattr(job, "created_at", None)
    trace_payload = {
        "run_id": run_id,
        "root_actor": job.actor or ("orchestrator" if job.job_type == "workflow" else "agent"),
        "started_at": started_at,
        "finished_at": metrics_payload.get("finished_at") if isinstance(metrics_payload, dict) else None,
        "events": events,
        "metrics": metrics_payload if isinstance(metrics_payload, dict) else {},
        "observability": observability.model_dump(),
        "completed": False,
        "cancel_requested": False,
        "cancel_reason": "",
    }
    try:
        trace_model = RunTrace.model_validate(trace_payload)
    except Exception:
        return False
    run_registry.restore(trace_model)
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
        trace = run_registry.get(run_id)
        await _persist_pipeline_result(result)
        return {"ok": True, "result": _background_result_payload(result, trace)}
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
        pipeline_result = _build_pipeline_result_from_agent_result(
            run_id=run_id,
            url=url,
            result=result,
            trace=run_registry.get(run_id),
        )
        trace = run_registry.get(run_id)
        await _persist_pipeline_result(pipeline_result)
        return {
            "ok": success,
            "result": _background_result_payload(pipeline_result, trace),
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


def _is_valid_screenshot_url(value: str) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    if text.startswith("data:image/"):
        return True
    if not text.startswith("http://") and not text.startswith("https://"):
        return False
    try:
        parsed = urlparse(text)
    except Exception:
        return False
    path = (parsed.path or "").lower()
    query = (parsed.query or "").lower()
    if any(path.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg")):
        return True
    if "/image/" in path or "/images/" in path or "image/upload" in path:
        return True
    if any(token in query for token in ("format=png", "format=jpg", "format=jpeg", "format=webp", "fm=png", "fm=jpg", "fm=jpeg", "fm=webp")):
        return True
    return False


def _extract_screenshot_url_from_value(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        text = value.strip()
        if _is_valid_screenshot_url(text):
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
        if isinstance(direct, str) and _is_valid_screenshot_url(direct):
            return direct.strip()
        urls = value.get("screenshot_urls")
        if isinstance(urls, list):
            for url in urls:
                if isinstance(url, str) and _is_valid_screenshot_url(url):
                    return url.strip()
        for nested in value.values():
            candidate = _extract_screenshot_url_from_value(nested)
            if candidate:
                return candidate
    return ""


def _extract_screenshot_urls_from_value(value: Any, out: list[str] | None = None) -> list[str]:
    if out is None:
        out = []
    if value is None:
        return out
    if isinstance(value, str):
        text = value.strip()
        if _is_valid_screenshot_url(text):
            if text not in out:
                out.append(text)
            return out
        try:
            parsed = json.loads(text)
        except Exception:
            parsed = None
        if parsed is not None:
            _extract_screenshot_urls_from_value(parsed, out)
        return out
    if isinstance(value, (list, tuple, set)):
        for item in value:
            _extract_screenshot_urls_from_value(item, out)
        return out
    if isinstance(value, dict):
        for key in ("screenshot_url", "screenshot"):
            candidate = value.get(key)
            if isinstance(candidate, str) and _is_valid_screenshot_url(candidate):
                text = candidate.strip()
                if text not in out:
                    out.append(text)
        for key in ("screenshot_urls", "screenshots", "all_screenshots"):
            _extract_screenshot_urls_from_value(value.get(key), out)
        for nested in value.values():
            _extract_screenshot_urls_from_value(nested, out)
    return out


def _trace_screenshot_urls(trace: RunTrace | None) -> list[str]:
    if trace is None:
        return []
    urls: list[str] = []
    for event in trace.events:
        _extract_screenshot_urls_from_value(event.details or {}, urls)
    return urls


def _empty_screenshot_payload(run_id: str, *, source: str) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "screenshot": "",
        "screenshot_url": "",
        "event_seq": None,
        "timestamp": None,
        "source": source,
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
    results = lookup_multiple(
        cleaned, ipinfo_token=settings.ipinfo_token, deduplicate_by_provider=False
    )
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        return repo.record_provider_lookup_batch(str(uuid.uuid4()), results)
    finally:
        session.close()


def _normalize_auto_key(value: str) -> str:
    return str(value or "").strip()[:255]


def _sync_auto_decisions(
    repo: OperatorConsoleRepository,
    run_id: str,
    incoming: list[RunAutoDecisionSyncItem],
) -> list[dict[str, Any]]:
    existing = repo.list_run_decisions(run_id)
    auto_existing: dict[str, dict[str, Any]] = {}
    for row in existing:
        details = row.get("details") or {}
        if details.get("source") != "agent_auto":
            continue
        auto_key = _normalize_auto_key(str(details.get("auto_key") or ""))
        if auto_key:
            auto_existing[auto_key] = row

    seen: set[str] = set()
    for item in incoming:
        auto_key = _normalize_auto_key(item.auto_key)
        if not auto_key:
            continue
        seen.add(auto_key)
        details = dict(item.details or {})
        details["source"] = "agent_auto"
        details["auto_key"] = auto_key
        current = auto_existing.get(auto_key)
        if current is None:
            repo.create_run_decision(
                run_id,
                title=item.title,
                summary=item.summary,
                actor=item.actor,
                category=item.category,
                status=item.status,
                details=details,
            )
            continue
        repo.update_run_decision(
            run_id,
            int(current["id"]),
            title=item.title,
            summary=item.summary,
            actor=item.actor,
            category=item.category,
            status=item.status,
            details=details,
        )

    for auto_key, row in auto_existing.items():
        if auto_key in seen:
            continue
        repo.delete_run_decision(run_id, int(row["id"]))

    return repo.list_run_decisions(run_id)


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
                                    normalize_runtime_event_payload(
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
                normalize_runtime_event_payload(event.model_dump(mode="json"))
                for event in trace.events
                if event.seq > last_seq
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
    runtime = _runtime_dependency_snapshot(settings)
    background_status = _background_job_health()

    return {
        "status": "ok",
        "orchestrator_model": settings.orchestrator_model,
        "agent_model": settings.agent_model,
        "browser_ws_endpoint": settings.browser_ws_endpoint,
        "mcp_server_url": settings.mcp_server_url,
        "dependencies": {
            "browser": runtime["browser"],
            "mcp": runtime["mcp"],
            "background_jobs": background_status,
        },
        "runtime_preflight": runtime["preflight"],
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

    session = get_session()
    try:
        job = BackgroundJobRepository(session).get_by_run_id(run_id)
        job_state = _background_job_state(job) if job is not None else None
        dataset_context = DatasetRepository(session).get_run_context(run_id)
        payload = OperatorConsoleRepository(session).get_run_detail(run_id)
        if active is not None:
            if payload is None:
                snapshot = RunRepository(session).get_run_snapshot(run_id)
                if snapshot is None and job is not None and job.result_json:
                    snapshot = job.result_json
                payload = _build_trace_detail_payload(
                    run_id=run_id,
                    trace=active,
                    job_state=job_state,
                    snapshot=snapshot,
                )
            else:
                if job_state is not None:
                    payload["job_state"] = job_state
                    payload["job"] = job_state
            if dataset_context is not None:
                payload["dataset_context"] = dataset_context
            if not active.completed:
                payload["active_trace"] = active.model_dump(mode="json")
            return payload
        if payload is None:
            if job is None:
                raise HTTPException(status_code=404, detail=f"Run '{run_id}' not found")
            summary = _background_job_result_summary(job)
            snapshot = summary["snapshot"]
            page_type = summary["page_type"]
            confidence = summary["confidence"]
            reasoning = summary["reasoning"]
            display_status = _background_job_display_status(job)
            run_row = _background_job_row(job)
            run_row["source"] = "background_job_result"
            events = summary["events"]
            if not events:
                events = [
                    {
                        "seq": 1,
                        "timestamp": job.finished_at.isoformat()
                        if job.finished_at
                        else (job.started_at.isoformat() if job.started_at else ""),
                        "actor": str(job.actor or ""),
                        "kind": "agent_finished",
                        "message": "Agent result loaded from background job result payload.",
                        "status": display_status,
                        "details": {
                            "page_type": page_type,
                            "confidence": confidence,
                            "reasoning": reasoning,
                        },
                        "details_json": {
                            "page_type": page_type,
                            "confidence": confidence,
                            "reasoning": reasoning,
                        },
                    }
                ]
            llm_rows = _background_llm_rows(events)
            tool_rows = _background_tool_rows(events)

            agent_output_summary = reasoning or (
                f"Classified as {page_type or 'unknown'}"
                + (f" ({confidence})" if confidence else "")
            )
            stream_count = summary["stream_count"]
            input_tokens = summary["total_tokens_in"]
            output_tokens = summary["total_tokens_out"]
            total_tokens = input_tokens + output_tokens
            synthetic_rollup = {
                "agent_run_id": 0,
                "actor": str(job.actor or ""),
                "agent_type": summary["agent_type"] or str(job.actor or ""),
                "status": run_row["final_status"] or display_status,
                "started_at": job.started_at.isoformat() if job.started_at else "",
                "finished_at": job.finished_at.isoformat() if job.finished_at else "",
                "duration_seconds": float(run_row.get("duration_seconds", 0.0) or 0.0),
                "tool_calls": len(tool_rows) or summary["total_tool_calls"],
                "tool_calls_made": len(tool_rows) or summary["total_tool_calls"],
                "llm_calls": len(llm_rows) or summary["total_llm_calls"],
                "llm_calls_made": len(llm_rows) or summary["total_llm_calls"],
                "invocation_index": 1,
                "input_tokens": input_tokens,
                "cached_input_tokens": 0,
                "new_input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
                "cost_usd": summary["estimated_total_cost_usd"],
                "stream_count": stream_count,
                "embedded_url_count": 0,
                "hosting_page_count": 0,
                "output_summary": agent_output_summary,
                "raw_output": snapshot,
            }
            synthetic_stage = {
                "agent_type": synthetic_rollup["agent_type"] or str(job.actor or "agent"),
                "actors": [str(job.actor or "")] if job.actor else [],
                "status": synthetic_rollup["status"],
                "invocations": 1,
                "started_at": synthetic_rollup["started_at"],
                "finished_at": synthetic_rollup["finished_at"],
                "duration_seconds": synthetic_rollup["duration_seconds"],
                "tool_calls": synthetic_rollup["tool_calls"],
                "llm_calls": synthetic_rollup["llm_calls"],
                "input_tokens": input_tokens,
                "cached_input_tokens": 0,
                "new_input_tokens": input_tokens,
                "output_tokens": output_tokens,
                "total_tokens": total_tokens,
                "cost_usd": summary["estimated_total_cost_usd"],
                "stream_count": stream_count,
                "output_summary": agent_output_summary,
                "max_parallel_agents": 0,
                "active_parallel_agents": 0,
            }
            return {
                "run": run_row,
                "snapshot": snapshot,
                "provider_analysis": snapshot.get("provider_analysis", []) or [],
                "takedown_emails": snapshot.get("takedown_emails", []) or [],
                "all_streams": summary["all_streams"],
                "all_screenshots": summary["all_screenshots"],
                "agent_runs": [],
                "agent_outputs": [
                    {
                        "agent_run_id": 0,
                        "actor": str(job.actor or ""),
                        "agent_type": synthetic_rollup["agent_type"],
                        "invocation_index": 1,
                        "summary_text": agent_output_summary,
                        "validation_status": "ok" if page_type else "missing",
                        "stream_count": stream_count,
                        "embedded_url_count": 0,
                        "hosting_page_count": 0,
                        "output_json": snapshot,
                    }
                ],
                "agent_rollups": [synthetic_rollup],
                "stage_rollups": [synthetic_stage],
                "parallelism": {
                    "current_parallel_agents": 0,
                    "max_parallel_agents": 0,
                    "by_stage": [],
                },
                "tool_calls": tool_rows,
                "llm_calls": llm_rows,
                "events": events,
                "job": _background_job_state(job),
                "job_state": _background_job_state(job),
                "source": "background_job_result",
                "telemetry_status": summary["telemetry_status"],
                "telemetry_message": summary["telemetry_message"],
                "dataset_context": dataset_context,
            }
        if job_state is not None:
            payload["job_state"] = job_state
            payload["job"] = job_state
        if dataset_context is not None:
            payload["dataset_context"] = dataset_context
        return payload
    finally:
        session.close()


@app.get("/ui/runs/{run_id}/decisions")
def ui_run_decisions(run_id: str):
    session = get_session()
    try:
        rows = OperatorConsoleRepository(session).list_run_decisions(run_id)
        return {"run_id": run_id, "decisions": rows}
    finally:
        session.close()


@app.post("/ui/runs/{run_id}/decisions")
def ui_create_run_decision(run_id: str, body: RunDecisionUpsertRequest):
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="Decision title is required")
    session = get_session()
    try:
        row = OperatorConsoleRepository(session).create_run_decision(
            run_id,
            title=body.title,
            summary=body.summary,
            actor=body.actor,
            category=body.category,
            status=body.status,
            details=body.details,
        )
        return row
    finally:
        session.close()


@app.patch("/ui/runs/{run_id}/decisions/{decision_id}")
def ui_update_run_decision(
    run_id: str,
    decision_id: int,
    body: RunDecisionUpsertRequest,
):
    session = get_session()
    try:
        row = OperatorConsoleRepository(session).update_run_decision(
            run_id,
            decision_id,
            title=body.title,
            summary=body.summary,
            actor=body.actor,
            category=body.category,
            status=body.status,
            details=body.details,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Decision not found")
        return row
    finally:
        session.close()


@app.delete("/ui/runs/{run_id}/decisions/{decision_id}")
def ui_delete_run_decision(run_id: str, decision_id: int):
    session = get_session()
    try:
        deleted = OperatorConsoleRepository(session).delete_run_decision(run_id, decision_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Decision not found")
        return {"ok": True}
    finally:
        session.close()


@app.get("/ui/runs/{run_id}/tasks")
def ui_run_tasks(run_id: str):
    session = get_session()
    try:
        rows = OperatorConsoleRepository(session).list_run_tasks(run_id)
        return {"run_id": run_id, "tasks": rows}
    finally:
        session.close()


@app.post("/ui/runs/{run_id}/tasks")
def ui_create_run_task(run_id: str, body: RunTaskUpsertRequest):
    if not body.title.strip():
        raise HTTPException(status_code=400, detail="Task title is required")
    session = get_session()
    try:
        row = OperatorConsoleRepository(session).create_run_task(
            run_id,
            title=body.title,
            description=body.description,
            actor=body.actor,
            priority=body.priority,
            status=body.status,
            details=body.details,
        )
        return row
    finally:
        session.close()


@app.patch("/ui/runs/{run_id}/tasks/{task_id}")
def ui_update_run_task(
    run_id: str,
    task_id: int,
    body: RunTaskUpsertRequest,
):
    session = get_session()
    try:
        row = OperatorConsoleRepository(session).update_run_task(
            run_id,
            task_id,
            title=body.title,
            description=body.description,
            actor=body.actor,
            priority=body.priority,
            status=body.status,
            details=body.details,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Task not found")
        return row
    finally:
        session.close()


@app.delete("/ui/runs/{run_id}/tasks/{task_id}")
def ui_delete_run_task(run_id: str, task_id: int):
    session = get_session()
    try:
        deleted = OperatorConsoleRepository(session).delete_run_task(run_id, task_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Task not found")
        return {"ok": True}
    finally:
        session.close()


@app.post("/ui/runs/{run_id}/sync-logs")
def ui_sync_run_logs(run_id: str, body: RunAutoLogsSyncRequest):
    session = get_session()
    try:
        repo = OperatorConsoleRepository(session)
        decisions = _sync_auto_decisions(repo, run_id, body.decisions)
        return {
            "run_id": run_id,
            "decisions": decisions,
        }
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
    settings = get_settings()
    _ensure_launch_runtime_ready(settings)
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
    settings = get_settings()
    _ensure_launch_runtime_ready(settings)
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
    thinking_enabled: bool | None = None
    thinking_budget_tokens: int | None = None
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
        "thinking_enabled": getattr(settings, "thinking_enabled", False),
        "thinking_budget_tokens": getattr(settings, "thinking_budget_tokens", 8000),
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
            "google-vertex": bool(settings.google_vertex_api_key),
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
    if body.thinking_enabled is not None:
        s.thinking_enabled = body.thinking_enabled
    if body.thinking_budget_tokens is not None:
        s.thinking_budget_tokens = max(1000, min(32000, int(body.thinking_budget_tokens)))
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
            "provider_statuses": _provider_pricing_status_payload(session, get_settings()),
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
            providers = _pricing_sync_provider_ids()
            results: list[dict[str, Any]] = []
            for item in providers:
                if item != "openrouter" and not _provider_api_key_available(settings, item):
                    results.append(
                        {
                            "provider": item,
                            "synced": 0,
                            "stored": 0,
                            "models": [],
                            "error": "provider_api_key_missing",
                        }
                    )
                    continue
                if item == "openrouter" and not (settings.openrouter_api_key or "").strip():
                    results.append(
                        {
                            "provider": item,
                            "synced": 0,
                            "stored": 0,
                            "models": [],
                            "error": "provider_api_key_missing",
                        }
                    )
                    continue
                try:
                    results.append(
                        _sync_provider_pricing_to_db(settings, provider=item, max_models=max_models)
                    )
                except (NotImplementedError, ProviderPricingSyncError) as exc:
                    results.append(
                        {
                            "provider": item,
                            "synced": 0,
                            "stored": 0,
                            "models": [],
                            "error": str(exc),
                        }
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
    cache_write_input_tokens: int = Query(0, ge=0, description="Cache write token count"),
):
    """Estimate cost for a given provider, model, and token counts."""
    from src.utils.instrumentation import estimate_usage_cost, resolve_model_pricing

    settings = get_settings()
    pricing = resolve_model_pricing(settings, model, provider)
    pricing_source = "database" if (
        float(pricing.get("input_per_million", 0.0) or 0.0) > 0
        or float(pricing.get("output_per_million", 0.0) or 0.0) > 0
        or float(pricing.get("cached_input_per_million", 0.0) or 0.0) > 0
        or float(pricing.get("cache_write_per_million", 0.0) or 0.0) > 0
    ) else "no_pricing_available"

    if pricing_source == "no_pricing_available":
        return {
            "provider": provider,
            "model": model,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_input_tokens": cached_input_tokens,
            "cache_write_input_tokens": cache_write_input_tokens,
            "input_cost_usd": 0.0,
            "cached_input_cost_usd": 0.0,
            "cache_write_cost_usd": 0.0,
            "output_cost_usd": 0.0,
            "total_cost_usd": 0.0,
            "pricing_source": pricing_source,
        }

    costs = estimate_usage_cost(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cached_input_tokens=cached_input_tokens,
        cache_write_input_tokens=cache_write_input_tokens,
        input_per_million=float(pricing.get("input_per_million", 0.0) or 0.0),
        output_per_million=float(pricing.get("output_per_million", 0.0) or 0.0),
        cached_input_per_million=float(pricing.get("cached_input_per_million", 0.0) or 0.0),
        cache_write_per_million=float(pricing.get("cache_write_per_million", 0.0) or 0.0),
    )

    return {
        "provider": provider,
        "model": model,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cached_input_tokens": cached_input_tokens,
        "cache_write_input_tokens": cache_write_input_tokens,
        "input_cost_usd": costs["estimated_input_cost_usd"],
        "cached_input_cost_usd": costs["estimated_cached_input_cost_usd"],
        "cache_write_cost_usd": costs["estimated_cache_write_cost_usd"],
        "output_cost_usd": costs["estimated_output_cost_usd"],
        "total_cost_usd": costs["estimated_total_cost_usd"],
        "pricing_source": pricing_source,
    }


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
                screenshot = _extract_screenshot_url_from_value(
                    (detail.get("snapshot") or {}).get("all_screenshots")
                    or detail.get("all_screenshots")
                    or []
                )
                if screenshot:
                    return {
                        "run_id": run_id,
                        "screenshot": screenshot,
                        "screenshot_url": screenshot,
                        "event_seq": None,
                        "timestamp": None,
                        "source": "database_snapshot",
                    }
                return _empty_screenshot_payload(run_id, source="database_snapshot")
            job = BackgroundJobRepository(session).get_by_run_id(run_id)
            if job is not None and job.result_json:
                screenshot = _extract_screenshot_url_from_value(job.result_json)
                if screenshot:
                    return {
                        "run_id": run_id,
                        "screenshot": screenshot,
                        "screenshot_url": screenshot,
                        "event_seq": None,
                        "timestamp": None,
                        "source": "background_job_result",
                    }
                return _empty_screenshot_payload(run_id, source="background_job_result")
            if job is not None:
                return _empty_screenshot_payload(run_id, source="background_job")
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
                "screenshot": candidate,
                "screenshot_url": candidate,
                "event_seq": event.seq,
                "timestamp": event.timestamp.isoformat(),
                "source": "active_trace",
            }
    return _empty_screenshot_payload(run_id, source="active_trace")


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
    runtime = _runtime_dependency_snapshot(settings)
    return {
        "browser": runtime["browser"],
        "mcp": runtime["mcp"],
        "preflight": runtime["preflight"],
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
    limit: int = Query(50, ge=1, le=500),
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
