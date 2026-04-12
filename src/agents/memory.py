"""Agent-facing helpers for site memory retrieval and persistence."""

from __future__ import annotations

from typing import Any

from src.memory.long_term import LongTermMemory
from src.memory.short_term import ShortTermMemory
from src.utils.logging import get_logger
from src.utils.observability import RunObserver

logger = get_logger(__name__)


def _list_size(payload: dict[str, Any], key: str) -> int:
    values = payload.get(key, []) if isinstance(payload, dict) else []
    return len(values) if isinstance(values, list) else 0


def _failed_run_has_reusable_signals(*, page_type: str, payload: dict[str, Any]) -> bool:
    normalized_page_type = str(page_type or "").strip().lower()
    if normalized_page_type != "landing_page":
        return False

    run_memory = payload.get("run_memory", {}) if isinstance(payload, dict) else {}
    if not isinstance(run_memory, dict):
        run_memory = {}
    common_memory = run_memory.get("common", run_memory)
    if not isinstance(common_memory, dict):
        common_memory = {}

    if _list_size(run_memory, "hosting_candidate_urls") > 0:
        return True
    if _list_size(payload, "hosting_pages") > 0:
        return True
    if _list_size(common_memory, "url_patterns") >= 2 and _list_size(common_memory, "critical_links") >= 3:
        return True
    if _list_size(common_memory, "selectors") >= 2 and _list_size(common_memory, "critical_links") >= 3:
        return True
    return False


def build_memory_context(
    memory: LongTermMemory | None,
    *,
    url: str,
    page_type: str,
    prompt_limit: int,
    observer: RunObserver | None = None,
) -> str:
    if memory is None:
        return ""
    try:
        context = memory.build_prompt_context(url=url, page_type=page_type, limit=prompt_limit)
        if context and observer is not None:
            observer.emit(
                "memory_loaded",
                f"Loaded site memory hints for {page_type}",
                details={"page_type": page_type, "url": url, "hint_preview": context[:600]},
            )
        return context
    except Exception as exc:  # pragma: no cover - runtime safeguard
        logger.warning("Could not load site memory for %s: %s", url, exc)
        if observer is not None:
            observer.emit("memory_load_failed", str(exc), status="warning", details={"url": url})
        return ""


def attach_memory_context(initial_message: str, memory_context: str) -> str:
    if not memory_context.strip():
        return initial_message
    return (
        f"{initial_message}\n\n"
        "Prior site memory is available below. Use it only as soft hints and re-verify everything on the live page.\n\n"
        f"{memory_context}"
    )


def remember_agent_run(
    memory: LongTermMemory | None,
    *,
    url: str,
    page_type: str,
    status: str,
    payload: dict,
    observer: RunObserver | None = None,
    short_memory: ShortTermMemory | None = None,
) -> None:
    if memory is None:
        return

    payload_for_memory = dict(payload or {})
    if short_memory is not None:
        payload_for_memory.setdefault(
            "run_memory",
            short_memory.export_run_memory(page_type=page_type),
        )

    normalized_status = str(status or "").strip().lower()
    failure_with_signals = (
        normalized_status in {"failed", "timeout", "site_dead", "redirect"}
        and _failed_run_has_reusable_signals(page_type=page_type, payload=payload_for_memory)
    )
    if normalized_status not in {"success", "partial"} and not failure_with_signals:
        if observer is not None:
            observer.emit(
                "memory_skipped",
                f"Skipped site memory save for {page_type}",
                details={
                    "page_type": page_type,
                    "status": normalized_status or status,
                    "reason": "run_not_successful_and_no_reusable_failure_signals",
                },
            )
        return

    try:
        trace = observer.trace() if observer is not None else None
        actor = observer.actor if observer is not None else ""
        stored = memory.remember(
            url=url,
            page_type=page_type,
            status=normalized_status,
            payload=payload_for_memory,
            trace=trace,
            actor=actor,
            run_id=observer.run_id if observer is not None else "",
            short_memory_summary=short_memory.summary() if short_memory is not None else "",
        )
        if observer is not None:
            observer.emit(
                "memory_saved",
                f"Stored site memory for {page_type}",
                details={
                    "page_type": page_type,
                    "tool_sequence": stored.get("tool_sequence", []),
                    "server_labels": stored.get("server_labels", []),
                    "critical_links": stored.get("critical_links", []),
                    "url_patterns": stored.get("url_patterns", []),
                    "status": normalized_status,
                    "persisted_from_failed_run": bool(
                        normalized_status not in {"success", "partial"} and failure_with_signals
                    ),
                },
            )
    except Exception as exc:  # pragma: no cover - runtime safeguard
        logger.warning("Could not save site memory for %s: %s", url, exc)
        if observer is not None:
            observer.emit("memory_save_failed", str(exc), status="warning", details={"url": url})
