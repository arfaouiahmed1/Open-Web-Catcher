"""Site-hint summarizer: build_site_memory_entry -> pgvector site_hints rows.

Plan task 18, phase 1. This module is the WRITE path of the new relational
long-term memory: it derives ``summary_text`` and ``navigation_steps`` from
the existing ``build_site_memory_entry`` data shape (src/memory/long_term.py)
and upserts them through :class:`src.storage.repositories.SiteHintRepository`.

Phase-2 scope deliberately NOT here: deleting site_memory.db / JSON profile
stores, agent tool registration (``memory_search``), or run-start injection.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy.orm import Session

from src.memory.long_term import _normalize_domain
from src.storage.models import SiteHintRecord
from src.storage.repositories import SiteHintRepository

#: Hints older than this stop being injected at run start (phase 2 consumer).
DEFAULT_HINT_TTL_DAYS = 30

#: Cap on navigation steps stored per hint; keeps prompt context bounded.
MAX_NAVIGATION_STEPS = 12

#: Cap on summary text length (matches short_memory_summary's 700-char cap).
MAX_SUMMARY_LENGTH = 700


def summarize_raw_entry(raw_entry: dict[str, Any]) -> dict[str, Any]:
    """Distill a ``build_site_memory_entry`` payload into hint columns.

    Returns ``{"summary_text", "navigation_steps", "selectors",
    "success_rate"}``:
    - ``summary_text``: one-line outcome + what worked, for prompt context.
    - ``navigation_steps``: ordered tool playbook that produced the outcome.
    """
    page_type = str(raw_entry.get("page_type", "unknown") or "unknown")
    status = str(raw_entry.get("status", "") or "")
    success = bool(raw_entry.get("success"))

    summary_parts: list[str] = [f"{page_type} run {status}".strip()]
    short_summary = str(raw_entry.get("short_memory_summary", "") or "").strip()
    result_summary = str(raw_entry.get("result_summary", "") or "").strip()
    detail = short_summary or result_summary
    if detail:
        summary_parts.append(detail)
    activated = raw_entry.get("activated_servers") or []
    if activated:
        summary_parts.append(f"servers that worked: {', '.join(str(s) for s in activated[:6])}")
    failure_cues = raw_entry.get("failure_cues") or []
    if not success and failure_cues:
        summary_parts.append(f"failure cues: {'; '.join(str(c) for c in failure_cues[:3])}")

    summary_text = " | ".join(part for part in summary_parts if part)[:MAX_SUMMARY_LENGTH]

    # Ordered navigation steps: playbook entries carry seq + target detail;
    # fall back to bare tool steps, then explicit navigation targets.
    navigation_steps: list[str] = [
        str(step) for step in (raw_entry.get("playbook_steps") or []) if step
    ]
    if not navigation_steps:
        navigation_steps = [str(step) for step in (raw_entry.get("tool_steps") or []) if step]
    if not navigation_steps:
        navigation_steps = [
            str(target) for target in (raw_entry.get("navigation_targets") or []) if target
        ]
    navigation_steps = navigation_steps[:MAX_NAVIGATION_STEPS]

    selectors = [str(selector) for selector in (raw_entry.get("selectors") or []) if selector]

    return {
        "summary_text": summary_text,
        "navigation_steps": navigation_steps,
        "selectors": selectors,
        "success_rate": 1.0 if success else 0.0,
    }


def _hint_domain(domain_or_url: str) -> str:
    """Normalize a domain OR full URL to a bare hostname."""
    host = _normalize_domain(str(domain_or_url or ""))
    return host or str(domain_or_url or "").lower().strip()


def write_site_hint(
    session: Session,
    *,
    domain: str,
    page_type: str,
    raw_entry: dict[str, Any],
    embedding: list[float] | None = None,
    ttl_expires_at: datetime | None = None,
    ttl_days: int = DEFAULT_HINT_TTL_DAYS,
    repo: SiteHintRepository | None = None,
) -> SiteHintRecord:
    """Summarize ``raw_entry`` (build_site_memory_entry shape) and upsert it.

    ``embedding`` is optional so writes work before an encoder is pinned at
    the call site (phase 2 wires CLIP ViT-B/32 => vector(512)).
    """
    normalized_domain = _hint_domain(domain)
    distilled = summarize_raw_entry(raw_entry)

    entry_page_type = str(raw_entry.get("page_type", "") or "")
    effective_page_type = page_type or entry_page_type or "unknown"

    expires = ttl_expires_at or (datetime.now(UTC) + timedelta(days=int(ttl_days)))

    repository = repo or SiteHintRepository(session)
    return repository.upsert_hint(
        domain=normalized_domain,
        page_type=effective_page_type,
        summary_text=distilled["summary_text"],
        navigation_steps=distilled["navigation_steps"],
        selectors=distilled["selectors"],
        success_rate=distilled["success_rate"],
        embedding=embedding,
        ttl_expires_at=expires,
    )
