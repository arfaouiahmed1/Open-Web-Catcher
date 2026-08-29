"""FastAPI application for Open Web Catcher."""

from __future__ import annotations

import asyncio
import json
import re
import time as _time
import uuid
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from time import perf_counter
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.exc import SQLAlchemyError

from src.agents.errors import RunCancelledError
from src.agents.pools import cancel_run_pools
from src.api.provider_config import (
    ModelConfigRequest,
    apply_ui_config_update,
    get_ui_provider_models,
    ui_config_payload,
)
from src.models.enums import ExtractionStatus
from src.models.schemas import (
    AgentTestRequest,
    ClassificationResult,
    DatabaseTableResponse,
    ExtractionResult,
    OperatorOverview,
    PipelineResult,
    PricingConfig,
    ProviderInfo,
    ProviderLookupRequest,
    ToolPlaygroundRequest,
    WorkflowRunRequest,
)
from src.storage.database import create_tables, get_session
from src.storage.dataset_examples import build_dataset_examples, export_dataset_examples
from src.storage.dataset_repository import DatasetRepository
from src.storage.models import PricingConfigRecord
from src.storage.repositories import (
    BackgroundJobRepository,
    RunPlanRepository,
    RunRepository,
    normalize_runtime_event_payload,
)
from src.storage.ui_repository import OperatorConsoleRepository
from src.utils.config import (
    Settings,
    SettingsPatchError,
    normalize_runtime_profile,
    read_settings_with_sources,
    resolve_agent_runtime_config,
    validate_settings_patch,
)
from src.utils.console_state import (
    JOB_ACTIVE_STATUSES,
    JOB_TERMINAL_STATUSES,
    RUN_TERMINAL_STATUSES,
    normalize_job_display_status,
)
from src.utils.ipinfo import lookup_multiple
from src.utils.logging import get_logger, setup_logging
from src.utils.observability import RunTrace, get_observability_status, run_registry
from src.utils.provider_models import ProviderModelCatalogError
from src.utils.provider_pricing import ProviderPricingSyncError, fetch_provider_pricing
from src.utils.service_health import (
    build_runtime_preflight,
    probe_browser,
    probe_mcp,
)
from src.utils.timefmt import iso_z

logger = get_logger(__name__)

_settings: Settings | None = None
RUNTIME_TOOL_PROFILES = ("classification", "landing", "hosting", "embedded")

# ── Simple in-memory TTL cache for expensive read endpoints ──────────────
_TTL_CACHE: dict[str, tuple[float, Any]] = {}
_OVERVIEW_CACHE_TTL_SECONDS = 6.0  # overview is polled every 5–8 s; cache for 6 s
_SSE_KEEPALIVE_SECONDS = 20.0  # send SSE `: heartbeat` comment every 20 s


def _get_mcp_client_exports():
    from src.tools.mcp_client import REQUIRED_TOOLS_BY_PROFILE, agent_tools

    return REQUIRED_TOOLS_BY_PROFILE, agent_tools


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
    session_key: str
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


def _background_job_payload(job: Any) -> dict[str, Any]:
    return {
        "run_id": str(job.run_id or ""),
        "job_type": str(job.job_type or ""),
        "url": str(job.url or ""),
        "actor": str(job.actor or ""),
        "payload_json": dict(job.payload_json or {}),
    }


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


class PromptUpdateRequest(BaseModel):
    content: str = ""


class MemorySearchRequest(BaseModel):
    query: str
    domain: str = ""
    page_type: str = ""
    limit: int = 8


class MemoryUpdateRequest(BaseModel):
    """Write payload for the Node memory_update proxy (plan task 18 phase 2)."""

    url: str
    page_type: str = "unknown"
    refresh_reason: str = ""
    status: str = "success"
    selectors: list[str] = []
    navigation_steps: list[str] = []
    playbook_steps: list[str] = []


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


def get_settings(force_reload: bool = False) -> Settings:
    global _settings
    if _settings is None or force_reload:
        _settings = Settings.from_yaml()
        try:
            _settings.save_browser_runtime_bridge()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not refresh browser runtime bridge on startup: %s", exc)
    return _settings


def reset_settings_cache() -> None:
    """Reset the cached settings to force reload from disk on next access."""
    global _settings
    _settings = None


def _playground_tool_session_key(profile: str, settings: Settings) -> str:
    browser = str(getattr(settings, "browser_engine", "") or "playwright").strip().lower()
    mcp_url = str(getattr(settings, "mcp_server_url", "") or "").strip()
    disabled_signature = json.dumps(
        {
            "legacy": getattr(settings, "disabled_tools_by_profile", {}) or {},
            "by_browser": getattr(settings, "disabled_tools_by_browser_profile", {}) or {},
        },
        sort_keys=True,
        default=str,
    )
    return f"{browser}|{mcp_url}|{profile}|{disabled_signature}"


async def _close_playground_tool_session(session_key: str) -> None:
    session: _PlaygroundToolSession | None = None
    async with _playground_tool_session_lock:
        session = _playground_tool_sessions.pop(session_key, None)

    if session is None:
        return

    try:
        await session.manager.__aexit__(None, None, None)
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "Failed to close playground MCP session for '%s' (%s): %s",
            session.profile,
            session_key,
            exc,
        )


async def _close_all_playground_tool_sessions() -> None:
    session_keys: list[str]
    async with _playground_tool_session_lock:
        session_keys = list(_playground_tool_sessions.keys())

    for session_key in session_keys:
        await _close_playground_tool_session(session_key)


async def _cleanup_expired_playground_tool_sessions() -> None:
    now = perf_counter()
    session_keys_to_close: list[str] = []
    async with _playground_tool_session_lock:
        for session_key, session in list(_playground_tool_sessions.items()):
            if (now - session.last_used_at) >= _PLAYGROUND_SESSION_TTL_SECONDS:
                session_keys_to_close.append(session_key)

    for session_key in session_keys_to_close:
        await _close_playground_tool_session(session_key)


def _track_run_task(run_id: str, task: asyncio.Task) -> asyncio.Task:
    _active_run_tasks[run_id] = task

    def _cleanup(completed_task: asyncio.Task) -> None:
        current = _active_run_tasks.get(run_id)
        if current is completed_task:
            _active_run_tasks.pop(run_id, None)

    task.add_done_callback(_cleanup)
    return task


async def _cancel_active_run_task(run_id: str) -> bool:
    # Plan T28 / spike §D4 layer 4: tear down the run's streaming pool workers
    # (sentinels + cancel) before unwinding the top-level task, so a hard
    # teardown cannot leave orphaned workers holding browser sessions.
    await cancel_run_pools(run_id)
    task = _active_run_tasks.get(run_id)
    if task is None or task.done():
        return False
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task
    return True


async def _get_playground_tools(profile: str, settings: Settings) -> list[Any]:
    _, agent_tools = _get_mcp_client_exports()
    await _cleanup_expired_playground_tool_sessions()
    now = perf_counter()
    session_key = _playground_tool_session_key(profile, settings)

    async with _playground_tool_session_lock:
        existing = _playground_tool_sessions.get(session_key)
        if existing is not None:
            existing.last_used_at = now
            return existing.tools

    manager = agent_tools(profile, settings)
    tools = await manager.__aenter__()

    async with _playground_tool_session_lock:
        existing = _playground_tool_sessions.get(session_key)
        if existing is None:
            _playground_tool_sessions[session_key] = _PlaygroundToolSession(
                session_key=session_key,
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
        surviving = _playground_tool_sessions[session_key]
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
    raw = [item.strip() for item in settings.ui_cors_origins.split(",") if item.strip()]
    hardened = [origin for origin in raw if origin != "*"]
    if len(hardened) != len(raw):
        logger.warning(
            "ui_cors_origins contained a wildcard '*' entry; rejected by CORS "
            "hardening (plan T47). Configure explicit origins instead."
        )
    return hardened


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
    effective_provider = (provider or settings.llm_provider or "google").strip().lower()
    if effective_provider not in {"google", "gemini", "google_genai"}:
        raise NotImplementedError("Provider pricing sync supports Google Gemini only.")
    effective_provider = "google"
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
    if provider_key in {"google", "gemini", "google_genai"}:
        return bool(str(settings.google_api_key or "").strip())
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
        updated_at = max(
            (row.updated_at for row in provider_rows if getattr(row, "updated_at", None)),
            default=None,
        )
        status[provider_key] = {
            "provider": provider_key,
            "api_key_set": _provider_api_key_available(settings, provider_key),
            "configured": _provider_api_key_available(settings, provider_key),
            "model_count": len(provider_rows),
            "available": len(provider_rows) > 0,
            "last_sync_at": iso_z(updated_at),
        }
    return status


def _auto_sync_provider_pricing(settings: Settings) -> None:
    if not settings.provider_pricing_sync_enabled:
        return

    provider = "google"
    if not _provider_api_key_available(settings, provider):
        logger.info("Provider pricing sync skipped: GOOGLE_API_KEY is not configured.")
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


def _sweep_process_restart_orphans(
    session: Any,
    repo: BackgroundJobRepository,
    previous_running_run_ids: list[str],
) -> int:
    """Flip stale-recovered jobs to ``process_restart_orphan`` (plan T28 / §D5).

    For every background job the stale sweep just recovered whose ``run_id`` is
    absent from this fresh process's ``_active_run_tasks``, record the orphan
    failure mode on the job row and append a synthetic ``pipeline_failed``
    runtime event so the operator console shows truth instead of spinning.
    """
    from src.storage.models import BackgroundJobRecord

    swept = 0
    for run_id in previous_running_run_ids:
        if not run_id or run_id in _active_run_tasks:
            continue
        row = (
            session.query(BackgroundJobRecord)
            .filter(BackgroundJobRecord.run_id == run_id)
            .one_or_none()
        )
        if row is None or row.status not in {"retrying", "dead_letter"}:
            # Either untouched by the stale sweep or already terminal.
            continue
        try:
            repo.mark_failed(run_id, error_text="process_restart_orphan")
        except Exception as exc:  # noqa: BLE001 — sweep must never crash startup
            logger.warning("Failed to mark restart orphan %s: %s", run_id, exc)
            continue
        observer = None
        trace = run_registry.get(run_id)
        if trace is not None:
            observer = run_registry.restore(trace)
        if observer is not None:
            try:
                observer.emit(
                    "pipeline_failed",
                    "Run orphaned by a process restart; queue work was lost",
                    status="error",
                    details={"failure_mode": "process_restart_orphan"},
                )
                observer.finish(success=False, failure_mode="process_restart_orphan")
            except Exception as exc:  # noqa: BLE001
                logger.debug("Failed to finalize orphaned trace %s: %s", run_id, exc)
        swept += 1
    return swept


def _recover_background_jobs() -> int:
    session = get_session()
    try:
        from src.storage.models import BackgroundJobRecord

        repo = BackgroundJobRepository(session)
        previous_running = [
            row.run_id
            for row in session.query(BackgroundJobRecord.run_id)
            .filter(BackgroundJobRecord.status == "running")
            .all()
        ]
        recovered = repo.recover_stale_running(stale_after_seconds=180)
        if recovered and previous_running:
            _sweep_process_restart_orphans(session, repo, previous_running)
        return recovered
    except Exception as exc:  # noqa: BLE001
        logger.debug("Skipping background job recovery: %s", exc)
        return 0
    finally:
        session.close()


def _claim_background_job() -> dict[str, Any] | None:
    session = get_session()
    try:
        repo = BackgroundJobRepository(session)
        job = repo.claim_next(lease_seconds=90)
        if job is not None:
            DatasetRepository(session).mark_site_run_running(job.run_id)
            return _background_job_payload(job)
    finally:
        session.close()
    return None


async def _execute_background_job(job: dict[str, Any]) -> dict[str, Any]:
    if job is None:
        return {"ok": False, "error": "missing_background_job"}

    run_id = str(job.get("run_id", "") or "")
    job_type = str(job.get("job_type", "") or "")
    url = str(job.get("url", "") or "")
    actor = str(job.get("actor", "") or "")
    payload = dict(job.get("payload_json") or {})

    if run_registry.get(run_id) is None and not _restore_trace_from_db(run_id):
        observer = run_registry.create(
            run_id=run_id,
            root_actor=actor or ("orchestrator" if job_type == "workflow" else "agent"),
            observability=get_observability_status(get_settings()),
        )
        observer.set_url(url or "")

    if job_type == "workflow":
        execution = await _track_run_task(
            run_id,
            asyncio.create_task(_background_workflow(run_id, url, max_cost_usd=payload.get("max_cost_usd"))),
        )
    elif job_type == "agent":
        execution = await _track_run_task(
            run_id,
            asyncio.create_task(
                _background_agent(
                    run_id,
                    str(payload.get("agent", "") or actor or "classification"),
                    url,
                    prompt_override=str(payload.get("prompt_override", "") or ""),
                )
            ),
        )
    else:
        execution = {"ok": False, "error": f"Unsupported job type '{job_type}'"}

    session = get_session()
    try:
        repo = BackgroundJobRepository(session)
        dataset_repo = DatasetRepository(session)
        trace = run_registry.get(run_id)
        cancellation_requested = bool(trace is not None and trace.cancel_requested)
        if execution.get("cancelled") or cancellation_requested:
            repo.mark_cancelled(run_id, reason=str(execution.get("error", "Cancelled")))
            dataset_repo.finalize_site_run(
                run_id,
                display_status="cancelled",
                result_json=execution.get("result") or {},
                error_text=str(execution.get("error", "Cancelled")),
            )
        elif execution.get("ok"):
            repo.mark_succeeded(run_id, result_json=execution.get("result") or {})
            result_payload = execution.get("result") or {}
            dataset_repo.finalize_site_run(
                run_id,
                display_status=str(result_payload.get("final_status", "") or "success"),
                result_json=result_payload,
            )
        else:
            failed_job = repo.mark_failed(
                run_id, error_text=str(execution.get("error", "background_job_failed"))
            )
            failed_status = (
                normalize_job_display_status(str(failed_job.status or ""))
                if failed_job is not None
                else "failed"
            )
            if failed_status == "running":
                dataset_repo.mark_site_run_running(run_id)
            else:
                dataset_repo.finalize_site_run(
                    run_id,
                    display_status=failed_status,
                    result_json=execution.get("result") or {},
                    error_text=str(execution.get("error", "background_job_failed")),
                )
    finally:
        session.close()
    return execution


async def _process_background_job() -> bool:
    job = _claim_background_job()
    if job is None:
        return False
    await _execute_background_job(job)
    return True


async def _background_worker_loop() -> None:
    running: set[asyncio.Task] = set()
    while True:
        try:
            limit = max(1, int(get_settings().background_job_concurrency or 1))
            while len(running) < limit:
                job = _claim_background_job()
                if job is None:
                    break
                run_id = str(job.get("run_id", "") or "")
                task = _track_run_task(
                    run_id,
                    asyncio.create_task(_execute_background_job(job)),
                )
                running.add(task)

            if running:
                done, pending = await asyncio.wait(
                    running,
                    timeout=0.2,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                running = set(pending)
                for task in done:
                    if task.cancelled():
                        continue
                    try:
                        task.result()
                    except Exception as exc:  # noqa: BLE001
                        logger.exception("Background job task failed: %s", exc)
                continue

            await asyncio.sleep(0.8)
        except asyncio.CancelledError:
            for task in running:
                task.cancel()
            if running:
                await asyncio.gather(*running, return_exceptions=True)
            return
        except Exception as exc:  # noqa: BLE001
            logger.exception("Background worker iteration failed: %s", exc)
            await asyncio.sleep(1.0)


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _background_worker_task
    settings = get_settings()
    setup_logging(level=settings.log_level, log_file=settings.log_file)
    create_tables()
    recovered_jobs = _recover_background_jobs()
    cleanup = {"runtime_events_deleted": 0, "run_screenshots_deleted": 0}
    session = get_session()
    try:
        cleanup = RunRepository(session).cleanup_old_artifacts(
            retention_days=settings.background_job_retention_days,
            days_by_table={
                "runs": settings.retention_days_runs,
                "run_snapshots": settings.retention_days_run_snapshots,
                "llm_calls": settings.retention_days_llm_calls,
                "tool_calls": settings.retention_days_tool_calls,
                "agent_outputs": settings.retention_days_agent_outputs,
            },
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("Skipping startup artifact cleanup: %s", exc)
    finally:
        session.close()
    # Plan task 19: memory retention tick (expired site_hints + orphaned
    # embeddings) runs on the same startup pass; counts surface in the log.
    retention_counts = {"hints_pruned": 0, "embeddings_orphaned": 0}
    try:
        from src.memory.retention import run_retention_tick
        from src.storage.repositories import SiteHintRepository

        retention_session = get_session()
        try:
            retention_counts = run_retention_tick(
                SiteHintRepository(retention_session), session=retention_session
            )
        finally:
            retention_session.close()
    except Exception as exc:  # noqa: BLE001
        logger.debug("Skipping startup memory retention tick: %s", exc)
    _refresh_pricing_from_db(settings)
    _auto_sync_provider_pricing(settings)
    _background_worker_task = asyncio.create_task(_background_worker_loop())
    logger.info(
        "Open Web Catcher API started | orchestrator=%s | agents=%s | recovered_jobs=%d | cleanup=%s | retention=%s",
        settings.orchestrator_model,
        settings.agent_model,
        recovered_jobs,
        cleanup,
        retention_counts,
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
    # F-2 (security review): default /docs, /redoc and /openapi.json are plain
    # Starlette routes registered during __init__, so router-level dependencies
    # never apply to them and they leaked the full API surface pre-auth.
    # Defaults disabled here; gated replacements mounted after the guard below.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(get_settings()),
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _security_headers_middleware(request: Request, call_next):
    """Security response headers (plan T47 quick-wins)."""
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Content-Security-Policy", "frame-ancestors 'none'")
    return response

# ── Auth foundation (plan T3) ────────────────────────────────────────────────
# SECURITY-CRITICAL PLACEMENT: FastAPI snapshots router-level dependencies into
# each route at registration time, so appending the global bearer guard here —
# BEFORE any @app.* route below and before include_router calls — is what makes
# EVERY route require a token. Do not move this block down the file.
# Exemptions (POST /api/auth/login, POST /api/auth/bootstrap-admin, GET /health)
# live in PUBLIC_ROUTES; ?token=<jwt> is also accepted because the console's SSE
# consumers use native EventSource, which cannot send Authorization headers.
from src.api.auth.dependencies import get_current_user
from src.api.auth.router import router as auth_router

app.include_router(auth_router)
app.router.dependencies.append(Depends(get_current_user))

# F-2: gated documentation replacements for the disabled defaults above.
from fastapi.openapi.docs import get_redoc_html, get_swagger_ui_html
from fastapi.responses import HTMLResponse, JSONResponse


@app.get("/openapi.json", include_in_schema=False)
def _gated_openapi_json(_: Any = Depends(get_current_user)) -> JSONResponse:
    return JSONResponse(app.openapi())


@app.get("/docs", include_in_schema=False)
def _gated_swagger_ui(_: Any = Depends(get_current_user)) -> HTMLResponse:
    return get_swagger_ui_html(openapi_url="/openapi.json", title=f"{app.title} - docs")


@app.get("/redoc", include_in_schema=False)
def _gated_redoc(_: Any = Depends(get_current_user)) -> HTMLResponse:
    return get_redoc_html(openapi_url="/openapi.json", title=f"{app.title} - docs")


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
        "started_at": iso_z(trace.started_at),
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
    classification = (
        snapshot.get("classification") if isinstance(snapshot.get("classification"), dict) else {}
    )
    extraction_results = (
        snapshot.get("extraction_results")
        if isinstance(snapshot.get("extraction_results"), list)
        else []
    )
    first_extraction = (
        extraction_results[0]
        if extraction_results and isinstance(extraction_results[0], dict)
        else {}
    )
    metrics = snapshot.get("metrics") if isinstance(snapshot.get("metrics"), dict) else {}
    raw_events = snapshot.get("events")
    if not isinstance(raw_events, list):
        raw_trace = snapshot.get("trace") if isinstance(snapshot.get("trace"), dict) else {}
        raw_events = raw_trace.get("events") if isinstance(raw_trace.get("events"), list) else []
    events = [
        normalize_runtime_event_payload(event) for event in raw_events if isinstance(event, dict)
    ]

    screenshots = _extract_screenshot_urls_from_value(snapshot.get("all_screenshots", []))
    _extract_screenshot_urls_from_value(snapshot, screenshots)
    streams = snapshot.get("all_streams") if isinstance(snapshot.get("all_streams"), list) else []
    if not streams and first_extraction:
        streams = (
            first_extraction.get("streams")
            if isinstance(first_extraction.get("streams"), list)
            else []
        )

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

    final_status = str(
        snapshot.get("final_status") or _background_job_display_status(job) or ""
    ).strip()
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


def _recover_missing_takedown_emails(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return payload
    snapshot = payload.get("snapshot") if isinstance(payload.get("snapshot"), dict) else {}
    existing = payload.get("takedown_emails")
    if isinstance(existing, list) and existing:
        if isinstance(snapshot, dict) and not snapshot.get("takedown_emails"):
            snapshot["takedown_emails"] = existing
        return payload

    snapshot_existing = snapshot.get("takedown_emails") if isinstance(snapshot, dict) else []
    if isinstance(snapshot_existing, list) and snapshot_existing:
        payload["takedown_emails"] = snapshot_existing
        return payload

    provider_rows = payload.get("provider_analysis")
    if not isinstance(provider_rows, list) or not provider_rows:
        provider_rows = snapshot.get("provider_analysis") if isinstance(snapshot, dict) else []
    extraction_rows = snapshot.get("extraction_results") if isinstance(snapshot, dict) else []
    if not isinstance(provider_rows, list) or not provider_rows or not isinstance(extraction_rows, list):
        return payload

    try:
        from src.agents.email_generator import generate_takedown_emails

        providers = [ProviderInfo(**row) for row in provider_rows if isinstance(row, dict)]
        extractions = [ExtractionResult(**row) for row in extraction_rows if isinstance(row, dict)]
        run_row = payload.get("run") if isinstance(payload.get("run"), dict) else {}
        infringing_url = str(run_row.get("url") or snapshot.get("url") or "")
        emails = generate_takedown_emails(
            infringing_url=infringing_url,
            extraction_results=extractions,
            provider_analysis=providers,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("Skipping takedown email recovery: %s", exc)
        return payload

    if not emails:
        return payload
    email_payload = [email.model_dump(mode="json") for email in emails]
    payload["takedown_emails"] = email_payload
    if isinstance(snapshot, dict):
        snapshot["takedown_emails"] = email_payload
    run_row = payload.get("run")
    if isinstance(run_row, dict):
        run_row["email_count"] = max(int(run_row.get("email_count") or 0), len(email_payload))
    payload["takedown_email_recovery"] = {
        "source": "provider_analysis_and_extraction_results",
        "count": len(email_payload),
    }
    return payload


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
        "created_at": iso_z(created_at),
        "started_at": iso_z(started_at),
        "finished_at": iso_z(finished_at),
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
        "created_at": iso_z(getattr(job, "created_at", None)),
        "started_at": iso_z(getattr(job, "started_at", None)),
        "finished_at": iso_z(getattr(job, "finished_at", None)),
        "heartbeat_at": iso_z(getattr(job, "heartbeat_at", None)),
    }


def _background_llm_rows(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    seq = 0
    for event in events:
        if event.get("kind") != "llm_response":
            continue
        seq += 1
        details = event.get("details") if isinstance(event.get("details"), dict) else {}
        usage = (
            details.get("usage_metadata") if isinstance(details.get("usage_metadata"), dict) else {}
        )
        if not usage:
            usage = (
                details.get("usage_metadata_json")
                if isinstance(details.get("usage_metadata_json"), dict)
                else {}
            )
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
                "args": details.get("tool_args")
                if isinstance(details.get("tool_args"), dict)
                else {},
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
                "created_at": str(
                    (started or {}).get("created_at")
                    or event.get("timestamp")
                    or event.get("created_at")
                    or ""
                ),
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
            normalize_runtime_event_payload(event.model_dump(mode="json")) for event in trace.events
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
        "estimated_input_cost_usd": float(metrics.estimated_input_cost_usd or 0.0)
        if metrics
        else 0.0,
        "estimated_cached_input_cost_usd": float(metrics.estimated_cached_input_cost_usd or 0.0)
        if metrics
        else 0.0,
        "estimated_cache_write_cost_usd": float(metrics.estimated_cache_write_cost_usd or 0.0)
        if metrics
        else 0.0,
        "estimated_output_cost_usd": float(metrics.estimated_output_cost_usd or 0.0)
        if metrics
        else 0.0,
        "estimated_total_cost_usd": float(metrics.estimated_total_cost_usd or 0.0)
        if metrics
        else 0.0,
        "total_cost_usd": float(metrics.estimated_total_cost_usd or 0.0) if metrics else 0.0,
        "total_messages": int(metrics.total_messages or 0) if metrics else 0,
        "created_at": iso_z(trace.started_at),
        "started_at": iso_z(trace.started_at),
        "finished_at": iso_z(trace.finished_at),
        "root_actor": trace.root_actor,
        "job_type": str(
            (job_state or {}).get("job_type")
            or ("workflow" if trace.root_actor == "orchestrator" else "agent")
        ),
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
            snapshot_payload.get("classification", {}).get("confidence") or ""
        ),
        "classification_reasoning": str(
            snapshot_payload.get("classification", {}).get("reasoning") or ""
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
        "events": [
            normalize_runtime_event_payload(event.model_dump(mode="json")) for event in trace.events
        ],
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
        try:
            # Snapshot commits inside save_trace_snapshot; heartbeat stays independent.
            RunRepository(session).save_trace_snapshot(
                run_id=run_id, root_actor=root_actor, url=url, trace=trace
            )
        except SQLAlchemyError as exc:
            logger.warning("Trace snapshot persistence failed for run_id=%s: %s", run_id, exc)
            return
        try:
            BackgroundJobRepository(session).heartbeat(run_id)
        except SQLAlchemyError as exc:
            logger.warning("Heartbeat after trace snapshot failed for run_id=%s: %s", run_id, exc)
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
        (metrics_payload.get("started_at") if isinstance(metrics_payload, dict) else None)
        or getattr(job, "started_at", None)
        or getattr(job, "created_at", None)
    )
    trace_payload = {
        "run_id": run_id,
        "root_actor": job.actor or ("orchestrator" if job.job_type == "workflow" else "agent"),
        "started_at": started_at,
        "finished_at": metrics_payload.get("finished_at")
        if isinstance(metrics_payload, dict)
        else None,
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


async def _background_workflow(run_id: str, url: str, max_cost_usd: float | None = None) -> dict[str, Any]:
    from src.agents.orchestrator import run_pipeline as _run_pipeline

    settings = get_settings()
    observer = run_registry.create(
        run_id=run_id,
        root_actor="orchestrator",
        observability=get_observability_status(settings),
    )
    observer.set_url(url)
    if max_cost_usd is not None:
        observer.set_max_cost_usd(max_cost_usd)
    persist_task = asyncio.create_task(
        _trace_persist_loop(run_id, root_actor="orchestrator", url=url)
    )
    try:
        result = await _run_pipeline(url=url, settings=settings, observer=observer)
        if observer.is_cancel_requested():
            raise RunCancelledError(observer.cancel_reason())
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
        runtime_settings = resolve_agent_runtime_config(settings, normalize_runtime_profile(agent))
        timeout_seconds = max(30, int(runtime_settings["agent_timeout_seconds"]))
        result = await asyncio.wait_for(
            _run_selected_agent(
                agent,
                url,
                {"observer": observer, "prompt_override": prompt_override},
            ),
            timeout=timeout_seconds,
        )
        if observer.is_cancel_requested():
            raise RunCancelledError(observer.cancel_reason())
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
    _, agent_tools = _get_mcp_client_exports()

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
    if any(
        path.endswith(ext) for ext in (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg")
    ):
        return True
    if "/image/" in path or "/images/" in path or "image/upload" in path:
        return True
    if any(
        token in query
        for token in (
            "format=png",
            "format=jpg",
            "format=jpeg",
            "format=webp",
            "fm=png",
            "fm=jpg",
            "fm=jpeg",
            "fm=webp",
        )
    ):
        return True
    return False


_SCREENSHOT_SINGLE_KEYS = ("screenshot_url", "screenshot")
_SCREENSHOT_MULTI_KEYS = ("screenshot_urls", "screenshots", "all_screenshots")
_SCREENSHOT_WRAPPER_KEYS = (
    "result_full",
    "result_preview",
    "result",
    "output",
    "payload",
    "data",
    "details",
    "details_json",
    "response",
    "record",
    "content",
    "text",
    "message",
)
_EMBEDDED_SCREENSHOT_RE = re.compile(
    r'(?:\\?"(?:screenshot_url|screenshot)\\?"\s*:\s*\\?")(https?:\/\/[^"\\]+|data:image\/[^"\\]+)(?:\\?")'
)


def _json_string_candidates(value: str) -> list[Any]:
    candidates: list[Any] = []
    text = str(value or "").strip()
    if not text:
        return candidates
    try:
        candidates.append(json.loads(text))
    except Exception:
        pass
    try:
        unescaped = text.replace('\\"', '"').replace("\\\\", "\\")
        if unescaped != text:
            candidates.append(json.loads(unescaped))
    except Exception:
        pass
    return candidates


def _extract_screenshot_url_from_value(value: Any) -> str:
    urls = _extract_screenshot_urls_from_value(value, [])
    return urls[0] if urls else ""


def _append_screenshot(value: Any, out: list[str]) -> None:
    text = str(value or "").strip()
    if text and _is_valid_screenshot_url(text) and text not in out:
        out.append(text)


def _collect_from_object(value: dict[str, Any], out: list[str]) -> None:
    item_type = str(value.get("type") or "").strip().lower()
    if item_type == "image":
        data = str(value.get("data") or "").strip()
        if data:
            mime = str(value.get("mimeType") or value.get("mime_type") or "image/png").strip() or "image/png"
            _append_screenshot(f"data:{mime};base64,{data}", out)

    for key in _SCREENSHOT_SINGLE_KEYS:
        _append_screenshot(value.get(key), out)

    for key in _SCREENSHOT_MULTI_KEYS:
        urls = value.get(key)
        if isinstance(urls, (list, tuple, set)):
            for url in urls:
                _append_screenshot(url, out)

    for key in _SCREENSHOT_WRAPPER_KEYS:
        if key in value:
            _extract_screenshot_urls_from_value(value.get(key), out)


def _extract_screenshot_urls_from_value(value: Any, out: list[str] | None = None) -> list[str]:
    if out is None:
        out = []
    if value is None:
        return out

    if isinstance(value, str):
        text = value.strip()
        if text:
            _append_screenshot(text, out)
            if not _is_valid_screenshot_url(text):
                for parsed in _json_string_candidates(text):
                    _extract_screenshot_urls_from_value(parsed, out)
                for match in _EMBEDDED_SCREENSHOT_RE.finditer(text):
                    _append_screenshot(match.group(1), out)
        return out

    if isinstance(value, (list, tuple, set)):
        for item in value:
            _extract_screenshot_urls_from_value(item, out)
        return out

    if isinstance(value, dict):
        _collect_from_object(value, out)

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


_PLAN_EVENT_KINDS = frozenset({"run_plan_created", "plan_step_update"})


def _load_run_plan_snapshot(run_id: str) -> dict[str, Any] | None:
    """Read-only RunPlan artifact fetch for the SSE carrier (plan task 27).

    Returns the plan document with live step statuses, or None when the run
    has no plan artifact. Failures never break the stream.
    """
    session = get_session()
    try:
        return RunPlanRepository(session).get_plan(run_id)
    except Exception:
        logger.warning("Failed to load run plan snapshot", extra={"run_id": run_id})
        return None
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
                        detail_payload = OperatorConsoleRepository(session).get_run_detail(run_id)
                        if detail_payload is not None:
                            persisted_status = normalize_run_display_status(
                                str(
                                    ((detail_payload.get("run") or {}).get("final_status"))
                                    or detail_payload.get("final_status")
                                    or ""
                                ),
                                success=(detail_payload.get("run") or {}).get("success"),
                                failure_mode=str(
                                    ((detail_payload.get("run") or {}).get("failure_mode"))
                                    or ""
                                ),
                                job_status="",
                            )
                            if persisted_status in {"success", "partial", "failed", "cancelled"}:
                                display_status = persisted_status
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
                                            "timestamp": iso_z(
                                                job.finished_at or job.updated_at or job.created_at
                                            ),
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
                # Plan task 27 SSE carrier: attach the RunPlan artifact (with
                # live step statuses) on the first tick and whenever a plan
                # event flows through. plan_step_update / run_plan_created
                # events themselves ride `new_events` generically above.
                if first_tick or any(
                    event.get("kind") in _PLAN_EVENT_KINDS for event in new_events
                ):
                    plan_snapshot = _load_run_plan_snapshot(run_id)
                    if plan_snapshot is not None:
                        payload["plan"] = plan_snapshot
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


@app.get("/blobs/{key}")
def read_blob_endpoint(key: str):
    """Resolve a blobref payload (plan task 32 review fix #2).

    The DB stores ``blobref:<16-hex>`` pointers for oversized payloads and
    screenshots; this is the single production read path that turns a ref
    back into bytes. Key is sanitized inside ``read_blob`` (alnum, <=16
    chars), so no traversal is possible. Auth-gated via the router-level
    dependency like every other route. 410 signals the backing file was
    garbage-collected or never landed — callers treat it as missing data.

    Screenshots (the dominant use) are PNGs; serve those with an image type
    so <img src> works, everything else falls back to octet-stream.
    """
    from fastapi.responses import Response

    from src.storage.blob_store import read_blob

    data = read_blob(f"blobref:{key}")
    if data is None:
        raise HTTPException(status_code=410, detail="blob unavailable")
    _PNG_MAGIC = b"\x89PNG\x0d\x0a\x1a\x0a"
    media_type = "image/png" if data[:8] == _PNG_MAGIC else "application/octet-stream"
    return Response(
        content=data,
        media_type=media_type,
        headers={"Cache-Control": "private, max-age=86400"},
    )


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
                "created_at": iso_z(r.created_at),
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
    """Read the pgvector site_hints store (plan task 18 phase 2).

    This used to read legacy per-run memory entries; it now serves the same
    relational store the agents' ``memory_search`` tool reads.
    """
    from src.storage.repositories import SiteHintRepository

    session = get_session()
    try:
        records = SiteHintRepository(session).get_hints(
            domain=domain or None,
            page_type=page_type or None,
            limit=max(int(limit), 1),
        )
        return {
            "domain": domain or None,
            "page_type": page_type or None,
            "entries": [
                {
                    "domain": record.domain,
                    "page_type": record.page_type,
                    "summary_text": record.summary_text or "",
                    "navigation_steps": list(record.navigation_steps or []),
                    "selectors": list(record.selectors or []),
                    "success_rate": float(record.success_rate or 0.0),
                    "updated_at": iso_z(record.updated_at) if record.updated_at else "",
                }
                for record in records
            ],
        }
    finally:
        session.close()


@app.post("/memory/search")
def search_memory(req: MemorySearchRequest):
    """Backend search endpoint backing the agentic memory_search tool and the
    Node-side proxies (plan task 18 phase 2)."""
    from src.memory.hints_service import run_memory_search

    return run_memory_search(
        req.query,
        domain=req.domain or None,
        page_type=req.page_type,
        limit=req.limit,
    )


@app.post("/memory/update")
def update_memory(req: MemoryUpdateRequest):
    """Write path for the Node memory_update proxy — distills the patch into a
    site_hints row via write_site_hint (legacy JSON store is gone)."""
    from src.memory.site_hint_writer import write_site_hint

    raw_entry = {
        "url": req.url,
        "page_type": req.page_type,
        "status": req.status,
        "success": req.status in {"success", "partial"},
        "short_memory_summary": req.refresh_reason,
        "selectors": req.selectors,
        "playbook_steps": [*req.playbook_steps, *req.navigation_steps],
        "tool_steps": req.navigation_steps,
    }
    session = get_session()
    try:
        record = write_site_hint(
            session, domain=req.url, page_type=req.page_type, raw_entry=raw_entry
        )
        return {
            "ok": True,
            "domain": record.domain,
            "page_type": record.page_type,
            "summary_text": record.summary_text,
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
            examples, settings=settings, dataset_name=req.dataset_name
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
                persisted_display_status = str(
                    row.get("persisted_final_status", "")
                    or row.get("final_status", "")
                    or row.get("status", "")
                    or ""
                ).strip().lower()
                persisted_terminal = persisted_display_status in RUN_TERMINAL_STATUSES
                row = {
                    **row,
                    "status": row.get("status") if persisted_terminal else _background_job_display_status(job),
                    "final_status": row.get("final_status") if persisted_terminal else _background_job_display_status(job),
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
            return _recover_missing_takedown_emails(payload)
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
                        "timestamp": iso_z(job.finished_at)
                        if job.finished_at
                        else iso_z(job.started_at),
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
                "started_at": iso_z(job.started_at),
                "finished_at": iso_z(job.finished_at),
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
            return _recover_missing_takedown_emails({
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
            })
        if job_state is not None:
            payload["job_state"] = job_state
            payload["job"] = job_state
        if dataset_context is not None:
            payload["dataset_context"] = dataset_context
        return _recover_missing_takedown_emails(payload)
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
        if job is not None and str(job.status or "") not in JOB_TERMINAL_STATUSES:
            job_repo.mark_cancelled(run_id, reason=reason)
            DatasetRepository(session).mark_site_run_cancelled(run_id, reason=reason)
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
        dataset_repo = DatasetRepository(session)
        for run_id in run_ids:
            job_repo.mark_cancelled(run_id, reason=reason)
            dataset_repo.mark_site_run_cancelled(run_id, reason=reason)
    except SQLAlchemyError as exc:
        logger.debug(
            "Skipping bulk cancellation persistence because the job table is unavailable: %s", exc
        )
    finally:
        session.close()

    run_ids = list(dict.fromkeys([*run_ids, *_active_run_tasks.keys()]))
    for run_id in run_ids:
        run_registry.request_cancel(run_id, reason=reason)
        await _cancel_active_run_task(run_id)

    _cache_bust("overview")
    return {"ok": True, "cancelled": len(run_ids), "run_ids": run_ids}


@app.post("/api/datasets/batches/{batch_id}/cancel")
async def ui_cancel_dataset_batch(batch_id: str):
    reason = "Batch cancelled from the Next.js operator console."
    session = get_session()
    try:
        dataset_repo = DatasetRepository(session)
        cancel_payload = dataset_repo.cancel_batch(batch_id, reason=reason)
        run_ids = [str(run_id) for run_id in cancel_payload.get("run_ids", []) if run_id]
        job_repo = BackgroundJobRepository(session)
        for run_id in run_ids:
            job = job_repo.get_by_run_id(run_id)
            if job is not None and str(job.status or "") not in JOB_TERMINAL_STATUSES:
                job_repo.mark_cancelled(run_id, reason=reason)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except SQLAlchemyError as exc:
        logger.warning("Failed to cancel dataset batch %s: %s", batch_id, exc)
        raise HTTPException(status_code=500, detail="Could not cancel batch") from exc
    finally:
        session.close()

    for run_id in run_ids:
        run_registry.request_cancel(run_id, reason=reason)
        await _cancel_active_run_task(run_id)

    _cache_bust("overview")
    return {"ok": True, **cancel_payload}


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
            _track_run_task(
                run_id,
                asyncio.create_task(
                    _background_workflow(
                        run_id,
                        url,
                        max_cost_usd=(payload or {}).get("max_cost_usd"),
                    )
                ),
            )
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
                ),
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
        payload={"url": req.url, "max_cost_usd": req.max_cost_usd},
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
    REQUIRED_TOOLS_BY_PROFILE, _ = _get_mcp_client_exports()
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


class PricingSyncRequest(BaseModel):
    provider: str = ""
    max_models: int | None = None


@app.get("/ui/config")
def ui_get_config():
    """Return current LLM provider/model config and API key status.

    The payload additionally carries ``settings_sources``: every Settings
    field as ``{"value": ..., "source_layer": ...}`` resolved through the
    enforced precedence chain ``default < env < base_yaml < runtime_yaml``
    (T36 settings reliability contract).
    """
    settings = get_settings()
    payload = ui_config_payload(settings)
    payload["settings_sources"] = read_settings_with_sources(settings)
    return payload


@app.get("/ui/providers/models")
def ui_provider_models(
    provider: str = Query(..., min_length=2), max_models: int = Query(default=200, ge=1, le=1000)
):
    """Return provider-backed model catalog and tuning metadata."""
    try:
        return get_ui_provider_models(
            get_settings(),
            provider=provider,
            max_models=max_models,
            logger=logger,
        )
    except ProviderModelCatalogError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except HTTPException:
        raise


@app.put("/ui/config")
def ui_update_config(body: ModelConfigRequest):
    """Update active LLM provider/model at runtime and persist to settings.yaml.

    The patch is validated server-side against the typed Settings field
    models (T36): unknown or mistyped fields fail fast with 422 before any
    state is mutated or persisted.
    """
    try:
        # Typed validation only here: apply_ui_config_update owns mutation and
        # persistence; this guard makes every settings PATCH contract-safe.
        validate_settings_patch(body.model_dump(exclude_none=True))
    except SettingsPatchError as exc:
        raise HTTPException(
            status_code=422,
            detail={"message": "invalid settings update", "errors": exc.errors},
        ) from exc
    return apply_ui_config_update(
        get_settings(),
        body,
        reset_settings_cache=reset_settings_cache,
        sync_provider_pricing=lambda settings, provider: _sync_provider_pricing_to_db(
            settings, provider=provider
        ),
        logger=logger,
    )


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
    provider = (req.provider or settings.llm_provider or "google").strip().lower()
    if provider not in {"", "all", "google", "gemini", "google_genai"}:
        raise HTTPException(
            status_code=400, detail="Provider pricing sync supports Google Gemini only."
        )
    if provider in {"gemini", "google_genai"}:
        provider = "google"
    max_models = req.max_models

    try:
        if provider in {"", "all"}:
            providers = _pricing_sync_provider_ids()
            results: list[dict[str, Any]] = []
            for item in providers:
                if not _provider_api_key_available(settings, item):
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
    _refresh_pricing_from_db(settings)
    pricing = resolve_model_pricing(settings, model, provider)
    pricing_source = (
        "database"
        if (
            float(pricing.get("input_per_million", 0.0) or 0.0) > 0
            or float(pricing.get("output_per_million", 0.0) or 0.0) > 0
            or float(pricing.get("cached_input_per_million", 0.0) or 0.0) > 0
            or float(pricing.get("cache_write_per_million", 0.0) or 0.0) > 0
        )
        else "no_pricing_available"
    )

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


@app.post("/api/workflows/estimate")
def api_workflows_estimate(
    url_count: int = Query(1, ge=1, description="Number of URLs to process"),
    agent_set: str = Query("", description="Comma-separated agent names (optional filter)"),
):
    """Return a projected cost range (p50/p75) from historical run_model_usage stats.

    This is a best-effort estimate based on completed runs already in the database.
    When fewer than 5 historical data points exist the response still returns
    whatever percentiles can be computed; callers should display them with a
    low-confidence caveat.
    """
    session = get_session()
    try:
        repo = RunRepository(session)
        agent_list = [a.strip() for a in agent_set.split(",") if a.strip()] if agent_set.strip() else None
        stats = repo.cost_stats(agent_set=agent_list)
    finally:
        session.close()

    p50 = stats.get("p50_usd")
    p75 = stats.get("p75_usd")
    count = int(stats.get("count") or 0)

    if p50 is None:
        return {
            "url_count": url_count,
            "agent_set": agent_list or [],
            "historical_run_count": 0,
            "p50_total_usd": None,
            "p75_total_usd": None,
            "note": "No historical cost data available; run at least one workflow to seed estimates.",
        }

    return {
        "url_count": url_count,
        "agent_set": agent_list or [],
        "historical_run_count": count,
        "p50_per_url_usd": round(float(p50), 6),
        "p75_per_url_usd": round(float(p75), 6),
        "p50_total_usd": round(float(p50) * url_count, 6),
        "p75_total_usd": round(float(p75) * url_count, 6),
        "min_observed_usd": stats.get("min_usd"),
        "max_observed_usd": stats.get("max_usd"),
    }


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
                "timestamp": iso_z(event.timestamp),
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

# Admin APIs (plan T35): role-gated /api/admin/* routes (users CRUD, model
# performance metrics, prompt-version rollback, agent-tests, cost deltas).
from src.api.admin import router as admin_router

app.include_router(admin_router)
