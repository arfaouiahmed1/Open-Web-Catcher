"""CRUD operations for legacy snapshots and normalized observability storage."""

from __future__ import annotations

import hashlib
import logging
import math
import re
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from sqlalchemy import func, select, text, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from src.utils.timefmt import iso_z
from src.memory.long_term import build_site_memory_entry
from src.models.enums import AgentType, EventKind, ExtractionStatus
from src.models.schemas import PipelineResult
from src.storage.blob_store import cap_or_overflow, data_uri_to_blob_ref
from src.storage.models import (
    AgentOutputRecord,
    AgentRunRecord,
    BackgroundJobRecord,
    LLMCallRecord,
    MemoryEntryRecord,
    MemoryHintUsedRecord,
    PipelineRunRecord,
    PromptCompilationRecord,
    PromptVersionRecord,
    ProviderAnalysisRecord,
    PlanStepRecord,
    RunPlanRecord,
    RunModelUsageRecord,
    RunRecord,
    RunScreenshotRecord,
    RunSnapshotRecord,
    RunStreamRecord,
    RuntimeEventRecord,
    SiteHintRecord,
    TakedownEmailRecord,
    ToolCallRecord,
)
from src.utils.console_state import RUN_TERMINAL_STATUSES
from src.utils.observability import RunTrace


_SCREENSHOT_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg")

logger = logging.getLogger(__name__)
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

# Event schema v2 (plan T31 / SCH-M6/H5): every persisted JSON blob (event
# details, run snapshots, llm/tool row metadata dicts) carries an integer
# schema_version so downstream consumers can detect payload shape.
EVENT_SCHEMA_VERSION = 2


def stamp_schema_version(blob: dict[str, Any] | None) -> dict[str, Any]:
    """Return a copy of ``blob`` stamped with ``schema_version: 2``."""
    data = dict(blob) if isinstance(blob, dict) else {}
    data["schema_version"] = EVENT_SCHEMA_VERSION
    return data


def _is_dev_environment() -> bool:
    """Resolve dev-vs-prod from Settings (``environment`` field; T31).

    Defaults to prod on any resolution failure so persistence never crashes
    because settings could not be constructed.
    """
    try:
        from src.utils.config import Settings

        return bool(Settings().is_dev)
    except Exception:  # pragma: no cover - defensive; never break persistence
        logger.warning("Could not resolve Settings for event validation; assuming prod")
        return False


def validate_runtime_event_kind(kind: Any, *, is_dev: bool) -> str:
    """Validate a runtime-event kind against ``EventKind``.

    Dev environments fail fast on unknown kinds; prod coerces them to
    ``EventKind.UNKNOWN`` with a warning so historical/dynamic kinds never
    break persistence.
    """
    value = str(kind or "")
    try:
        return str(EventKind(value))
    except ValueError:
        if is_dev:
            raise ValueError(
                f"unknown runtime event kind {kind!r}; allowed values are "
                f"{[member.value for member in EventKind]}"
            ) from None
        logger.warning(
            "Unknown runtime event kind %r; coercing to %r", kind, str(EventKind.UNKNOWN)
        )
        return str(EventKind.UNKNOWN)


def serialize_runtime_event_record(row: RuntimeEventRecord) -> dict[str, Any]:
    """Normalize a RuntimeEventRecord into a UI/SSE-safe dict.

    Always emits `timestamp` (ISO) and `details` (object) plus legacy aliases.
    """
    timestamp = iso_z(row.created_at)
    details = row.details_json if isinstance(row.details_json, dict) else {}
    return {
        "seq": int(row.seq or 0),
        "actor": str(row.actor or ""),
        "kind": str(row.kind or ""),
        "status": str(row.status or ""),
        "message": str(row.message or ""),
        "details": details,
        "details_json": details,
        "created_at": timestamp,
        "timestamp": timestamp,
        "agent_run_id": row.agent_run_id,
    }


def normalize_runtime_event_payload(event: dict[str, Any] | None) -> dict[str, Any]:
    """Ensure an in-memory event dict (from RuntimeEvent.model_dump) carries timestamp + details."""
    if not isinstance(event, dict):
        return {}
    payload = dict(event)
    timestamp = payload.get("timestamp") or payload.get("created_at") or ""
    if hasattr(timestamp, "isoformat"):
        timestamp = iso_z(timestamp)  # type: ignore[assignment]
    payload["timestamp"] = str(timestamp or "")
    payload["created_at"] = payload.get("created_at") or payload["timestamp"]
    details = payload.get("details")
    if not isinstance(details, dict):
        details = payload.get("details_json") if isinstance(payload.get("details_json"), dict) else {}
    payload["details"] = details
    payload["details_json"] = details
    payload.setdefault("status", "")
    payload.setdefault("message", "")
    payload.setdefault("actor", "")
    payload.setdefault("kind", "")
    return payload


def _is_screenshot_url(value: Any) -> bool:
    text = str(value or "").strip()
    if not text:
        return False
    if text.startswith("data:image/"):
        return True
    if not text.startswith(("http://", "https://")):
        return False
    try:
        parsed = urlparse(text)
    except Exception:
        return False
    path = (parsed.path or "").lower()
    query = (parsed.query or "").lower()
    if any(path.endswith(ext) for ext in _SCREENSHOT_EXTENSIONS):
        return True
    if "/image/" in path or "/images/" in path or "image/upload" in path:
        return True
    return any(
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
    )


def _collect_screenshot_urls(value: Any, out: list[str] | None = None) -> list[str]:
    if out is None:
        out = []
    if value is None:
        return out

    if isinstance(value, str):
        text = value.strip()
        if text:
            if _is_screenshot_url(text):
                if text not in out:
                    out.append(text)
                return out
            for parsed in _json_string_candidates(text):
                _collect_screenshot_urls(parsed, out)
            for match in _EMBEDDED_SCREENSHOT_RE.finditer(text):
                candidate = str(match.group(1) or "").strip()
                if _is_screenshot_url(candidate) and candidate not in out:
                    out.append(candidate)
        return out

    if isinstance(value, (list, tuple, set)):
        for item in value:
            _collect_screenshot_urls(item, out)
        return out

    if isinstance(value, dict):
        _collect_screenshot_urls_from_object(value, out)
    return out


def _json_string_candidates(value: str) -> list[Any]:
    candidates: list[Any] = []
    text = str(value or "").strip()
    if not text:
        return candidates
    try:
        import json

        candidates.append(json.loads(text))
    except Exception:
        pass
    try:
        import json

        unescaped = text.replace('\\"', '"').replace("\\\\", "\\")
        if unescaped != text:
            candidates.append(json.loads(unescaped))
    except Exception:
        pass
    return candidates


def _collect_screenshot_urls_from_object(value: dict[str, Any], out: list[str]) -> None:
    item_type = str(value.get("type") or "").strip().lower()
    if item_type == "image":
        data = str(value.get("data") or "").strip()
        if data:
            mime = str(value.get("mimeType") or value.get("mime_type") or "image/png").strip() or "image/png"
            candidate = f"data:{mime};base64,{data}"
            if _is_screenshot_url(candidate) and candidate not in out:
                out.append(candidate)

    for key in _SCREENSHOT_SINGLE_KEYS:
        candidate = value.get(key)
        if _is_screenshot_url(candidate):
            text = str(candidate).strip()
            if text not in out:
                out.append(text)

    for key in _SCREENSHOT_MULTI_KEYS:
        urls = value.get(key)
        if isinstance(urls, (list, tuple, set)):
            for candidate in urls:
                if _is_screenshot_url(candidate):
                    text = str(candidate).strip()
                    if text not in out:
                        out.append(text)

    for key in _SCREENSHOT_WRAPPER_KEYS:
        if key in value:
            _collect_screenshot_urls(value.get(key), out)


def _trace_screenshot_urls(trace: RunTrace | None) -> list[str]:
    if trace is None:
        return []
    urls: list[str] = []
    for event in trace.events:
        _collect_screenshot_urls(event.details or {}, urls)
        _collect_screenshot_urls(event.message or "", urls)
    return urls


def _event_tool_target(details: dict[str, Any], started: dict[str, Any] | None, fallback: str) -> str:
    args = details.get("tool_args") or details.get("args") or (started or {}).get("args") or {}
    if isinstance(args, dict):
        for key in ("url", "mainUrl", "target_url", "player_iframe_url", "iframe_url", "base_url", "href"):
            value = args.get(key)
            if value:
                return str(value)
    for key in ("target_url", "source_url", "url", "mainUrl", "player_iframe_url", "base_url"):
        value = details.get(key)
        if value:
            return str(value)
    return fallback


def _collect_attributed_screenshots(
    trace: RunTrace | None,
    agent_runs: list[dict[str, Any]],
    *,
    default_source_url: str,
) -> list[dict[str, Any]]:
    if trace is None:
        return []

    seq_to_agent: dict[int, dict[str, Any]] = {}
    for agent_run in agent_runs:
        for event in agent_run.get("events", []):
            seq_to_agent[int(event.seq or 0)] = agent_run

    pending_by_id: dict[str, dict[str, Any]] = {}
    pending_by_actor: dict[str, list[dict[str, Any]]] = {}
    rows: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int, str]] = set()

    for event in trace.events:
        details = event.details or {}
        actor = str(event.actor or "")
        stack = pending_by_actor.setdefault(actor, [])
        if event.kind == "tool_call_started":
            tool_call_id = str(details.get("tool_call_id", "") or "")
            started = {
                "tool_call_id": tool_call_id,
                "tool_name": str(details.get("tool_name", "") or ""),
                "args": details.get("tool_args", {}) or {},
            }
            stack.append(started)
            if tool_call_id:
                pending_by_id[tool_call_id] = started
            continue

        started = None
        if event.kind == "tool_call_finished":
            tool_call_id = str(details.get("tool_call_id", "") or "")
            if tool_call_id:
                started = pending_by_id.pop(tool_call_id, None)
            if started is None and stack:
                started = stack.pop()
            elif started is not None:
                for index in range(len(stack) - 1, -1, -1):
                    if stack[index].get("tool_call_id") == started.get("tool_call_id"):
                        stack.pop(index)
                        break

        screenshots = _collect_screenshot_urls(details, [])
        _collect_screenshot_urls(event.message or "", screenshots)
        if not screenshots:
            continue

        agent_run = seq_to_agent.get(int(event.seq or 0), {})
        tool_name = str(details.get("tool_name", "") or (started or {}).get("tool_name", "") or "")
        target_url = _event_tool_target(
            details,
            started,
            str(agent_run.get("target_url") or default_source_url or ""),
        )
        for screenshot in screenshots:
            if not _is_screenshot_url(screenshot):
                continue
            dedupe_key = (str(screenshot), actor, int(event.seq or 0), tool_name)
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)
            rows.append(
                {
                    "agent_run_id": agent_run.get("id"),
                    "actor": actor,
                    "agent_type": str(agent_run.get("agent_type", "") or ""),
                    "invocation_index": int(agent_run.get("invocation_index", 0) or 0),
                    "tool_name": tool_name,
                    "target_url": target_url,
                    "source_url": target_url or default_source_url,
                    "label": str(event.kind or ""),
                    "seq": int(event.seq or 0),
                    "screenshot_url": str(screenshot),
                }
            )
    return rows

_PROMPT_PATHS = {
    AgentType.CLASSIFICATION.value: Path("configs/prompts/classification_v1.md"),
    AgentType.LANDING_PAGE.value: Path("configs/prompts/landing_page_v1.md"),
    AgentType.HOSTING_PAGE.value: Path("configs/prompts/hosting_page_v1.md"),
    AgentType.EMBEDDED_PAGE.value: Path("configs/prompts/embedded_page_v1.md"),
}

_ACTOR_TO_AGENT_TYPE = {
    "classification": AgentType.CLASSIFICATION.value,
    "landing": AgentType.LANDING_PAGE.value,
    "hosting": AgentType.HOSTING_PAGE.value,
    "embedded": AgentType.EMBEDDED_PAGE.value,
    "orchestrator": AgentType.ORCHESTRATOR.value,
}


def _result_primary_page_type(result: PipelineResult) -> str:
    if result.classification is not None:
        return result.classification.page_type.value
    if result.extraction_results:
        return result.extraction_results[0].page_type.value
    return "unknown"


class RunRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def _begin_own_transaction(self):
        """Start an EXPLICIT top-level transaction owned by the calling method.

        Durability contract ([DM-C1]): write methods commit their own work and
        never depend on a caller's later ``commit()``/``heartbeat()``. The
        previous ``begin_nested() if in_transaction()`` heuristic only released
        SAVEPOINTs whenever any prior SELECT had autobegun a transaction, so
        callers that closed their session without committing (e.g. the backfill
        script) silently lost every row while reporting success.

        Any ambient transaction is committed first so the per-call block below
        is one atomic, self-committed unit; ambient state at every current call
        site is read-only autobegin residue.
        """
        if self._session.in_transaction():
            self._session.commit()
        return self._session.begin()

    def save(self, result: PipelineResult, trace: RunTrace | None = None) -> RunRecord:
        with self._begin_own_transaction():
            record = self._upsert_legacy_run(result)
            pipeline = self._upsert_pipeline_run(result)
            self._session.flush()
            self._upsert_run_snapshot(pipeline, result)
            self._replace_normalized_children(pipeline.id)
            agent_runs = self._persist_agent_runs(pipeline.id, result, trace)
            self._persist_runtime_events(pipeline.id, trace, agent_runs)
            self._persist_run_model_usage(pipeline.id, result)
            self._persist_run_streams(pipeline.id, result)
            self._persist_run_screenshots(pipeline.id, result, trace=trace, agent_runs=agent_runs)
            self._persist_provider_analyses(pipeline.id, result)
            self._persist_takedown_emails(pipeline.id, result)
            self._persist_memory_entries(result.run_id, pipeline.id, agent_runs, result, trace)
            self._persist_memory_hints_used(result.run_id, agent_runs)
        self._session.refresh(record)
        return record

    def save_trace_snapshot(
        self,
        *,
        run_id: str,
        root_actor: str,
        url: str,
        trace: RunTrace,
    ) -> None:
        # Durability invariant ([DM-C4]): snapshot commits HERE, never via heartbeat.
        with self._begin_own_transaction():
            legacy = self.get_by_run_id(run_id)
            if legacy is None:
                legacy = RunRecord(run_id=run_id)
                legacy.url = url
                self._session.add(legacy)
            snapshot = self._session.query(RunSnapshotRecord).filter_by(run_id=run_id).first()
            snapshot_json = (
                snapshot.snapshot_json
                if snapshot is not None and isinstance(snapshot.snapshot_json, dict)
                else {}
            )
            screenshot_urls = _collect_screenshot_urls(snapshot_json.get("all_screenshots", []))
            _collect_screenshot_urls(_trace_screenshot_urls(trace), screenshot_urls)
            legacy.url = url
            legacy.page_type = str(
                snapshot_json.get("page_type")
                or snapshot_json.get("classification", {}).get("page_type")
                or legacy.page_type
                or "unknown"
            )
            failure_mode = str((trace.metrics.failure_mode if trace.metrics else "") or "").lower()
            if not trace.completed:
                legacy.status = "running"
            elif trace.cancel_requested or failure_mode in {"runcancellederror", "cancelled", "canceled"}:
                legacy.status = "cancelled"
            elif failure_mode in RUN_TERMINAL_STATUSES:
                legacy.status = failure_mode
            elif trace.metrics and trace.metrics.success:
                legacy.status = "success"
            else:
                legacy.status = "failed"
            legacy.success = bool(trace.metrics.success) if (trace.metrics and trace.completed) else False
            legacy.streams_found = max(
                int(legacy.streams_found or 0),
                int(len(snapshot_json.get("all_streams", []) or [])),
            )
            metrics = trace.metrics
            if metrics is not None:
                legacy.tokens_in = int(metrics.total_tokens_in or 0)
                legacy.tokens_out = int(metrics.total_tokens_out or 0)
                legacy.tool_calls = int(metrics.total_tool_calls or 0)
                legacy.duration_seconds = float(metrics.total_duration_seconds or 0.0)
                legacy.failure_mode = metrics.failure_mode or ""
            legacy.result_json = {
                "run_id": run_id,
                "url": url,
                "status": legacy.status,
                "metrics": metrics.model_dump(mode="json") if metrics else {},
            }

            pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
            if pipeline is None:
                pipeline = PipelineRunRecord(run_id=run_id)
                pipeline.root_url = url
                self._session.add(pipeline)
                self._session.flush()
            pipeline.root_url = url
            pipeline.page_type = str(
                snapshot_json.get("page_type")
                or snapshot_json.get("classification", {}).get("page_type")
                or pipeline.page_type
                or "unknown"
            )
            pipeline.top_level_page_type = str(
                snapshot_json.get("page_type")
                or snapshot_json.get("classification", {}).get("page_type")
                or pipeline.top_level_page_type
                or "unknown"
            )
            pipeline.final_status = legacy.status
            pipeline.success = legacy.success
            pipeline.failure_mode = legacy.failure_mode
            pipeline.stream_count = max(
                int(pipeline.stream_count or 0),
                int(len(snapshot_json.get("all_streams", []) or [])),
            )
            pipeline.screenshot_count = max(
                int(pipeline.screenshot_count or 0),
                int(len(screenshot_urls)),
            )
            pipeline.email_count = max(
                int(pipeline.email_count or 0),
                int(len(snapshot_json.get("takedown_emails", []) or [])),
            )
            pipeline.provider_analysis_count = max(
                int(pipeline.provider_analysis_count or 0),
                int(len(snapshot_json.get("provider_analysis", []) or [])),
            )
            pipeline.started_at = trace.started_at
            pipeline.finished_at = trace.finished_at
            if metrics is not None:
                pipeline.total_tokens_in = int(metrics.total_tokens_in or 0)
                pipeline.total_cached_input_tokens = int(metrics.total_cached_input_tokens or 0)
                pipeline.total_new_input_tokens = int(metrics.total_new_input_tokens or 0)
                pipeline.total_tokens_out = int(metrics.total_tokens_out or 0)
                pipeline.total_tool_calls = int(metrics.total_tool_calls or 0)
                pipeline.total_llm_calls = int(metrics.total_llm_calls or 0)
                pipeline.total_cache_hit_calls = int(metrics.total_cache_hit_calls or 0)
                pipeline.total_messages = int(metrics.total_messages or 0)
                pipeline.duration_seconds = float(metrics.total_duration_seconds or 0.0)
                pipeline.estimated_input_cost_usd = float(metrics.estimated_input_cost_usd or 0.0)
                pipeline.estimated_cached_input_cost_usd = float(
                    metrics.estimated_cached_input_cost_usd or 0.0
                )
                pipeline.estimated_cache_write_cost_usd = float(
                    metrics.estimated_cache_write_cost_usd or 0.0
                )
                pipeline.estimated_output_cost_usd = float(metrics.estimated_output_cost_usd or 0.0)
                pipeline.estimated_total_cost_usd = float(metrics.estimated_total_cost_usd or 0.0)

            if snapshot is None:
                snapshot = RunSnapshotRecord(run_id=run_id, pipeline_run_id=pipeline.id)
                self._session.add(snapshot)
                self._session.flush()
            snapshot.pipeline_run_id = pipeline.id
            snapshot.snapshot_json = stamp_schema_version(
                {
                    **snapshot_json,
                    "run_id": run_id,
                    "url": url,
                    "status": legacy.status,
                    "metrics": metrics.model_dump(mode="json") if metrics else {},
                    "events": [event.model_dump(mode="json") for event in trace.events],
                    "all_screenshots": screenshot_urls,
                }
            )
            self._replace_trace_children(pipeline.id)
            agent_runs = self._persist_trace_agent_runs(
                pipeline.id,
                trace,
                url=url,
                root_actor=root_actor,
            )
            self._persist_trace_runtime_events(pipeline.id, trace, agent_runs)
            self._persist_trace_model_usage(pipeline.id, trace)
            self._persist_trace_screenshots(
                pipeline.id,
                screenshot_urls,
                source_url=url,
                trace=trace,
                agent_runs=agent_runs,
            )

    def cleanup_old_artifacts(
        self,
        *,
        retention_days: int = 30,
        days_by_table: dict[str, int] | None = None,
    ) -> dict[str, int]:
        """Delete artifacts older than their retention window (plan task 32).

        Covers runtime_events, run_screenshots, run_snapshots, llm_calls,
        tool_calls, agent_outputs and legacy runs. Per-table windows can be
        overridden via ``days_by_table`` keyed by short table name
        (e.g. ``{"llm_calls": 10}``); everything else uses ``retention_days``.
        """
        overrides = {
            str(key): max(1, int(value)) for key, value in (days_by_table or {}).items()
        }

        def _threshold(name: str) -> datetime:
            days = overrides.get(name, max(1, int(retention_days)))
            return datetime.now(UTC) - timedelta(days=days)

        def _old_pipeline_ids(name: str) -> list[int]:
            return [
                int(row.id)
                for row in self._session.query(PipelineRunRecord.id)
                .filter(PipelineRunRecord.finished_at.is_not(None))
                .filter(PipelineRunRecord.finished_at < _threshold(name))
                .all()
            ]

        def _old_agent_run_ids(name: str) -> list[int]:
            pipeline_ids = _old_pipeline_ids(name)
            if not pipeline_ids:
                return []
            return [
                int(row.id)
                for row in self._session.query(AgentRunRecord.id)
                .filter(AgentRunRecord.pipeline_run_id.in_(pipeline_ids))
                .all()
            ]

        deleted = {
            "runtime_events_deleted": 0,
            "run_screenshots_deleted": 0,
            "run_snapshots_deleted": 0,
            "llm_calls_deleted": 0,
            "tool_calls_deleted": 0,
            "agent_outputs_deleted": 0,
            "runs_deleted": 0,
        }
        with self._begin_own_transaction():
            deleted["runtime_events_deleted"] = int(
                self._session.query(RuntimeEventRecord)
                .filter(RuntimeEventRecord.pipeline_run_id.in_(_old_pipeline_ids("runtime_events")))
                .delete(synchronize_session=False)
                or 0
            )
            deleted["run_screenshots_deleted"] = int(
                self._session.query(RunScreenshotRecord)
                .filter(RunScreenshotRecord.pipeline_run_id.in_(_old_pipeline_ids("run_screenshots")))
                .delete(synchronize_session=False)
                or 0
            )
            deleted["run_snapshots_deleted"] = int(
                self._session.query(RunSnapshotRecord)
                .filter(RunSnapshotRecord.pipeline_run_id.in_(_old_pipeline_ids("run_snapshots")))
                .delete(synchronize_session=False)
                or 0
            )
            deleted["llm_calls_deleted"] = int(
                self._session.query(LLMCallRecord)
                .filter(LLMCallRecord.agent_run_id.in_(_old_agent_run_ids("llm_calls")))
                .delete(synchronize_session=False)
                or 0
            )
            deleted["tool_calls_deleted"] = int(
                self._session.query(ToolCallRecord)
                .filter(ToolCallRecord.agent_run_id.in_(_old_agent_run_ids("tool_calls")))
                .delete(synchronize_session=False)
                or 0
            )
            deleted["agent_outputs_deleted"] = int(
                self._session.query(AgentOutputRecord)
                .filter(AgentOutputRecord.agent_run_id.in_(_old_agent_run_ids("agent_outputs")))
                .delete(synchronize_session=False)
                or 0
            )
            # Legacy runs table: window keyed on its own created_at column so
            # rows are purged even when no matching pipeline_runs row exists.
            deleted["runs_deleted"] = int(
                self._session.query(RunRecord)
                .filter(RunRecord.created_at < _threshold("runs"))
                .delete(synchronize_session=False)
                or 0
            )
            # Plan task 32: garbage-collect blob files whose only DB references
            # were just purged. Blobrefs live in MULTIPLE places — the
            # run_screenshots column plus JSON metadata columns on snapshots,
            # events, llm rows, tool rows and agent outputs (nested
            # result_full/content_full caps) — so scan them ALL before
            # deleting any file; content-addressing dedupes, so a file shared
            # with still-live rows must survive.
            try:
                from src.storage.blob_store import BLOB_REF_PREFIX, blob_dir

                _BLOB_REF_SQL = [
                    "SELECT screenshot_url AS ref FROM run_screenshots WHERE screenshot_url LIKE 'blobref:%'",
                    "SELECT snapshot_json AS ref FROM run_snapshots",
                    "SELECT details_json AS ref FROM runtime_events",
                    "SELECT usage_metadata_json AS ref FROM llm_calls",
                    "SELECT response_metadata_json AS ref FROM llm_calls",
                    "SELECT details_json AS ref FROM tool_calls",
                    "SELECT output_json AS ref FROM agent_outputs",
                ]
                live_keys: set[str] = set()

                def _collect_refs(node: object) -> None:
                    if isinstance(node, str):
                        idx = 0
                        while True:
                            idx = node.find(BLOB_REF_PREFIX, idx)
                            if idx < 0:
                                break
                            start = idx + len(BLOB_REF_PREFIX)
                            chunk = "".join(
                                ch for ch in node[start : start + 16] if ch.isalnum()
                            )
                            if chunk:
                                live_keys.add(chunk[:16])
                            idx = start
                    elif isinstance(node, dict):
                        for value in node.values():
                            _collect_refs(value)
                    elif isinstance(node, (list, tuple)):
                        for value in node:
                            _collect_refs(value)

                for statement in _BLOB_REF_SQL:
                    try:
                        for row in self._session.execute(text(statement)):
                            for cell in row:
                                _collect_refs(cell)
                    except Exception:  # noqa: BLE001 - table may not exist yet
                        continue
                directory = blob_dir()
                if directory.exists():
                    removed = 0
                    for path in directory.glob("*.blob"):
                        if path.stem not in live_keys:
                            path.unlink(missing_ok=True)
                            removed += 1
                    deleted["blob_files_deleted"] = removed
            except Exception:  # noqa: BLE001 - GC must never break retention
                logger.debug("Skipping blob garbage collection", exc_info=True)
        return deleted

    def hard_delete_run(self, run_id: str) -> dict[str, int]:
        deleted = {
            "pipeline_runs_deleted": 0,
            "run_snapshots_deleted": 0,
            "agent_runs_deleted": 0,
            "runtime_events_deleted": 0,
            "run_model_usage_deleted": 0,
            "run_streams_deleted": 0,
            "run_screenshots_deleted": 0,
            "provider_analyses_deleted": 0,
            "takedown_emails_deleted": 0,
            "llm_calls_deleted": 0,
            "tool_calls_deleted": 0,
            "agent_outputs_deleted": 0,
            "prompt_compilations_deleted": 0,
            "memory_hints_deleted": 0,
            "legacy_runs_deleted": 0,
            "background_jobs_deleted": 0,
        }

        with self._begin_own_transaction():
            pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
            if pipeline is not None:
                agent_run_ids = [
                    int(value)
                    for (value,) in self._session.query(AgentRunRecord.id)
                    .filter(AgentRunRecord.pipeline_run_id == pipeline.id)
                    .all()
                ]
                if agent_run_ids:
                    deleted["memory_hints_deleted"] = int(
                        self._session.query(MemoryHintUsedRecord)
                        .filter(MemoryHintUsedRecord.agent_run_id.in_(agent_run_ids))
                        .delete(synchronize_session=False)
                        or 0
                    )
                    deleted["prompt_compilations_deleted"] = int(
                        self._session.query(PromptCompilationRecord)
                        .filter(PromptCompilationRecord.agent_run_id.in_(agent_run_ids))
                        .delete(synchronize_session=False)
                        or 0
                    )
                    deleted["llm_calls_deleted"] = int(
                        self._session.query(LLMCallRecord)
                        .filter(LLMCallRecord.agent_run_id.in_(agent_run_ids))
                        .delete(synchronize_session=False)
                        or 0
                    )
                    deleted["tool_calls_deleted"] = int(
                        self._session.query(ToolCallRecord)
                        .filter(ToolCallRecord.agent_run_id.in_(agent_run_ids))
                        .delete(synchronize_session=False)
                        or 0
                    )
                    deleted["agent_outputs_deleted"] = int(
                        self._session.query(AgentOutputRecord)
                        .filter(AgentOutputRecord.agent_run_id.in_(agent_run_ids))
                        .delete(synchronize_session=False)
                        or 0
                    )
                deleted["runtime_events_deleted"] = int(
                    self._session.query(RuntimeEventRecord)
                    .filter_by(pipeline_run_id=pipeline.id)
                    .delete(synchronize_session=False)
                    or 0
                )
                deleted["run_model_usage_deleted"] = int(
                    self._session.query(RunModelUsageRecord)
                    .filter_by(pipeline_run_id=pipeline.id)
                    .delete(synchronize_session=False)
                    or 0
                )
                deleted["run_streams_deleted"] = int(
                    self._session.query(RunStreamRecord)
                    .filter_by(pipeline_run_id=pipeline.id)
                    .delete(synchronize_session=False)
                    or 0
                )
                deleted["run_screenshots_deleted"] = int(
                    self._session.query(RunScreenshotRecord)
                    .filter_by(pipeline_run_id=pipeline.id)
                    .delete(synchronize_session=False)
                    or 0
                )
                deleted["provider_analyses_deleted"] = int(
                    self._session.query(ProviderAnalysisRecord)
                    .filter_by(pipeline_run_id=pipeline.id)
                    .delete(synchronize_session=False)
                    or 0
                )
                deleted["takedown_emails_deleted"] = int(
                    self._session.query(TakedownEmailRecord)
                    .filter_by(pipeline_run_id=pipeline.id)
                    .delete(synchronize_session=False)
                    or 0
                )
                deleted["agent_runs_deleted"] = int(
                    self._session.query(AgentRunRecord)
                    .filter_by(pipeline_run_id=pipeline.id)
                    .delete(synchronize_session=False)
                    or 0
                )
                deleted["run_snapshots_deleted"] = int(
                    self._session.query(RunSnapshotRecord)
                    .filter_by(pipeline_run_id=pipeline.id)
                    .delete(synchronize_session=False)
                    or 0
                )
                deleted["pipeline_runs_deleted"] = int(
                    self._session.query(PipelineRunRecord)
                    .filter_by(id=pipeline.id)
                    .delete(synchronize_session=False)
                    or 0
                )
            else:
                deleted["run_snapshots_deleted"] = int(
                    self._session.query(RunSnapshotRecord)
                    .filter_by(run_id=run_id)
                    .delete(synchronize_session=False)
                    or 0
                )

            deleted["legacy_runs_deleted"] = int(
                self._session.query(RunRecord)
                .filter_by(run_id=run_id)
                .delete(synchronize_session=False)
                or 0
            )
            deleted["background_jobs_deleted"] = int(
                self._session.query(BackgroundJobRecord)
                .filter_by(run_id=run_id)
                .delete(synchronize_session=False)
                or 0
            )

        self._session.commit()
        return deleted

    def get_by_run_id(self, run_id: str) -> RunRecord | None:
        return self._session.query(RunRecord).filter_by(run_id=run_id).first()

    def list_recent(self, limit: int = 50) -> list[RunRecord]:
        return (
            self._session.query(RunRecord)
            .order_by(RunRecord.created_at.desc())
            .limit(limit)
            .all()
        )

    def success_rate(self) -> float:
        total = self._session.query(PipelineRunRecord).count()
        if total:
            successes = self._session.query(PipelineRunRecord).filter_by(success=True).count()
            return successes / total
        total = self._session.query(RunRecord).count()
        if total == 0:
            return 0.0
        successes = self._session.query(RunRecord).filter_by(success=True).count()
        return successes / total

    def cost_stats(self, agent_set: list[str] | None = None) -> dict[str, Any]:
        """Return p50/p75 cost statistics from historical run_model_usage rows.

        ``agent_set`` is reserved for future per-agent filtering; it is not yet
        wired because agent-level cost breakdowns live in agent_runs, not in
        run_model_usage.  Callers may pass it for forward-compatibility.
        """
        rows = self._session.query(
            RunModelUsageRecord.estimated_total_cost_usd
        ).filter(
            RunModelUsageRecord.estimated_total_cost_usd > 0
        ).all()

        costs = sorted(float(r[0]) for r in rows)
        count = len(costs)
        if count == 0:
            return {"count": 0, "p50_usd": None, "p75_usd": None, "min_usd": None, "max_usd": None}

        def _percentile(data: list[float], pct: float) -> float:
            idx = (len(data) - 1) * pct / 100.0
            lo = int(idx)
            hi = min(lo + 1, len(data) - 1)
            frac = idx - lo
            return round(data[lo] + frac * (data[hi] - data[lo]), 6)

        return {
            "count": count,
            "p50_usd": _percentile(costs, 50),
            "p75_usd": _percentile(costs, 75),
            "min_usd": round(costs[0], 6),
            "max_usd": round(costs[-1], 6),
        }

    def get_run_snapshot(self, run_id: str) -> dict[str, Any] | None:
        snapshot = self._session.query(RunSnapshotRecord).filter_by(run_id=run_id).first()
        if snapshot is not None:
            return snapshot.snapshot_json or {}
        record = self.get_by_run_id(run_id)
        return record.result_json if record is not None else None

    def get_run_emails(self, run_id: str) -> dict[str, Any] | None:
        snapshot = self.get_run_snapshot(run_id)
        if snapshot is None:
            return None
        return {
            "run_id": run_id,
            "url": snapshot.get("url", ""),
            "emails": snapshot.get("takedown_emails", []),
        }

    def get_observability_summary(self, limit: int = 10) -> dict[str, Any]:
        recent = (
            self._session.query(PipelineRunRecord)
            .order_by(PipelineRunRecord.created_at.desc())
            .limit(limit)
            .all()
        )
        return {
            "success_rate": self.success_rate(),
            "run_count": len(recent),
            "recent_runs": [
                {
                    "run_id": run.run_id,
                    "url": run.root_url,
                    "status": run.final_status,
                    "success": run.success,
                    "streams_found": run.stream_count,
                    "tool_calls": run.total_tool_calls,
                    "tokens_in": run.total_tokens_in,
                    "tokens_out": run.total_tokens_out,
                    "estimated_total_cost_usd": run.estimated_total_cost_usd,
                    "llm_calls": run.total_llm_calls,
                    "message_count": run.total_messages,
                    "duration_seconds": run.duration_seconds,
                    "created_at": iso_z(run.created_at),
                }
                for run in recent
            ],
        }

    def list_agent_runs(self, run_id: str) -> list[dict[str, Any]]:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return []
        rows = (
            self._session.query(AgentRunRecord)
            .filter_by(pipeline_run_id=pipeline.id)
            .order_by(AgentRunRecord.started_at.asc(), AgentRunRecord.id.asc())
            .all()
        )
        return [
            {
                "id": row.id,
                "actor": row.actor,
                "agent_type": row.agent_type,
                "target_url": row.target_url,
                "page_type": row.page_type,
                "status": row.status,
                "tool_call_budget": row.tool_call_budget,
                "tool_calls_made": row.tool_calls_made,
                "llm_calls_made": row.llm_calls_made,
                "memory_injected": row.memory_injected,
                "started_at": iso_z(row.started_at),
                "finished_at": iso_z(row.finished_at) or None,
                "duration_seconds": row.duration_seconds,
            }
            for row in rows
        ]

    def list_llm_calls(self, run_id: str) -> list[dict[str, Any]]:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return []
        rows = (
            self._session.query(LLMCallRecord)
            .join(AgentRunRecord, AgentRunRecord.id == LLMCallRecord.agent_run_id)
            .filter(AgentRunRecord.pipeline_run_id == pipeline.id)
            .order_by(AgentRunRecord.started_at.asc(), LLMCallRecord.seq.asc())
            .all()
        )
        return [
            {
                "agent_run_id": row.agent_run_id,
                "seq": row.seq,
                "provider": row.provider,
                "model_name": row.model_name,
                "prompt_version": row.prompt_version,
                "prompt_hash": row.prompt_hash,
                "cache_mode": row.cache_mode,
                "input_tokens": row.input_tokens,
                "cached_input_tokens": row.cached_input_tokens,
                "new_input_tokens": row.new_input_tokens,
                "cache_creation_input_tokens": row.cache_creation_input_tokens,
                "output_tokens": row.output_tokens,
                "context_window": row.context_window,
                "estimated_input_cost_usd": row.estimated_input_cost_usd,
                "estimated_cached_input_cost_usd": row.estimated_cached_input_cost_usd,
                "estimated_cache_write_cost_usd": row.estimated_cache_write_cost_usd,
                "estimated_output_cost_usd": row.estimated_output_cost_usd,
                "estimated_total_cost_usd": row.estimated_total_cost_usd,
                "total_cost_usd": row.estimated_total_cost_usd,
                "cost_source": (row.usage_metadata_json or {}).get("cost_source", ""),
                "tool_calls_requested": row.tool_calls_requested,
                "tools_requested": row.tools_requested,
                "content_preview": row.content_preview,
                "created_at": iso_z(row.created_at),
            }
            for row in rows
        ]

    def list_tool_calls(self, run_id: str) -> list[dict[str, Any]]:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return []
        rows = (
            self._session.query(ToolCallRecord)
            .join(AgentRunRecord, AgentRunRecord.id == ToolCallRecord.agent_run_id)
            .filter(AgentRunRecord.pipeline_run_id == pipeline.id)
            .order_by(AgentRunRecord.started_at.asc(), ToolCallRecord.seq.asc())
            .all()
        )
        return [
            {
                "agent_run_id": row.agent_run_id,
                "seq": row.seq,
                "tool_name": row.tool_name,
                "target_summary": row.target_summary,
                "status": row.status,
                "duration_seconds": row.duration_seconds,
                "result_preview": row.result_preview,
                "error_text": row.error_text,
                "created_at": iso_z(row.started_at),
            }
            for row in rows
        ]

    def list_runtime_events(self, run_id: str) -> list[dict[str, Any]]:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return []
        rows = (
            self._session.query(RuntimeEventRecord)
            .filter_by(pipeline_run_id=pipeline.id)
            .order_by(RuntimeEventRecord.seq.asc())
            .all()
        )
        return [serialize_runtime_event_record(row) for row in rows]

    def list_memory_entries(
        self,
        *,
        domain: str | None = None,
        page_type: str | None = None,
        limit: int = 50,
    ) -> list[dict[str, Any]]:
        query = self._session.query(MemoryEntryRecord)
        if domain:
            query = query.filter(MemoryEntryRecord.domain == domain)
        if page_type:
            query = query.filter(MemoryEntryRecord.page_type == page_type)
        rows = query.order_by(MemoryEntryRecord.created_at.desc()).limit(limit).all()
        return [
            {
                "id": row.id,
                "domain": row.domain,
                "page_type": row.page_type,
                "source_run_id": row.source_run_id,
                "source_agent_run_id": row.source_agent_run_id,
                "status": row.status,
                "success": row.success,
                "url": row.url,
                "data": row.data_json,
                "result_summary": row.result_summary,
                "created_at": iso_z(row.created_at),
            }
            for row in rows
        ]

    def list_prompt_compilations(self, run_id: str) -> list[dict[str, Any]]:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=run_id).first()
        if pipeline is None:
            return []
        rows = (
            self._session.query(PromptCompilationRecord, PromptVersionRecord)
            .join(AgentRunRecord, AgentRunRecord.id == PromptCompilationRecord.agent_run_id)
            .outerjoin(PromptVersionRecord, PromptVersionRecord.id == PromptCompilationRecord.prompt_version_id)
            .filter(AgentRunRecord.pipeline_run_id == pipeline.id)
            .order_by(PromptCompilationRecord.created_at.asc())
            .all()
        )
        return [
            {
                "agent_run_id": compilation.agent_run_id,
                "agent_id": prompt_version.agent_id if prompt_version else "",
                "source_path": prompt_version.source_path if prompt_version else "",
                "prompt_version": prompt_version.semantic_version if prompt_version else "",
                "prompt_hash": prompt_version.content_hash if prompt_version else "",
                "cache_mode": compilation.cache_mode,
                "compiled_prompt_hash": compilation.compiled_prompt_hash,
                "provider_cache_key": compilation.provider_cache_key,
                "provider_cache_eligible": compilation.provider_cache_eligible,
                "memory_injected": compilation.memory_injected,
                "sections": compilation.sections_json,
                "metadata": compilation.metadata_json,
            }
            for compilation, prompt_version in rows
        ]

    def backfill_normalized_from_legacy(
        self,
        limit: int | None = None,
        *,
        progress_every: int = 25,
    ) -> int:
        query = (
            self._session.query(RunRecord)
            .outerjoin(PipelineRunRecord, PipelineRunRecord.run_id == RunRecord.run_id)
            .filter(PipelineRunRecord.id.is_(None))
            .order_by(RunRecord.created_at.asc())
        )
        if limit:
            query = query.limit(limit)
        count = 0
        for record in query.all():
            payload = record.result_json or {}
            if not payload:
                continue
            try:
                result = PipelineResult.model_validate(payload)
            except Exception:
                continue
            self.save(result, trace=None)
            # Durability invariant ([DM-C1]): reported count must be durable.
            self._session.commit()
            count += 1
            if progress_every > 0 and count % progress_every == 0:
                logger.info("Backfill progress: %d run(s) normalized", count)
        return count

    def _upsert_legacy_run(self, result: PipelineResult) -> RunRecord:
        record = self.get_by_run_id(result.run_id)
        if record is None:
            record = RunRecord(run_id=result.run_id)
            self._session.add(record)
        record.url = result.url
        record.page_type = _result_primary_page_type(result)
        record.status = result.final_status.value
        record.streams_found = len(result.all_streams)
        record.success = result.final_status in {ExtractionStatus.SUCCESS, ExtractionStatus.PARTIAL}
        record.result_json = result.model_dump(mode="json")
        if result.metrics:
            record.tokens_in = result.metrics.total_tokens_in
            record.tokens_out = result.metrics.total_tokens_out
            record.tool_calls = result.metrics.total_tool_calls
            record.duration_seconds = result.metrics.total_duration_seconds
            record.failure_mode = result.metrics.failure_mode
        return record

    def _upsert_pipeline_run(self, result: PipelineResult) -> PipelineRunRecord:
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=result.run_id).first()
        if pipeline is None:
            pipeline = PipelineRunRecord(run_id=result.run_id)
            self._session.add(pipeline)
        metrics = result.metrics
        page_type = _result_primary_page_type(result)
        pipeline.root_url = result.url
        pipeline.page_type = page_type
        pipeline.final_status = result.final_status.value
        pipeline.success = result.final_status in {ExtractionStatus.SUCCESS, ExtractionStatus.PARTIAL}
        pipeline.failure_mode = metrics.failure_mode if metrics else ""
        pipeline.stream_count = len(result.all_streams)
        pipeline.screenshot_count = len(result.all_screenshots)
        pipeline.email_count = len(result.takedown_emails)
        pipeline.provider_analysis_count = len(result.provider_analysis)
        pipeline.top_level_page_type = page_type
        pipeline.classification_confidence = result.classification.confidence.value if result.classification else ""
        pipeline.classification_reasoning = result.classification.reasoning if result.classification else ""
        pipeline.started_at = metrics.started_at if metrics else pipeline.started_at
        pipeline.finished_at = metrics.finished_at if metrics else pipeline.finished_at
        pipeline.duration_seconds = metrics.total_duration_seconds if metrics else 0.0
        pipeline.total_tokens_in = metrics.total_tokens_in if metrics else 0
        pipeline.total_cached_input_tokens = metrics.total_cached_input_tokens if metrics else 0
        pipeline.total_new_input_tokens = metrics.total_new_input_tokens if metrics else 0
        pipeline.total_tokens_out = metrics.total_tokens_out if metrics else 0
        pipeline.total_llm_calls = metrics.total_llm_calls if metrics else 0
        pipeline.total_cache_hit_calls = metrics.total_cache_hit_calls if metrics else 0
        pipeline.total_tool_calls = metrics.total_tool_calls if metrics else 0
        pipeline.total_messages = metrics.total_messages if metrics else 0
        pipeline.estimated_input_cost_usd = metrics.estimated_input_cost_usd if metrics else 0.0
        pipeline.estimated_cached_input_cost_usd = metrics.estimated_cached_input_cost_usd if metrics else 0.0
        pipeline.estimated_cache_write_cost_usd = metrics.estimated_cache_write_cost_usd if metrics else 0.0
        pipeline.estimated_output_cost_usd = metrics.estimated_output_cost_usd if metrics else 0.0
        pipeline.estimated_total_cost_usd = metrics.estimated_total_cost_usd if metrics else 0.0
        return pipeline

    def _upsert_run_snapshot(self, pipeline: PipelineRunRecord, result: PipelineResult) -> None:
        snapshot = self._session.query(RunSnapshotRecord).filter_by(run_id=result.run_id).first()
        if snapshot is None:
            snapshot = RunSnapshotRecord(run_id=result.run_id, pipeline_run_id=pipeline.id)
            self._session.add(snapshot)
            self._session.flush()
        snapshot.pipeline_run_id = pipeline.id
        snapshot.snapshot_json = stamp_schema_version(result.model_dump(mode="json"))

    def _replace_normalized_children(self, pipeline_run_id: int) -> None:
        agent_run_ids = self._session.query(AgentRunRecord.id).filter(AgentRunRecord.pipeline_run_id == pipeline_run_id)
        self._session.query(MemoryHintUsedRecord).filter(MemoryHintUsedRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(PromptCompilationRecord).filter(PromptCompilationRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(LLMCallRecord).filter(LLMCallRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(ToolCallRecord).filter(ToolCallRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(AgentOutputRecord).filter(AgentOutputRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(RuntimeEventRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(RunModelUsageRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(RunStreamRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(RunScreenshotRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(ProviderAnalysisRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(TakedownEmailRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(AgentRunRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)

    def _replace_trace_children(self, pipeline_run_id: int) -> None:
        agent_run_ids = self._session.query(AgentRunRecord.id).filter(AgentRunRecord.pipeline_run_id == pipeline_run_id)
        self._session.query(MemoryHintUsedRecord).filter(MemoryHintUsedRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(PromptCompilationRecord).filter(PromptCompilationRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(LLMCallRecord).filter(LLMCallRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(ToolCallRecord).filter(ToolCallRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(AgentOutputRecord).filter(AgentOutputRecord.agent_run_id.in_(agent_run_ids)).delete(synchronize_session=False)
        self._session.query(RuntimeEventRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(RunModelUsageRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(RunScreenshotRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)
        self._session.query(AgentRunRecord).filter_by(pipeline_run_id=pipeline_run_id).delete(synchronize_session=False)

    def _persist_agent_runs(self, pipeline_run_id: int, result: PipelineResult, trace: RunTrace | None) -> list[dict[str, Any]]:
        contexts = _extract_agent_contexts(trace, result)
        rows: list[dict[str, Any]] = []
        for ctx in contexts:
            context_metrics = _agent_context_metrics(ctx)
            agent_run = AgentRunRecord(
                pipeline_run_id=pipeline_run_id,
                actor=ctx["actor"],
                agent_type=ctx["agent_type"],
                target_url=ctx["target_url"],
                page_type=ctx["page_type"],
                status=ctx["status"],
                tool_call_budget=ctx["tool_call_budget"],
                tool_calls_made=ctx["tool_calls_made"],
                llm_calls_made=ctx["llm_calls_made"],
                prompt_compiled=bool(ctx.get("prompt")),
                memory_injected=bool(ctx.get("memory_loaded")),
                provider=context_metrics["provider"],
                model_name=context_metrics["model_name"],
                input_tokens=context_metrics["input_tokens"],
                cached_input_tokens=context_metrics["cached_input_tokens"],
                new_input_tokens=context_metrics["new_input_tokens"],
                output_tokens=context_metrics["output_tokens"],
                context_window=context_metrics["context_window"],
                context_tokens=context_metrics["context_tokens"],
                context_usage_pct=context_metrics["context_usage_pct"],
                started_at=ctx["started_at"],
                finished_at=ctx["finished_at"],
                duration_seconds=ctx["duration_seconds"],
                invocation_index=ctx["invocation_index"],
            )
            self._session.add(agent_run)
            self._session.flush()

            output_payload = _cap_payload_fields(_agent_output_payload(ctx, result))
            self._session.add(
                AgentOutputRecord(
                    agent_run_id=agent_run.id,
                    output_json=output_payload,
                    summary_text=_agent_output_summary(ctx["agent_type"], output_payload),
                    stream_count=_stream_count_from_payload(output_payload),
                    embedded_url_count=len(output_payload.get("embedded_urls", []) or []),
                    hosting_page_count=len(output_payload.get("hosting_pages", []) or []),
                    validation_status="ok" if output_payload else "missing",
                )
            )

            prompt_details = ctx.get("prompt") or {}
            if prompt_details:
                prompt_version_id = self._ensure_prompt_version(ctx["agent_type"], prompt_details)
                self._session.add(
                    PromptCompilationRecord(
                        prompt_version_id=prompt_version_id,
                        agent_run_id=agent_run.id,
                        cache_mode=str(prompt_details.get("cache_mode", "") or ""),
                        compiled_prompt_hash=str(prompt_details.get("compiled_prompt_hash", "") or ""),
                        provider_cache_key=str(prompt_details.get("provider_cache_key", "") or ""),
                        provider_cache_eligible=bool(prompt_details.get("provider_cache_eligible", False)),
                        static_cache_hit=bool(prompt_details.get("static_cache_hit", False)),
                        memory_injected=bool(prompt_details.get("memory_injected", False)),
                        output_contract_version=str(prompt_details.get("output_contract_version", "") or ""),
                        sections_json=prompt_details.get("sections", []) or [],
                        metadata_json=stamp_schema_version(prompt_details),
                    )
                )

            self._persist_llm_calls(agent_run.id, ctx)
            self._persist_tool_calls(agent_run.id, ctx)
            rows.append({**ctx, "id": agent_run.id})
        return rows

    def _persist_trace_agent_runs(
        self,
        pipeline_run_id: int,
        trace: RunTrace,
        *,
        url: str,
        root_actor: str,
    ) -> list[dict[str, Any]]:
        contexts = _extract_trace_agent_contexts(trace, default_url=url, root_actor=root_actor)
        rows: list[dict[str, Any]] = []
        for ctx in contexts:
            context_metrics = _agent_context_metrics(ctx)
            agent_run = AgentRunRecord(
                pipeline_run_id=pipeline_run_id,
                actor=ctx["actor"],
                agent_type=ctx["agent_type"],
                target_url=ctx["target_url"],
                page_type=ctx["page_type"],
                status=ctx["status"],
                tool_call_budget=ctx["tool_call_budget"],
                tool_calls_made=ctx["tool_calls_made"],
                llm_calls_made=ctx["llm_calls_made"],
                prompt_compiled=bool(ctx.get("prompt")),
                memory_injected=bool(ctx.get("memory_loaded")),
                provider=context_metrics["provider"],
                model_name=context_metrics["model_name"],
                input_tokens=context_metrics["input_tokens"],
                cached_input_tokens=context_metrics["cached_input_tokens"],
                new_input_tokens=context_metrics["new_input_tokens"],
                output_tokens=context_metrics["output_tokens"],
                context_window=context_metrics["context_window"],
                context_tokens=context_metrics["context_tokens"],
                context_usage_pct=context_metrics["context_usage_pct"],
                started_at=ctx["started_at"],
                finished_at=ctx["finished_at"],
                duration_seconds=ctx["duration_seconds"],
                invocation_index=ctx["invocation_index"],
            )
            self._session.add(agent_run)
            self._session.flush()

            output_payload = _cap_payload_fields(_trace_agent_output_payload(ctx))
            self._session.add(
                AgentOutputRecord(
                    agent_run_id=agent_run.id,
                    output_json=output_payload,
                    summary_text=_trace_agent_output_summary(ctx["agent_type"], output_payload, ctx["status"]),
                    stream_count=_stream_count_from_payload(output_payload),
                    embedded_url_count=len(output_payload.get("embedded_urls", []) or []),
                    hosting_page_count=len(output_payload.get("hosting_pages", []) or []),
                    validation_status="ok" if output_payload else "missing",
                )
            )

            prompt_details = ctx.get("prompt") or {}
            if prompt_details:
                prompt_version_id = self._ensure_prompt_version(ctx["agent_type"], prompt_details)
                self._session.add(
                    PromptCompilationRecord(
                        prompt_version_id=prompt_version_id,
                        agent_run_id=agent_run.id,
                        cache_mode=str(prompt_details.get("cache_mode", "") or ""),
                        compiled_prompt_hash=str(prompt_details.get("compiled_prompt_hash", "") or ""),
                        provider_cache_key=str(prompt_details.get("provider_cache_key", "") or ""),
                        provider_cache_eligible=bool(prompt_details.get("provider_cache_eligible", False)),
                        static_cache_hit=bool(prompt_details.get("static_cache_hit", False)),
                        memory_injected=bool(prompt_details.get("memory_injected", False)),
                        output_contract_version=str(prompt_details.get("output_contract_version", "") or ""),
                        sections_json=prompt_details.get("sections", []) or [],
                        metadata_json=stamp_schema_version(prompt_details),
                    )
                )

            self._persist_llm_calls(agent_run.id, ctx)
            self._persist_tool_calls(agent_run.id, ctx)
            rows.append({**ctx, "id": agent_run.id})
        return rows

    def _persist_llm_calls(self, agent_run_id: int, ctx: dict[str, Any]) -> None:
        llm_seq = 0
        for event in ctx["events"]:
            if event.kind != "llm_response":
                continue
            llm_seq += 1
            details = event.details or {}
            prompt_details = details.get("prompt", {}) or ctx.get("prompt", {}) or {}
            input_tokens = int(details.get("input_tokens", 0) or 0)
            output_tokens = int(details.get("output_tokens", 0) or 0)
            cached_input_tokens = int(details.get("cached_input_tokens", 0) or 0)
            new_input_tokens = int(details.get("new_input_tokens", max(input_tokens - cached_input_tokens, 0)) or 0)
            cache_creation_input_tokens = int(details.get("cache_creation_input_tokens", 0) or 0)
            estimated_input_cost_usd = float(details.get("estimated_input_cost_usd", 0.0) or 0.0)
            estimated_cached_input_cost_usd = float(details.get("estimated_cached_input_cost_usd", 0.0) or 0.0)
            estimated_cache_write_cost_usd = float(details.get("estimated_cache_write_cost_usd", 0.0) or 0.0)
            estimated_output_cost_usd = float(details.get("estimated_output_cost_usd", 0.0) or 0.0)
            estimated_total_cost_usd = float(details.get("estimated_total_cost_usd", 0.0) or 0.0)

            usage_metadata = details.get("usage_metadata", {}) or {}
            if isinstance(usage_metadata, dict):
                usage_metadata = {
                    **usage_metadata,
                    "cost_source": str(details.get("cost_source", "") or ""),
                    "cached_input_tokens": cached_input_tokens,
                    "new_input_tokens": new_input_tokens,
                    "cache_creation_input_tokens": cache_creation_input_tokens,
                    "estimated_input_cost_usd": estimated_input_cost_usd,
                    "estimated_cached_input_cost_usd": estimated_cached_input_cost_usd,
                    "estimated_cache_write_cost_usd": estimated_cache_write_cost_usd,
                    "estimated_output_cost_usd": estimated_output_cost_usd,
                    "estimated_total_cost_usd": estimated_total_cost_usd,
                }
            else:
                usage_metadata = {
                    "raw": usage_metadata,
                    "cost_source": str(details.get("cost_source", "") or ""),
                    "cached_input_tokens": cached_input_tokens,
                    "new_input_tokens": new_input_tokens,
                    "cache_creation_input_tokens": cache_creation_input_tokens,
                    "estimated_input_cost_usd": estimated_input_cost_usd,
                    "estimated_cached_input_cost_usd": estimated_cached_input_cost_usd,
                    "estimated_cache_write_cost_usd": estimated_cache_write_cost_usd,
                    "estimated_output_cost_usd": estimated_output_cost_usd,
                    "estimated_total_cost_usd": estimated_total_cost_usd,
                }

            usage_metadata = stamp_schema_version(usage_metadata)

            response_metadata = details.get("response_metadata", {}) or {}
            if not isinstance(response_metadata, dict):
                response_metadata = {"raw": response_metadata}
            response_metadata = {
                **response_metadata,
                "content_full": cap_or_overflow(
                    str(
                        details.get("content_full", "")
                        or details.get("content_preview", "")
                        or ""
                    )
                ),
                "thinking_content": str(details.get("thinking_content", "") or ""),
                "thinking_tokens": int(details.get("thinking_tokens", 0) or 0),
                "additional_kwargs": details.get("additional_kwargs", {}) or {},
            }
            response_metadata = stamp_schema_version(response_metadata)

            self._session.add(
                LLMCallRecord(
                    agent_run_id=agent_run_id,
                    seq=llm_seq,
                    provider=str(details.get("provider", "") or ""),
                    model_name=str(details.get("model_name", "") or ""),
                    prompt_version=str(prompt_details.get("prompt_version", "") or ""),
                    prompt_hash=str(prompt_details.get("prompt_hash", "") or ""),
                    cache_mode=str(prompt_details.get("cache_mode", "") or ""),
                    input_tokens=input_tokens,
                    cached_input_tokens=cached_input_tokens,
                    new_input_tokens=new_input_tokens,
                    cache_creation_input_tokens=cache_creation_input_tokens,
                    output_tokens=output_tokens,
                    context_window=int(details["context_window"]) if details.get("context_window") else None,
                    estimated_input_cost_usd=estimated_input_cost_usd,
                    estimated_cached_input_cost_usd=estimated_cached_input_cost_usd,
                    estimated_cache_write_cost_usd=estimated_cache_write_cost_usd,
                    estimated_output_cost_usd=estimated_output_cost_usd,
                    estimated_total_cost_usd=estimated_total_cost_usd,
                    tool_calls_requested=int(details.get("tool_calls", 0) or 0),
                    tools_requested=details.get("tool_call_names", []) or [],
                    content_preview=str(details.get("content_preview", "") or ""),
                    usage_metadata_json=usage_metadata,
                    response_metadata_json=response_metadata,
                    created_at=event.timestamp,
                )
            )

    def _persist_tool_calls(self, agent_run_id: int, ctx: dict[str, Any]) -> None:
        pending: dict[str, dict[str, Any]] = {}
        seq = 0
        for event in ctx["events"]:
            details = event.details or {}
            if event.kind == "tool_call_started":
                seq += 1
                tool_call_id = str(details.get("tool_call_id", "") or f"seq-{seq}")
                pending[tool_call_id] = {
                    "seq": seq,
                    "tool_name": str(details.get("tool_name", "") or ""),
                    "args": details.get("tool_args", {}) or {},
                    "started_at": event.timestamp,
                }
            elif event.kind == "tool_call_finished":
                tool_call_id = str(details.get("tool_call_id", "") or "")
                if tool_call_id and tool_call_id in pending:
                    started = pending.pop(tool_call_id, None)
                else:
                    fallback_key = next(reversed(pending), "")
                    started = pending.pop(fallback_key, None) if fallback_key else None
                tool_name = str(details.get("tool_name", "") or (started or {}).get("tool_name", ""))
                result_preview = str(details.get("result_preview", "") or "")
                status = str(details.get("status", "") or event.status or "info")
                error_text = result_preview if status == "error" else ""
                self._session.add(
                    ToolCallRecord(
                        agent_run_id=agent_run_id,
                        seq=int((started or {}).get("seq", seq or 1) or 1),
                        tool_name=tool_name,
                        args_json=(started or {}).get("args", {}),
                        target_summary=_tool_target_summary(tool_name, (started or {}).get("args", {})),
                        status=status,
                        duration_seconds=float(details.get("duration_seconds", 0.0) or 0.0),
                        result_preview=result_preview,
                        error_text=error_text,
                        started_at=(started or {}).get("started_at", event.timestamp),
                        finished_at=event.timestamp,
                    )
                )

    def _persist_runtime_events(self, pipeline_run_id: int, trace: RunTrace | None, agent_runs: list[dict[str, Any]]) -> None:
        if trace is None:
            return
        seq_to_agent_run_id: dict[int, int | None] = {}
        for agent_run in agent_runs:
            for event in agent_run["events"]:
                seq_to_agent_run_id[event.seq] = agent_run["id"]
        is_dev = _is_dev_environment()
        for event in trace.events:
            self._session.add(
                RuntimeEventRecord(
                    pipeline_run_id=pipeline_run_id,
                    agent_run_id=seq_to_agent_run_id.get(event.seq),
                    actor=event.actor,
                    seq=event.seq,
                    kind=validate_runtime_event_kind(event.kind, is_dev=is_dev),
                    status=event.status,
                    message=event.message,
                    details_json=stamp_schema_version(event.details),
                    created_at=event.timestamp,
                )
            )

    def _persist_trace_runtime_events(self, pipeline_run_id: int, trace: RunTrace, agent_runs: list[dict[str, Any]]) -> None:
        seq_to_agent_run_id: dict[int, int | None] = {}
        for agent_run in agent_runs:
            for event in agent_run["events"]:
                seq_to_agent_run_id[event.seq] = agent_run["id"]
        is_dev = _is_dev_environment()
        for event in trace.events:
            self._session.add(
                RuntimeEventRecord(
                    pipeline_run_id=pipeline_run_id,
                    agent_run_id=seq_to_agent_run_id.get(event.seq),
                    actor=event.actor,
                    seq=event.seq,
                    kind=validate_runtime_event_kind(event.kind, is_dev=is_dev),
                    status=event.status,
                    message=event.message,
                    details_json=stamp_schema_version(event.details),
                    created_at=event.timestamp,
                )
            )

    def _persist_run_model_usage(self, pipeline_run_id: int, result: PipelineResult) -> None:
        metrics = result.metrics
        if metrics is None:
            return
        for entry in metrics.model_usage:
            self._session.add(
                RunModelUsageRecord(
                    pipeline_run_id=pipeline_run_id,
                    provider=entry.provider,
                    model_name=entry.model_name,
                    llm_calls=entry.llm_calls,
                    cache_hit_calls=entry.cache_hit_calls,
                    input_tokens=entry.input_tokens,
                    cached_input_tokens=entry.cached_input_tokens,
                    new_input_tokens=entry.new_input_tokens,
                    output_tokens=entry.output_tokens,
                    estimated_input_cost_usd=entry.estimated_input_cost_usd,
                    estimated_cached_input_cost_usd=entry.estimated_cached_input_cost_usd,
                    estimated_cache_write_cost_usd=entry.estimated_cache_write_cost_usd,
                    estimated_output_cost_usd=entry.estimated_output_cost_usd,
                    estimated_total_cost_usd=entry.estimated_total_cost_usd,
                )
            )

    def _persist_trace_model_usage(self, pipeline_run_id: int, trace: RunTrace) -> None:
        metrics = trace.metrics
        if metrics is None:
            return
        for entry in metrics.model_usage:
            self._session.add(
                RunModelUsageRecord(
                    pipeline_run_id=pipeline_run_id,
                    provider=entry.provider,
                    model_name=entry.model_name,
                    llm_calls=entry.llm_calls,
                    cache_hit_calls=entry.cache_hit_calls,
                    input_tokens=entry.input_tokens,
                    cached_input_tokens=entry.cached_input_tokens,
                    new_input_tokens=entry.new_input_tokens,
                    output_tokens=entry.output_tokens,
                    estimated_input_cost_usd=entry.estimated_input_cost_usd,
                    estimated_cached_input_cost_usd=entry.estimated_cached_input_cost_usd,
                    estimated_cache_write_cost_usd=entry.estimated_cache_write_cost_usd,
                    estimated_output_cost_usd=entry.estimated_output_cost_usd,
                    estimated_total_cost_usd=entry.estimated_total_cost_usd,
                )
            )

    def _persist_run_streams(self, pipeline_run_id: int, result: PipelineResult) -> None:
        for stream in result.all_streams:
            self._session.add(
                RunStreamRecord(
                    pipeline_run_id=pipeline_run_id,
                    stream_url=stream.url,
                    source_url=result.url,
                    protocol=stream.protocol or "",
                    quality=stream.quality or "",
                    source_layer=stream.source_layer or "",
                    server_label=stream.source_layer or "",
                    dedupe_hash=_hash_text(stream.url),
                    captured_at=stream.captured_at,
                )
            )

    def _persist_run_screenshots(
        self,
        pipeline_run_id: int,
        result: PipelineResult,
        *,
        trace: RunTrace | None = None,
        agent_runs: list[dict[str, Any]] | None = None,
    ) -> None:
        persisted: set[str] = set()
        for row in _collect_attributed_screenshots(
            trace,
            agent_runs or [],
            default_source_url=result.url,
        ):
            screenshot_url = str(row.get("screenshot_url") or "").strip()
            if not screenshot_url:
                continue
            # Plan task 32: inline base64 screenshots land as file-backed
            # blob refs instead of megabytes of base64 text in the DB.
            screenshot_url = data_uri_to_blob_ref(screenshot_url)
            persisted.add(screenshot_url)
            self._session.add(
                RunScreenshotRecord(
                    pipeline_run_id=pipeline_run_id,
                    agent_run_id=row.get("agent_run_id"),
                    screenshot_url=screenshot_url,
                    source_url=str(row.get("source_url") or result.url or ""),
                    label=str(row.get("label") or ""),
                    actor=str(row.get("actor") or ""),
                    agent_type=str(row.get("agent_type") or ""),
                    invocation_index=int(row.get("invocation_index", 0) or 0),
                    tool_name=str(row.get("tool_name") or ""),
                    target_url=str(row.get("target_url") or ""),
                    seq=int(row.get("seq", 0) or 0),
                )
            )
        for screenshot in result.all_screenshots:
            # Dedupe on the RAW value: attributed rows above converted their
            # data-URIs to blobrefs before adding to `persisted`, so comparing
            # raw fallback entries against converted refs would double-persist.
            if screenshot in persisted or data_uri_to_blob_ref(screenshot) in persisted:
                continue
            self._session.add(
                RunScreenshotRecord(
                    pipeline_run_id=pipeline_run_id,
                    screenshot_url=data_uri_to_blob_ref(screenshot),
                    source_url=result.url,
                )
            )

    def _persist_trace_screenshots(
        self,
        pipeline_run_id: int,
        screenshots: list[str],
        *,
        source_url: str,
        trace: RunTrace | None = None,
        agent_runs: list[dict[str, Any]] | None = None,
    ) -> None:
        persisted: set[str] = set()
        for row in _collect_attributed_screenshots(
            trace,
            agent_runs or [],
            default_source_url=source_url,
        ):
            screenshot_url = str(row.get("screenshot_url") or "").strip()
            if not screenshot_url:
                continue
            # Plan task 32: inline base64 screenshots land as file-backed
            # blob refs instead of megabytes of base64 text in the DB.
            screenshot_url = data_uri_to_blob_ref(screenshot_url)
            persisted.add(screenshot_url)
            self._session.add(
                RunScreenshotRecord(
                    pipeline_run_id=pipeline_run_id,
                    agent_run_id=row.get("agent_run_id"),
                    screenshot_url=screenshot_url,
                    source_url=str(row.get("source_url") or source_url or ""),
                    label=str(row.get("label") or ""),
                    actor=str(row.get("actor") or ""),
                    agent_type=str(row.get("agent_type") or ""),
                    invocation_index=int(row.get("invocation_index", 0) or 0),
                    tool_name=str(row.get("tool_name") or ""),
                    target_url=str(row.get("target_url") or ""),
                    seq=int(row.get("seq", 0) or 0),
                )
            )
        for screenshot in screenshots:
            if not _is_screenshot_url(screenshot):
                continue
            # Dedupe on the RAW value (see matching comment above): attributed
            # rows stored converted blobrefs, so compare both forms.
            if screenshot in persisted or data_uri_to_blob_ref(screenshot) in persisted:
                continue
            self._session.add(
                RunScreenshotRecord(
                    pipeline_run_id=pipeline_run_id,
                    screenshot_url=data_uri_to_blob_ref(screenshot),
                    source_url=source_url,
                )
            )

    def _persist_provider_analyses(self, pipeline_run_id: int, result: PipelineResult) -> None:
        for provider in result.provider_analysis:
            self._session.add(
                ProviderAnalysisRecord(
                    pipeline_run_id=pipeline_run_id,
                    stream_url=provider.stream_url,
                    ip=provider.ip,
                    hostname=provider.hostname,
                    org=provider.org,
                    provider=provider.provider,
                    country=provider.country,
                    region=provider.region,
                    city=provider.city,
                    abuse_email=provider.abuse_email,
                    whois_raw=provider.whois_raw,
                )
            )

    def _persist_takedown_emails(self, pipeline_run_id: int, result: PipelineResult) -> None:
        for email in result.takedown_emails:
            self._session.add(
                TakedownEmailRecord(
                    pipeline_run_id=pipeline_run_id,
                    provider=email.provider,
                    abuse_email=email.abuse_email,
                    channel_name=email.channel_name,
                    subject=email.subject,
                    body=email.body,
                    infringing_url=email.infringing_url,
                    stream_urls_json=list(email.stream_urls),
                    screenshot_urls_json=list(email.screenshot_urls),
                    server_labels_json=list(email.server_labels),
                    stream_evidence_json=[
                        row.model_dump(mode="json") for row in (email.stream_evidence or [])
                    ],
                    provider_info_json=email.provider_info.model_dump(mode="json") if email.provider_info else {},
                    rights_owner_reference_url=email.rights_owner_reference_url,
                    generated_at=email.generated_at,
                )
            )

    def _persist_memory_entries(
        self,
        run_id: str,
        pipeline_run_id: int,
        agent_runs: list[dict[str, Any]],
        result: PipelineResult,
        trace: RunTrace | None,
    ) -> None:
        for agent_run in agent_runs:
            if agent_run["agent_type"] == AgentType.ORCHESTRATOR.value:
                continue
            if agent_run["status"] not in {"success", "partial"}:
                continue
            payload = _agent_output_payload(agent_run, result)
            if not payload:
                continue
            entry = build_site_memory_entry(
                url=agent_run["target_url"] or result.url,
                page_type=agent_run["agent_type"],
                status=agent_run["status"],
                payload=payload,
                trace=trace,
                actor=agent_run["actor"],
                short_memory_summary="",
            )
            self._session.add(
                MemoryEntryRecord(
                    domain=entry["domain"],
                    page_type=entry["page_type"],
                    source_run_id=run_id,
                    source_agent_run_id=agent_run["id"],
                    status=entry["status"],
                    success=entry["success"],
                    url=entry["url"],
                    data_json=entry,
                    result_summary=entry.get("result_summary", ""),
                )
            )

    def _persist_memory_hints_used(self, run_id: str, agent_runs: list[dict[str, Any]]) -> None:
        for agent_run in agent_runs:
            memory_load = agent_run.get("memory_loaded") or {}
            url = str(memory_load.get("url", "") or "").strip()
            page_type = str(memory_load.get("page_type", "") or "").strip()
            if not url or not page_type:
                continue
            domain = _normalize_domain(url)
            rows = (
                self._session.query(MemoryEntryRecord)
                .filter(
                    MemoryEntryRecord.domain == domain,
                    MemoryEntryRecord.page_type == page_type,
                    MemoryEntryRecord.source_run_id != run_id,
                )
                .order_by(MemoryEntryRecord.created_at.desc())
                .limit(5)
                .all()
            )
            for row in rows:
                self._session.add(
                    MemoryHintUsedRecord(
                        agent_run_id=agent_run["id"],
                        memory_entry_id=row.id,
                    )
                )

    def _ensure_prompt_version(self, agent_type: str, prompt_details: dict[str, Any]) -> int | None:
        prompt_path = _PROMPT_PATHS.get(agent_type)
        if prompt_path is None or not prompt_path.exists():
            return None
        prompt_text = prompt_path.read_text(encoding="utf-8")
        prompt_hash = str(prompt_details.get("prompt_hash", "") or _hash_text(prompt_text))
        record = (
            self._session.query(PromptVersionRecord)
            .filter_by(agent_id=agent_type, content_hash=prompt_hash)
            .first()
        )
        if record is None:
            record = PromptVersionRecord(
                agent_id=agent_type,
                source_path=str(prompt_path),
                semantic_version=prompt_path.stem,
                content_hash=prompt_hash,
                prompt_text=prompt_text,
                active=True,
            )
            self._session.add(record)
            self._session.flush()
        return record.id


class BackgroundJobRepository:
    TERMINAL_STATUSES = {"succeeded", "failed", "cancelled", "dead_letter"}

    def __init__(self, session: Session) -> None:
        self._session = session

    def enqueue(
        self,
        *,
        run_id: str,
        job_type: str,
        url: str,
        actor: str,
        payload: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        max_attempts: int = 2,
    ) -> BackgroundJobRecord:
        key = (idempotency_key or "").strip() or None
        if key:
            existing = (
                self._session.query(BackgroundJobRecord)
                .filter_by(job_type=job_type, idempotency_key=key)
                .first()
            )
            if existing is not None:
                return existing
        record = BackgroundJobRecord(
            job_id=_hash_text(f"{run_id}:{job_type}:{datetime.now(UTC).isoformat()}"),
            run_id=run_id,
            job_type=job_type,
            status="queued",
            idempotency_key=key,
            url=url,
            actor=actor,
            payload_json=payload or {},
            max_attempts=max(1, int(max_attempts)),
        )
        self._session.add(record)
        self._session.commit()
        self._session.refresh(record)
        return record

    def list_active(self, limit: int = 200) -> list[BackgroundJobRecord]:
        return (
            self._session.query(BackgroundJobRecord)
            .filter(BackgroundJobRecord.status.in_(["queued", "running", "retrying"]))
            .order_by(BackgroundJobRecord.created_at.desc())
            .limit(max(1, limit))
            .all()
        )

    def list_all(self, limit: int = 400) -> list[BackgroundJobRecord]:
        return (
            self._session.query(BackgroundJobRecord)
            .order_by(BackgroundJobRecord.created_at.desc())
            .limit(max(1, limit))
            .all()
        )

    def get_by_run_id(self, run_id: str) -> BackgroundJobRecord | None:
        return self._session.query(BackgroundJobRecord).filter_by(run_id=run_id).first()

    def claim_next(
        self,
        *,
        lease_seconds: int = 90,
    ) -> BackgroundJobRecord | None:
        now = datetime.now(UTC)
        dialect_name = self._session.get_bind().dialect.name
        candidate_id = (
            select(BackgroundJobRecord.id)
            .where(BackgroundJobRecord.status.in_(["queued", "retrying"]))
            .order_by(BackgroundJobRecord.created_at.asc(), BackgroundJobRecord.id.asc())
            .limit(1)
        )
        if dialect_name == "postgresql":
            # Concurrency invariant: keep FOR UPDATE SKIP LOCKED or workers double-claim.
            candidate_id = candidate_id.with_for_update(skip_locked=True)
        # Concurrency invariant: claim must stay ONE atomic UPDATE (RETURNING),
        # never SELECT-then-mutate, or concurrent workers double-claim.
        claim_stmt = (
            update(BackgroundJobRecord)
            .where(BackgroundJobRecord.id == candidate_id.scalar_subquery())
            .values(
                status="running",
                started_at=func.coalesce(BackgroundJobRecord.started_at, now),
                heartbeat_at=now,
                lease_expires_at=now + timedelta(seconds=max(5, int(lease_seconds))),
                attempts=func.coalesce(BackgroundJobRecord.attempts, 0) + 1,
                error_text="",
            )
            .returning(BackgroundJobRecord.id)
        )
        claimed_id = self._session.execute(claim_stmt).scalar_one_or_none()
        self._session.commit()
        if claimed_id is None:
            return None
        return self._session.get(BackgroundJobRecord, claimed_id)

    def heartbeat(self, run_id: str, *, lease_seconds: int = 90) -> None:
        row = self.get_by_run_id(run_id)
        if row is None:
            return
        now = datetime.now(UTC)
        row.heartbeat_at = now
        row.lease_expires_at = now + timedelta(seconds=max(5, int(lease_seconds)))
        self._session.commit()

    def mark_cancelled(self, run_id: str, *, reason: str = "") -> None:
        row = self.get_by_run_id(run_id)
        if row is None or row.status in self.TERMINAL_STATUSES:
            return
        row.status = "cancelled"
        row.error_text = reason
        row.finished_at = datetime.now(UTC)
        self._session.commit()

    def mark_succeeded(self, run_id: str, result_json: dict[str, Any] | None = None) -> None:
        row = self.get_by_run_id(run_id)
        if row is None or row.status == "cancelled":
            return
        row.status = "succeeded"
        row.result_json = result_json or {}
        row.error_text = ""
        row.finished_at = datetime.now(UTC)
        row.lease_expires_at = None
        self._session.commit()

    def mark_failed(self, run_id: str, *, error_text: str) -> BackgroundJobRecord | None:
        row = self.get_by_run_id(run_id)
        if row is None or row.status == "cancelled":
            return None
        exhausted = int(row.attempts or 0) >= int(row.max_attempts or 1)
        row.status = "dead_letter" if exhausted else "retrying"
        row.error_text = error_text
        row.finished_at = datetime.now(UTC) if exhausted else None
        row.lease_expires_at = None
        self._session.commit()
        self._session.refresh(row)
        return row

    def recover_stale_running(self, *, stale_after_seconds: int = 180) -> int:
        now = datetime.now(UTC)
        threshold = now - timedelta(seconds=max(5, int(stale_after_seconds)))
        rows = (
            self._session.query(BackgroundJobRecord)
            .filter(BackgroundJobRecord.status == "running")
            .all()
        )
        recovered = 0
        for row in rows:
            heartbeat = row.heartbeat_at or row.started_at or row.created_at
            lease_expired = row.lease_expires_at is not None and row.lease_expires_at <= now
            if lease_expired or heartbeat <= threshold:
                row.status = "retrying" if int(row.attempts or 0) < int(row.max_attempts or 1) else "dead_letter"
                row.lease_expires_at = None
                row.finished_at = now if row.status == "dead_letter" else None
                recovered += 1
        if recovered:
            self._session.commit()
        return recovered


def _extract_agent_contexts(trace: RunTrace | None, result: PipelineResult) -> list[dict[str, Any]]:
    if trace is None:
        return _fallback_agent_contexts(result)

    contexts: list[dict[str, Any]] = []
    open_runs: dict[str, dict[str, Any]] = {}
    invocation_counts: dict[str, int] = {}

    for event in trace.events:
        actor = event.actor or "unknown"
        kind = event.kind
        is_start = kind in {"agent_started", "pipeline_started"}
        is_finish = kind in {"agent_finished", "pipeline_finished", "pipeline_failed"}
        current = open_runs.get(actor)

        if is_start:
            invocation_counts[actor] = invocation_counts.get(actor, 0) + 1
            current = {
                "actor": actor,
                "agent_type": _ACTOR_TO_AGENT_TYPE.get(actor, actor),
                "events": [event],
                "started_at": event.timestamp,
                "finished_at": None,
                "invocation_index": invocation_counts[actor],
            }
            open_runs[actor] = current
            continue

        if current is None:
            invocation_counts[actor] = invocation_counts.get(actor, 0) + 1
            current = {
                "actor": actor,
                "agent_type": _ACTOR_TO_AGENT_TYPE.get(actor, actor),
                "events": [],
                "started_at": event.timestamp,
                "finished_at": None,
                "invocation_index": invocation_counts[actor],
            }
            open_runs[actor] = current

        current["events"].append(event)

        if is_finish:
            current["finished_at"] = event.timestamp
            contexts.append(current)
            open_runs.pop(actor, None)

    for current in open_runs.values():
        current["finished_at"] = current["events"][-1].timestamp if current["events"] else current["started_at"]
        contexts.append(current)

    contexts.sort(key=lambda item: item["started_at"])

    type_counts: dict[str, int] = {}
    default_page_type = result.classification.page_type.value if result.classification else "unknown"
    for ctx in contexts:
        agent_type = ctx["agent_type"]
        type_counts[agent_type] = type_counts.get(agent_type, 0) + 1
        ctx["type_invocation_index"] = type_counts[agent_type]
        ctx["target_url"] = _extract_target_url(ctx["events"], result.url)
        ctx["page_type"] = _page_type_for_agent(agent_type, default_page_type)
        ctx["prompt"] = _first_event_details(ctx["events"], "prompt_compiled")
        ctx["memory_loaded"] = _first_event_details(ctx["events"], "memory_loaded")
        ctx["tool_call_budget"] = int((_first_event_details(ctx["events"], "agent_loop_started") or {}).get("max_tool_calls", 0) or 0)
        ctx["tool_calls_made"] = sum(1 for event in ctx["events"] if event.kind == "tool_call_started")
        ctx["llm_calls_made"] = sum(1 for event in ctx["events"] if event.kind == "llm_response")
        ctx["duration_seconds"] = max((ctx["finished_at"] - ctx["started_at"]).total_seconds(), 0.0)
        ctx["status"] = _resolve_agent_status(ctx, result)
    return contexts


def _agent_context_metrics(ctx: dict[str, Any]) -> dict[str, Any]:
    input_tokens = 0
    cached_input_tokens = 0
    new_input_tokens = 0
    output_tokens = 0
    context_window = 0
    context_tokens = 0
    context_usage_pct = 0.0
    provider = ""
    model_name = ""

    for event in ctx.get("events", []) or []:
        if event.kind == "context_compaction_finished":
            continue
        details = event.details or {}
        if not isinstance(details, dict):
            continue

        event_input_tokens = int(details.get("input_tokens", 0) or 0)
        event_output_tokens = int(details.get("output_tokens", 0) or 0)
        event_cached_tokens = int(details.get("cached_input_tokens", 0) or 0)
        event_new_tokens = int(
            details.get(
                "new_input_tokens",
                max(event_input_tokens - event_cached_tokens, 0),
            )
            or 0
        )

        if event.kind == "llm_response":
            input_tokens += event_input_tokens
            cached_input_tokens += event_cached_tokens
            new_input_tokens += event_new_tokens
            output_tokens += event_output_tokens
            provider = str(details.get("provider", "") or provider)
            model_name = str(details.get("model_name", "") or model_name)

        event_window = int(details.get("context_window", 0) or 0)
        if event_window > context_window:
            context_window = event_window

        event_context_tokens = int(
            details.get("context_tokens", 0)
            or (event_input_tokens + event_output_tokens if event.kind == "llm_response" else 0)
            or 0
        )
        if event_context_tokens > context_tokens:
            context_tokens = event_context_tokens

        event_usage_pct = float(details.get("context_usage_pct", 0.0) or 0.0)
        if not event_usage_pct and event_window > 0 and event_context_tokens > 0:
            event_usage_pct = event_context_tokens / max(event_window, 1)
        if event_usage_pct > context_usage_pct:
            context_usage_pct = event_usage_pct

    if context_window > 0 and context_tokens > 0:
        context_usage_pct = max(context_usage_pct, context_tokens / max(context_window, 1))

    return {
        "provider": provider,
        "model_name": model_name,
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_input_tokens,
        "new_input_tokens": new_input_tokens,
        "output_tokens": output_tokens,
        "context_window": context_window,
        "context_tokens": context_tokens,
        "context_usage_pct": round(context_usage_pct, 6),
    }


def _fallback_agent_contexts(result: PipelineResult) -> list[dict[str, Any]]:
    started_at = result.metrics.started_at if result.metrics else datetime.now(UTC)
    finished_at = result.metrics.finished_at if result.metrics and result.metrics.finished_at else started_at
    contexts: list[dict[str, Any]] = [
        {
            "actor": "orchestrator",
            "agent_type": AgentType.ORCHESTRATOR.value,
            "events": [],
            "started_at": started_at,
            "finished_at": finished_at,
            "invocation_index": 1,
            "type_invocation_index": 1,
            "target_url": result.url,
            "page_type": result.classification.page_type.value if result.classification else "unknown",
            "prompt": {},
            "memory_loaded": {},
            "tool_call_budget": 0,
            "tool_calls_made": 0,
            "llm_calls_made": 0,
            "duration_seconds": result.metrics.total_duration_seconds if result.metrics else 0.0,
            "status": result.final_status.value,
        }
    ]
    if result.classification:
        contexts.append(
            {
                "actor": "classification",
                "agent_type": AgentType.CLASSIFICATION.value,
                "events": [],
                "started_at": started_at,
                "finished_at": finished_at,
                "invocation_index": 1,
                "type_invocation_index": 1,
                "target_url": result.url,
                "page_type": AgentType.CLASSIFICATION.value,
                "prompt": {},
                "memory_loaded": {},
                "tool_call_budget": 0,
                "tool_calls_made": 0,
                "llm_calls_made": 0,
                "duration_seconds": 0.0,
                "status": "success",
            }
        )
    return contexts


def _agent_output_payload(ctx: dict[str, Any], result: PipelineResult) -> dict[str, Any]:
    agent_type = ctx["agent_type"]
    target_url = ctx.get("target_url") or result.url
    occurrence = ctx.get("type_invocation_index", 1)

    if agent_type == AgentType.ORCHESTRATOR.value:
        return {
            "run_id": result.run_id,
            "url": result.url,
            "final_status": result.final_status.value,
            "page_type": _result_primary_page_type(result),
            "matches_found": len(result.matches),
            "stream_count": len(result.all_streams),
            "provider_analysis_count": len(result.provider_analysis),
            "email_count": len(result.takedown_emails),
            "all_streams": [stream.model_dump(mode="json") for stream in result.all_streams],
            "all_screenshots": list(result.all_screenshots),
            "provider_analysis": [
                provider.model_dump(mode="json") for provider in result.provider_analysis
            ],
            "takedown_emails": [email.model_dump(mode="json") for email in result.takedown_emails],
            "extraction_checks": _orchestrator_extraction_checks(result),
        }
    if agent_type == AgentType.CLASSIFICATION.value and result.classification is not None:
        return result.classification.model_dump(mode="json")
    if agent_type == AgentType.LANDING_PAGE.value:
        return {"hosting_pages": [match.model_dump(mode="json") for match in result.matches]}

    candidates = [
        extraction
        for extraction in result.extraction_results
        if extraction.agent_type.value == agent_type
    ]
    exact = [candidate for candidate in candidates if candidate.url == target_url]
    if exact:
        chosen = exact[0]
    elif len(candidates) >= occurrence:
        chosen = candidates[occurrence - 1]
    else:
        chosen = None
    return chosen.model_dump(mode="json") if chosen is not None else {}


def _agent_output_summary(agent_type: str, payload: dict[str, Any]) -> str:
    if not payload:
        return ""
    if agent_type == AgentType.CLASSIFICATION.value:
        return f"classified as {payload.get('page_type', 'unknown')} ({payload.get('confidence', 'unknown')} confidence)"
    if agent_type == AgentType.LANDING_PAGE.value:
        count = len(payload.get("hosting_pages", []) or [])
        return (
            f"hosting pages found={count}"
            if count
            else "no hosting pages returned; no downstream targets queued"
        )
    if agent_type in {AgentType.HOSTING_PAGE.value, AgentType.EMBEDDED_PAGE.value}:
        return (
            f"status={payload.get('status', 'unknown')}; "
            f"streams={_stream_count_from_payload(payload)}; "
            f"embedded targets={len(payload.get('embedded_urls', []) or [])}"
        )
    if agent_type == AgentType.ORCHESTRATOR.value:
        return (
            f"pipeline status={payload.get('final_status', 'unknown')}; "
            f"matches={payload.get('matches_found', 0)}; "
            f"streams={payload.get('stream_count', 0)}"
        )
    return ""


def _stream_count_from_payload(payload: dict[str, Any]) -> int:
    count = len(payload.get("streams", []) or [])
    count += len(payload.get("streaming_urls", []) or [])
    count += len(payload.get("all_stream_urls", []) or [])
    for server in payload.get("servers", []) or []:
        count += len(server.get("m3u8_urls", []) or [])
        count += len(server.get("mpd_urls", []) or [])
        count += len(server.get("mp4_urls", []) or [])
    return count


def _dedupe_keep_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        text = str(value or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _orchestrator_extraction_checks(result: PipelineResult) -> list[dict[str, Any]]:
    checks: list[dict[str, Any]] = []
    for extraction in result.extraction_results:
        collected_streams = _dedupe_keep_order(
            [stream.url for stream in extraction.streams if getattr(stream, "url", "")]
        )
        screenshots = _dedupe_keep_order(
            [
                *list(extraction.screenshots or []),
                *[
                    server.screenshot_url
                    for server in extraction.servers
                    if getattr(server, "screenshot_url", None)
                ],
            ]
        )
        network_diagnostics_count = sum(
            len(server.network_diagnostics or []) for server in extraction.servers
        )
        iframe_diagnostics_count = sum(
            len(server.iframe_diagnostics or []) for server in extraction.servers
        )
        server_rows = []
        sample_streams: list[str] = []
        for server in extraction.servers:
            server_streams = _dedupe_keep_order(
                [
                    *list(server.stream_urls or []),
                    *list(server.m3u8_urls or []),
                    *list(server.mpd_urls or []),
                    *list(server.mp4_urls or []),
                    *(([server.primary_stream] if server.primary_stream else [])),
                ]
            )
            sample_streams.extend(server_streams[:3])
            collected_streams.extend(server_streams)
            server_rows.append(
                {
                    "label": server.label,
                    "status": server.status,
                    "server_up": server.server_up,
                    "player_state": server.player_state or "",
                    "detected_channel": server.detected_channel or "",
                    "channel_candidates": list(server.channel_candidates or []),
                    "channel_confidence": server.channel_confidence or "",
                    "channel_detection_method": server.channel_detection_method or "",
                    "ocr_text": server.ocr_text or "",
                    "playback_confirmed": bool(server.playback_confirmed),
                    "server_change_observed": bool(server.server_change_observed),
                    "stream_count": len(server_streams),
                    "screenshot_url": server.screenshot_url or "",
                    "embedded_url": server.embedded_url or "",
                    "player_iframe_url": server.player_iframe_url or "",
                    "network_diagnostics_count": len(server.network_diagnostics or []),
                    "iframe_diagnostics_count": len(server.iframe_diagnostics or []),
                }
            )
        checks.append(
            {
                "url": extraction.url,
                "agent_type": extraction.agent_type.value,
                "page_type": extraction.page_type.value,
                "status": extraction.status.value,
                "primary_channel": extraction.primary_channel,
                "detected_channels": list(extraction.detected_channels or []),
                "channel_metadata": dict(extraction.channel_metadata or {}),
                "server_count": len(extraction.servers),
                "stream_count": len(_dedupe_keep_order(collected_streams)),
                "screenshot_count": len(screenshots),
                "network_diagnostics_count": network_diagnostics_count,
                "iframe_diagnostics_count": iframe_diagnostics_count,
                "sample_streams": _dedupe_keep_order(sample_streams)[:8],
                "sample_screenshots": screenshots[:4],
                "servers": server_rows,
            }
        )
    return checks


def _resolve_agent_status(ctx: dict[str, Any], result: PipelineResult) -> str:
    agent_type = ctx["agent_type"]
    payload = _agent_output_payload(ctx, result)
    if agent_type == AgentType.ORCHESTRATOR.value:
        return result.final_status.value
    if agent_type == AgentType.CLASSIFICATION.value:
        return "success" if result.classification is not None else "failed"
    if agent_type == AgentType.LANDING_PAGE.value:
        return "success" if payload.get("hosting_pages") else "partial"
    if agent_type in {AgentType.HOSTING_PAGE.value, AgentType.EMBEDDED_PAGE.value}:
        status = str(payload.get("status", "") or "")
        return status or str(ctx["events"][-1].status or "unknown").replace("warning", "partial")
    return str(ctx["events"][-1].status or "unknown")


def _extract_trace_agent_contexts(trace: RunTrace, *, default_url: str, root_actor: str) -> list[dict[str, Any]]:
    contexts: list[dict[str, Any]] = []
    open_runs: dict[str, dict[str, Any]] = {}
    invocation_counts: dict[str, int] = {}

    for event in trace.events:
        actor = event.actor or root_actor or "unknown"
        if actor == "control-room":
            continue
        kind = event.kind
        is_start = kind in {"agent_started", "pipeline_started"}
        is_finish = kind in {"agent_finished", "pipeline_finished", "pipeline_failed", "run_cancelled"}
        current = open_runs.get(actor)

        if is_start:
            invocation_counts[actor] = invocation_counts.get(actor, 0) + 1
            current = {
                "actor": actor,
                "agent_type": _ACTOR_TO_AGENT_TYPE.get(actor, actor),
                "events": [event],
                "started_at": event.timestamp,
                "finished_at": None,
                "invocation_index": invocation_counts[actor],
            }
            open_runs[actor] = current
            continue

        if current is None:
            invocation_counts[actor] = invocation_counts.get(actor, 0) + 1
            current = {
                "actor": actor,
                "agent_type": _ACTOR_TO_AGENT_TYPE.get(actor, actor),
                "events": [],
                "started_at": event.timestamp,
                "finished_at": None,
                "invocation_index": invocation_counts[actor],
            }
            open_runs[actor] = current

        current["events"].append(event)

        if is_finish:
            current["finished_at"] = event.timestamp
            contexts.append(current)
            open_runs.pop(actor, None)

    for current in open_runs.values():
        current["finished_at"] = current["events"][-1].timestamp if current["events"] else current["started_at"]
        contexts.append(current)

    contexts.sort(key=lambda item: item["started_at"])

    type_counts: dict[str, int] = {}
    for ctx in contexts:
        agent_type = ctx["agent_type"]
        type_counts[agent_type] = type_counts.get(agent_type, 0) + 1
        ctx["type_invocation_index"] = type_counts[agent_type]
        ctx["target_url"] = _extract_target_url(ctx["events"], default_url)
        ctx["page_type"] = _trace_page_type_for_agent(ctx)
        ctx["prompt"] = _first_event_details(ctx["events"], "prompt_compiled")
        ctx["memory_loaded"] = _first_event_details(ctx["events"], "memory_loaded")
        ctx["tool_call_budget"] = int((_first_event_details(ctx["events"], "agent_loop_started") or {}).get("max_tool_calls", 0) or 0)
        ctx["tool_calls_made"] = sum(1 for event in ctx["events"] if event.kind == "tool_call_started")
        ctx["llm_calls_made"] = sum(1 for event in ctx["events"] if event.kind == "llm_response")
        ctx["duration_seconds"] = max((ctx["finished_at"] - ctx["started_at"]).total_seconds(), 0.0)
        ctx["status"] = _resolve_trace_agent_status(ctx)
    return contexts


def _trace_page_type_for_agent(ctx: dict[str, Any]) -> str:
    agent_type = ctx["agent_type"]
    if agent_type == AgentType.CLASSIFICATION.value:
        payload = _trace_agent_output_payload(ctx)
        return str(payload.get("page_type", "classification") or "classification")
    return agent_type


def _resolve_trace_agent_status(ctx: dict[str, Any]) -> str:
    events = ctx.get("events", [])
    kinds = {event.kind for event in events}
    if "run_cancelled" in kinds or "cancel_requested" in kinds:
        return "cancelled"
    final = next((event for event in reversed(events) if event.kind in {"agent_finished", "pipeline_finished", "pipeline_failed", "agent_failed"}), None)
    if final is None:
        return "running"
    status = str(final.status or "").lower()
    if final.kind in {"pipeline_failed", "agent_failed"} or status == "error":
        return "failed"
    if status == "warning":
        return "partial"
    if status == "success":
        return "success"
    return "failed"


def _trace_agent_output_payload(ctx: dict[str, Any]) -> dict[str, Any]:
    for event in reversed(ctx.get("events", [])):
        if event.kind != "llm_response":
            continue
        details = event.details or {}
        content = details.get("content_full") or details.get("content_preview") or ""
        if not isinstance(content, str) or not content.strip():
            continue
        try:
            import json

            parsed = json.loads(content)
        except Exception:
            continue
        if isinstance(parsed, dict):
            return parsed
    return {}


def _trace_agent_output_summary(agent_type: str, payload: dict[str, Any], status: str) -> str:
    if payload:
        if agent_type == AgentType.CLASSIFICATION.value:
            return f"classified as {payload.get('page_type', 'unknown')} ({payload.get('confidence', 'unknown')} confidence)"
        if agent_type == AgentType.LANDING_PAGE.value:
            count = len(payload.get("hosting_pages", []) or [])
            return (
                f"hosting pages found={count}"
                if count
                else "no hosting pages returned; no downstream targets queued"
            )
        if agent_type in {AgentType.HOSTING_PAGE.value, AgentType.EMBEDDED_PAGE.value}:
            return (
                f"status={payload.get('status', 'unknown')}; "
                f"streams={_stream_count_from_payload(payload)}; "
                f"embedded targets={len(payload.get('embedded_urls', []) or [])}"
            )
        if agent_type == AgentType.ORCHESTRATOR.value:
            return f"pipeline status={payload.get('final_status', status or 'unknown')}"
    return f"status={status or 'unknown'}"


def _first_event_details(events: list[Any], kind: str) -> dict[str, Any]:
    for event in events:
        if event.kind == kind:
            return event.details or {}
    return {}


def _extract_target_url(events: list[Any], default_url: str) -> str:
    for event in events:
        details = event.details or {}
        for key in ("url", "mainUrl", "player_iframe_url", "base_url"):
            if details.get(key):
                return str(details[key])
        match = re.search(r"for (https?://\S+)", event.message or "")
        if match:
            return match.group(1).rstrip(".")
    return default_url


def _page_type_for_agent(agent_type: str, default_page_type: str) -> str:
    if agent_type == AgentType.CLASSIFICATION.value:
        return AgentType.CLASSIFICATION.value
    if agent_type == AgentType.ORCHESTRATOR.value:
        return default_page_type
    return agent_type


def _tool_target_summary(tool_name: str, tool_args: dict[str, Any] | None) -> str:
    args = tool_args or {}
    for key in ("url", "mainUrl", "player_iframe_url", "selector", "text", "xpath", "kind", "action", "value"):
        value = args.get(key)
        if value not in (None, "", [], {}):
            return f"{tool_name} on {key}={value}"
    return tool_name


def _normalize_domain(url: str) -> str:
    host = (urlparse(url).netloc or "").lower().strip()
    return host[4:] if host.startswith("www.") else host


def _hint_domain(domain_or_url: str) -> str:
    """Normalize a full URL OR a bare domain ("example.tv") to a bare host."""
    host = _normalize_domain(str(domain_or_url or ""))
    return host or str(domain_or_url or "").lower().strip()


def _hash_text(value: str) -> str:
    return hashlib.sha256(str(value or "").encode("utf-8")).hexdigest()


#: Payload keys subject to the inline size cap (plan task 32).
_CAPPED_PAYLOAD_KEYS = ("result_full", "content_full")


def _cap_payload_fields(
    payload: Any,
    *,
    cap_bytes: int | None = None,
) -> Any:
    """Recursively replace oversized ``result_full``/``content_full`` strings.

    Values exceeding ``cap_bytes`` (Settings.payload_cap_bytes by default)
    are overflowed to the blob store and swapped for a compact
    ``blobref:<hash>`` pointer; everything else passes through unchanged.
    """
    if isinstance(payload, dict):
        capped: dict[str, Any] = {}
        for key, value in payload.items():
            if isinstance(value, str) and key in _CAPPED_PAYLOAD_KEYS:
                capped[key] = cap_or_overflow(value, cap_bytes=cap_bytes)
            else:
                capped[key] = _cap_payload_fields(value, cap_bytes=cap_bytes)
        return capped
    if isinstance(payload, (list, tuple)):
        items = [_cap_payload_fields(item, cap_bytes=cap_bytes) for item in payload]
        return items if isinstance(payload, list) else type(payload)(items)
    return payload


class SiteHintRepository:
    """CRUD + hybrid retrieval for pgvector-backed site hints (plan task 18).

    Semantic search uses pgvector's cosine distance operator ``<=>`` on
    PostgreSQL. On other dialects (SQLite test runs) embeddings are JSON lists
    and ranking falls back to Python-side cosine distance, so the repository
    API is identical everywhere.
    """

    #: Exponential-moving-average weight applied to a NEW observation when
    #: blending success_rate into an existing hint (0.5 = plain running mean).
    SUCCESS_RATE_EMA_ALPHA = 0.5

    def __init__(self, session: Session) -> None:
        self._session = session

    def _begin_own_transaction(self):
        """Same durability contract as RunRepository ([DM-C1]): self-committing."""
        if self._session.in_transaction():
            self._session.commit()
        return self._session.begin()

    # ------------------------------------------------------------------ write

    def upsert_hint(
        self,
        *,
        domain: str,
        page_type: str,
        summary_text: str = "",
        navigation_steps: list[str] | None = None,
        selectors: list[str] | None = None,
        success_rate: float | None = None,
        embedding: list[float] | None = None,
        ttl_expires_at: datetime | None = None,
    ) -> SiteHintRecord:
        """Create or refresh the (domain, page_type) hint; returns the row.

        Race-safe ([DM-C1] durability contract): each attempt runs in its own
        self-committing transaction. If two writers pass the existence check
        simultaneously, the loser's INSERT hits the unique constraint and the
        upsert retries once as an update instead of crashing.
        """
        normalized_domain = _hint_domain(domain)
        last_exc: IntegrityError | None = None
        for _attempt in range(2):
            try:
                with self._begin_own_transaction():
                    record = (
                        self._session.query(SiteHintRecord)
                        .filter_by(domain=normalized_domain, page_type=page_type)
                        .one_or_none()
                    )
                    if record is None:
                        record = SiteHintRecord(
                            domain=normalized_domain,
                            page_type=page_type,
                            summary_text=summary_text or "",
                            navigation_steps=list(navigation_steps or []),
                            selectors=list(selectors or []),
                            embedding=list(embedding) if embedding is not None else None,
                            ttl_expires_at=ttl_expires_at,
                        )
                        if success_rate is not None:
                            record.success_rate = float(success_rate)
                        self._session.add(record)
                    else:
                        if summary_text:
                            record.summary_text = summary_text
                        if navigation_steps:
                            record.navigation_steps = list(navigation_steps)
                        if selectors:
                            record.selectors = list(selectors)
                        if embedding is not None:
                            record.embedding = list(embedding)
                        if ttl_expires_at is not None:
                            record.ttl_expires_at = ttl_expires_at
                        if success_rate is not None:
                            alpha = self.SUCCESS_RATE_EMA_ALPHA
                            blended = (
                                alpha * float(success_rate)
                                + (1.0 - alpha) * float(record.success_rate)
                            )
                            record.success_rate = round(blended, 4)
                    self._session.flush()
                self._session.refresh(record)
                return record
            except IntegrityError as exc:
                # Lost the insert race; the rolled-back transaction leaves a
                # clean slate so the retry takes the UPDATE path.
                last_exc = exc
                self._session.rollback()
        raise last_exc  # pragma: no cover - both attempts lost the race

    def prune_expired(self, *, now: datetime | None = None) -> int:
        """Delete hints whose TTL has elapsed; returns how many rows died."""
        cutoff = now or datetime.now(UTC)
        with self._begin_own_transaction():
            doomed = (
                self._session.query(SiteHintRecord)
                .filter(
                    SiteHintRecord.ttl_expires_at.isnot(None),
                    SiteHintRecord.ttl_expires_at < cutoff,
                )
                .all()
            )
            count = len(doomed)
            for record in doomed:
                self._session.delete(record)
            self._session.flush()
        return count

    # ------------------------------------------------------------------- read

    def get_hints(
        self,
        *,
        domain: str | None = None,
        page_type: str | None = None,
        limit: int = 10,
    ) -> list[SiteHintRecord]:
        """SQL-side hybrid filter, freshest first."""
        query = self._session.query(SiteHintRecord)
        if domain:
            query = query.filter(SiteHintRecord.domain == _hint_domain(domain))
        if page_type:
            query = query.filter(SiteHintRecord.page_type == page_type)
        return query.order_by(SiteHintRecord.updated_at.desc()).limit(max(int(limit), 1)).all()

    def search_semantic(
        self,
        query_embedding: list[float],
        *,
        domain: str | None = None,
        page_type: str | None = None,
        limit: int = 10,
    ) -> list[SiteHintRecord]:
        """Rank hints by cosine distance to ``query_embedding``.

        PostgreSQL path pushes ordering into pgvector's ``<=>`` operator;
        every other dialect ranks in Python over SQL-filtered candidates.
        Each returned record carries ``semantic_distance``
        (0.0 = identical direction). Rows without embeddings never match.
        """
        query_vector = [float(item) for item in query_embedding]
        filters = [SiteHintRecord.embedding.isnot(None)]
        if domain:
            filters.append(SiteHintRecord.domain == _hint_domain(domain))
        if page_type:
            filters.append(SiteHintRecord.page_type == page_type)

        if self._pgvector_available():
            distance = SiteHintRecord.embedding.cosine_distance(query_vector)
            rows = (
                self._session.query(SiteHintRecord, distance.label("semantic_distance"))
                .filter(*filters)
                .order_by(distance.asc())
                .limit(max(int(limit), 1))
                .all()
            )
            results = []
            for record, dist in rows:
                record.semantic_distance = float(dist)  # type: ignore[attr-defined]
                results.append(record)
            return results

        candidates = (
            self._session.query(SiteHintRecord)
            .filter(*filters)
            .order_by(SiteHintRecord.updated_at.desc())
            .all()
        )
        ranked: list[tuple[float, SiteHintRecord]] = []
        for record in candidates:
            stored = [float(item) for item in (record.embedding or [])]
            if not stored:
                continue
            ranked.append((_cosine_distance(query_vector, stored), record))
        ranked.sort(key=lambda pair: pair[0])
        results = []
        for dist, record in ranked[: max(int(limit), 1)]:
            record.semantic_distance = dist  # type: ignore[attr-defined]
            results.append(record)
        return results

    # --------------------------------------------------------------- internal

    def _pgvector_available(self) -> bool:
        try:
            from pgvector.sqlalchemy import Vector  # noqa: F401
        except ImportError:
            return False
        return self._session.get_bind().dialect.name == "postgresql"


def _cosine_distance(a: list[float], b: list[float]) -> float:
    """Cosine distance (1 - cosine similarity); zero vectors sort last."""
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0.0 or norm_b == 0.0:
        return float("inf")
    similarity = max(-1.0, min(1.0, dot / (norm_a * norm_b)))
    return 1.0 - similarity


class RunPlanRepository:
    """RunPlan artifact persistence (plan task 27).

    Owns the ``run_plans`` declaration row and the live ``plan_steps`` status
    rows. Designed to be callable from ANY lane: the orchestrator at run start
    (via :mod:`src.orchestrator.run_plan`), node bodies in a later wave, or
    app-level wrappers — without touching orchestrator.py.
    """

    #: Full lifecycle for a plan step; transitions outside this set are rejected.
    PLAN_STEP_STATUSES = ("pending", "in_progress", "done", "failed", "skipped")

    def __init__(self, session: Session) -> None:
        self._session = session

    def _begin_own_transaction(self):
        """Same durability contract as RunRepository ([DM-C1]): self-committing."""
        if self._session.in_transaction():
            self._session.commit()
        return self._session.begin()

    # ------------------------------------------------------------------ write

    def create_plan(
        self,
        run_id: str,
        strategy: str,
        steps: list[dict[str, Any]],
    ) -> RunPlanRecord:
        """Persist the declarative plan + one pending PlanStepRecord per step.

        ``steps`` items accept ``id`` (required), plus optional ``title``,
        ``criteria``, and ``budget`` (JSON-serializable). Re-calling with the
        same run_id is idempotent: the existing declaration is returned
        unchanged so a retried run start cannot duplicate rows.
        """
        normalized_steps = [
            {
                "id": str(step.get("id", "")).strip(),
                "title": str(step.get("title", "")),
                "criteria": str(step.get("criteria", "")),
                "budget": step.get("budget"),
            }
            for step in steps
        ]
        missing = [i for i, step in enumerate(normalized_steps) if not step["id"]]
        if missing:
            raise ValueError(f"plan step(s) at index {missing} are missing an 'id'")

        document = {
            "strategy": str(strategy or ""),
            "steps": [
                {
                    "id": step["id"],
                    "title": step["title"],
                    "criteria": step["criteria"],
                    "budget": step["budget"],
                }
                for step in normalized_steps
            ],
        }

        with self._begin_own_transaction():
            existing = (
                self._session.query(RunPlanRecord).filter_by(run_id=run_id).one_or_none()
            )
            if existing is not None:
                return existing
            record = RunPlanRecord(run_id=run_id, strategy=document["strategy"], plan=document)
            self._session.add(record)
            self._session.flush()
            for position, step in enumerate(normalized_steps):
                self._session.add(
                    PlanStepRecord(
                        run_id=run_id,
                        step_id=step["id"],
                        position=position,
                        title=step["title"],
                        criteria=step["criteria"],
                        budget=step["budget"],
                        status="pending",
                    )
                )
            return record

    def transition_step(self, run_id: str, step_id: str, status: str) -> PlanStepRecord:
        """Move one plan step to ``status`` and stamp updated_at.

        Raises ``ValueError`` on unknown statuses or unknown (run_id, step_id)
        pairs so wiring mistakes surface loudly instead of silently no-opping.
        """
        normalized_status = str(status or "").strip().lower()
        if normalized_status not in self.PLAN_STEP_STATUSES:
            raise ValueError(
                f"invalid plan step status {status!r}; expected one of "
                f"{list(self.PLAN_STEP_STATUSES)}"
            )

        with self._begin_own_transaction():
            record = (
                self._session.query(PlanStepRecord)
                .filter_by(run_id=run_id, step_id=str(step_id))
                .one_or_none()
            )
            if record is None:
                raise ValueError(f"no plan step {step_id!r} for run {run_id!r}")
            record.status = normalized_status
            record.updated_at = datetime.now(UTC)
            return record

    # ------------------------------------------------------------------- read

    def get_plan(self, run_id: str) -> dict[str, Any] | None:
        """Return ``{run_id, strategy, created_at, steps:[...live status]}``.

        Steps come back in declared order with their current live status from
        ``plan_steps`` merged in. ``None`` when the run has no plan artifact.
        """
        plan = self._session.query(RunPlanRecord).filter_by(run_id=run_id).one_or_none()
        if plan is None:
            return None
        steps = (
            self._session.query(PlanStepRecord)
            .filter_by(run_id=run_id)
            .order_by(PlanStepRecord.position.asc(), PlanStepRecord.id.asc())
            .all()
        )
        return {
            "run_id": plan.run_id,
            "strategy": plan.strategy,
            "created_at": iso_z(plan.created_at) if plan.created_at else None,
            "steps": [
                {
                    "id": step.step_id,
                    "position": int(step.position),
                    "title": step.title,
                    "criteria": step.criteria,
                    "budget": step.budget,
                    "status": step.status,
                    "updated_at": iso_z(step.updated_at) if step.updated_at else None,
                }
                for step in steps
            ],
        }
