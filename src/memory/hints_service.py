"""Hint retrieval service: search + run-start injection (plan task 18, phase 2).

Single read layer over :class:`src.storage.repositories.SiteHintRepository`
shared by:

- the agentic ``memory_search`` tool (:mod:`src.memory.agentic_tool`),
- the FastAPI memory endpoints (``GET /memory``, ``POST /memory/search``),
- run-start hint injection in ``run_agent_loop`` (src/agents/base.py).

This replaces per-turn context stuffing: hints are injected ONCE at run start,
and the agent pulls additional memory on demand via the tool.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from src.memory.long_term import _normalize_domain
from src.storage.models import SiteHintRecord
from src.storage.repositories import SiteHintRepository

#: Cap on the injected context block, matching other prompt-context budgets.
MAX_CONTEXT_CHARS = 2400


def _hint_tokens(text: str) -> set[str]:
    lowered = str(text or "").lower()
    return {token for token in lowered.replace("`", " ").split() if len(token) >= 3}


def _record_text(record: SiteHintRecord) -> str:
    return " ".join(
        (
            record.summary_text or "",
            " ".join(record.navigation_steps or []),
            " ".join(record.selectors or []),
        )
    )


def search_site_hints(
    session: Session,
    query: str,
    *,
    domain: str | None = None,
    page_type: str | None = None,
    limit: int = 8,
) -> list[SiteHintRecord]:
    """Keyword-ranked hint search (semantic ranking activates once embeddings
    are pinned; until then this is deterministic lexical scoring)."""
    tokens = _hint_tokens(query)
    candidates = SiteHintRepository(session).get_hints(
        domain=domain or None,
        page_type=page_type or None,
        limit=max(int(limit) * 8, 50),
    )
    if not tokens:
        scored = [(0, _recency(record), record) for record in candidates]
    else:
        scored = []
        for record in candidates:
            haystack = _hint_tokens(_record_text(record))
            overlap = len(tokens & haystack)
            if record.domain and record.domain in _hint_tokens(query):
                overlap += 2  # exact domain mention is a strong signal
            if overlap > 0:
                scored.append((overlap, _recency(record), record))
    # Highest token overlap first; ties broken by recency.
    scored.sort(key=lambda item: (-item[0], -item[1]))
    return [record for _, _, record in scored[: max(int(limit), 1)]]


def _recency(record: SiteHintRecord) -> float:
    try:
        return record.updated_at.timestamp() if record.updated_at else 0.0
    except (OSError, ValueError):  # pragma: no cover - clock edge safety
        return 0.0


def serialize_hint(record: SiteHintRecord) -> dict[str, Any]:
    """JSON-safe projection used by the tool payload and the API endpoints."""
    return {
        "domain": record.domain,
        "page_type": record.page_type,
        "summary_text": record.summary_text or "",
        "navigation_steps": list(record.navigation_steps or []),
        "selectors": list(record.selectors or []),
        "success_rate": float(record.success_rate or 0.0),
        "updated_at": record.updated_at.isoformat() if record.updated_at else "",
        "ttl_expires_at": (
            record.ttl_expires_at.isoformat() if record.ttl_expires_at else None
        ),
    }


def format_hints_block(records: list[SiteHintRecord]) -> str:
    """Render hints as a compact prompt block for run-start injection."""
    if not records:
        return ""
    lines = [
        "SITE HINTS (remembered playbooks for this domain)",
        "Use as soft hints only; re-verify everything on the live page.",
    ]
    for record in records:
        rate_pct = round(float(record.success_rate or 0.0) * 100)
        lines.append(
            f"- [{record.domain} / {record.page_type}, success~{rate_pct}%] "
            f"{(record.summary_text or '').strip()[:300]}"
        )
        steps = [str(step) for step in (record.navigation_steps or [])][:5]
        if steps:
            lines.append("  playbook: " + " -> ".join(f"`{step}`" for step in steps))
        selectors = [str(item) for item in (record.selectors or [])][:4]
        if selectors:
            lines.append("  remembered selectors: " + ", ".join(f"`{item}`" for item in selectors))
    return "\n".join(lines)[:MAX_CONTEXT_CHARS]


def build_run_start_hint_context(
    url: str,
    page_type: str = "",
    *,
    limit: int = 4,
    session_factory: Any | None = None,
) -> str:
    """Build the ONCE-per-run hint block from site_hints.

    Prefers an exact ``(domain, page_type)`` match; falls back to any hint for
    the domain. Returns "" when nothing is stored so callers skip injection.
    """
    from src.storage.database import SessionLocal

    factory = session_factory or SessionLocal
    domain = _normalize_domain(url) or str(url or "").lower().strip()
    if not domain:
        return ""
    session = factory()
    try:
        repo = SiteHintRepository(session)
        records = repo.get_hints(domain=domain, page_type=page_type or None, limit=limit)
        if not records and page_type:
            records = repo.get_hints(domain=domain, limit=limit)
        return format_hints_block(records)
    finally:
        session.close()


def run_memory_search(
    query: str,
    *,
    domain: str | None = None,
    page_type: str = "",
    limit: int = 8,
    session_factory: Any | None = None,
) -> dict[str, Any]:
    """Execute ``memory_search`` and return a JSON-safe payload."""
    normalized_query = str(query or "").strip()
    if not normalized_query:
        return {"ok": False, "error": "memory_search requires a non-empty query", "results": []}
    normalized_domain = _normalize_domain(normalized_query) or _normalize_domain(domain or "") or (
        str(domain or "").lower().strip() or None
    )
    from src.storage.database import SessionLocal

    factory = session_factory or SessionLocal
    session = factory()
    try:
        records = search_site_hints(
            session,
            normalized_query,
            domain=normalized_domain,
            page_type=str(page_type or "").strip() or None,
            limit=limit,
        )
        return {
            "ok": True,
            "query": normalized_query,
            "domain": normalized_domain,
            "page_type": str(page_type or "").strip() or None,
            "results": [serialize_hint(record) for record in records],
            "memory_first_recommendation": (
                "Reuse remembered selectors/url patterns first, then escalate to heavy "
                "tools only if they fail on the live page."
                if records
                else "No matching hints stored; explore lightweight evidence first and "
                "persist what you learn via memory_update."
            ),
        }
    except Exception as exc:  # pragma: no cover - runtime safeguard
        return {"ok": False, "error": f"memory_search failed: {exc}", "results": []}
    finally:
        session.close()
