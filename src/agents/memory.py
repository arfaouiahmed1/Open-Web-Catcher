"""Agent-facing helpers for site memory retrieval and persistence."""

from __future__ import annotations

from src.memory.long_term import LongTermMemory
from src.memory.short_term import ShortTermMemory
from src.utils.logging import get_logger
from src.utils.observability import RunObserver

logger = get_logger(__name__)


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
    normalized_status = str(status or "").strip().lower()
    if normalized_status not in {"success", "partial"}:
        if observer is not None:
            observer.emit(
                "memory_skipped",
                f"Skipped site memory save for {page_type}",
                details={"page_type": page_type, "status": normalized_status or status},
            )
        return
    try:
        trace = observer.trace() if observer is not None else None
        actor = observer.actor if observer is not None else ""
        stored = memory.remember(
            url=url,
            page_type=page_type,
            status=normalized_status,
            payload=payload,
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
                },
            )
    except Exception as exc:  # pragma: no cover - runtime safeguard
        logger.warning("Could not save site memory for %s: %s", url, exc)
        if observer is not None:
            observer.emit("memory_save_failed", str(exc), status="warning", details={"url": url})
