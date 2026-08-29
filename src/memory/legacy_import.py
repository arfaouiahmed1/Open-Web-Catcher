"""One-shot data migration: legacy site-memory stores -> pgvector site_hints.

Plan task 18, phase 2. Before the legacy stores are decommissioned this
module imports every accumulated memory artifact into the relational hint
store so nothing is lost at cutover:

- ``data/site_memory.db`` (SQLite ``site_memory_entries`` rows written by
  ``LongTermMemory.remember``) — aggregated per (domain, page_type).
- ``data/site_memory_profiles.json`` (the JSON profile store written by
  ``LongTermMemory.upsert_profile`` and the Node ``memory_update`` tool).

Both sources are distilled through :func:`src.memory.site_hint_writer.summarize_raw_entry`
so imported hints carry the same shape as freshly written ones. The importer
is idempotent-safe to re-run (upserts blend), but it is designed to run ONCE
from alembic revision ``20260826_0022`` before old-store writes stop.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from src.memory.long_term import _normalize_domain
from src.memory.site_hint_writer import summarize_raw_entry
from src.storage.models import SITE_HINT_PAGE_TYPES
from src.storage.repositories import SiteHintRepository

logger = logging.getLogger(__name__)

#: Default locations of the legacy stores (repo-root relative).
DEFAULT_LEGACY_DB_PATH = "data/site_memory.db"
DEFAULT_LEGACY_PROFILES_PATH = "data/site_memory_profiles.json"

#: Fresh TTL granted to imported hints.
IMPORT_TTL_DAYS = 30

#: Caps applied to aggregated hint fields (match writer limits).
_MAX_NAVIGATION_STEPS = 12
_MAX_SELECTORS = 24

_ENV_DB_PATH = "LEGACY_SITE_MEMORY_DB"
_ENV_PROFILES_PATH = "LEGACY_SITE_MEMORY_PROFILES_JSON"


def resolve_legacy_paths() -> tuple[Path | None, Path | None]:
    """Resolve legacy store paths from env overrides or repo defaults."""
    db_path = Path(os.getenv(_ENV_DB_PATH) or DEFAULT_LEGACY_DB_PATH)
    profiles_path = Path(
        os.getenv(_ENV_PROFILES_PATH)
        or str(db_path.with_name(f"{db_path.stem}_profiles.json"))
    )
    return db_path, profiles_path


def _coerce_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def _normalize_page_type(page_type: Any) -> str:
    candidate = str(page_type or "").strip().lower()
    return candidate if candidate in SITE_HINT_PAGE_TYPES else "unknown"


class _HintAccumulator:
    """Aggregates legacy observations for one (domain, page_type) pair."""

    def __init__(self) -> None:
        self.total = 0
        self.successes = 0
        self.latest_entry: dict[str, Any] | None = None
        self.latest_created_at = ""
        self.navigation_steps: list[str] = []
        self.selectors: list[str] = []
        self.summaries: list[str] = []

    def add_entry(self, data: dict[str, Any], created_at: str) -> None:
        self.total += 1
        self.successes += 1 if bool(data.get("success")) else 0
        # Prefer playbook steps from SUCCESSFUL runs; they are the reusable ones.
        if bool(data.get("success")):
            self.navigation_steps.extend(_coerce_list(data.get("playbook_steps")))
            self.navigation_steps.extend(_coerce_list(data.get("tool_steps")))
        self.selectors.extend(_coerce_list(data.get("selectors")))
        distilled = summarize_raw_entry(data)
        if distilled["summary_text"]:
            self.summaries.append(distilled["summary_text"])
        if created_at >= self.latest_created_at:
            self.latest_created_at = created_at
            self.latest_entry = data

    def add_profile(self, profile: dict[str, Any]) -> None:
        # Profiles carry curated long-lived lists; treat them like observations.
        self.navigation_steps.extend(_coerce_list(profile.get("playbook_steps")))
        self.navigation_steps.extend(_coerce_list(profile.get("navigation_hints")))
        self.selectors.extend(_coerce_list(profile.get("selectors")))
        reason = str(profile.get("last_refresh_reason", "") or "").strip()
        updated = str(profile.get("updated_at", "") or "").strip()
        if reason:
            drift = "ui drift detected" if profile.get("ui_change_detected") else ""
            summary = " | ".join(part for part in (reason, drift) if part)
            self.summaries.append(f"remembered profile ({updated}): {summary}"[:700])
            if updated >= self.latest_created_at:
                self.latest_created_at = updated

    def build(self) -> dict[str, Any]:
        rate = (self.successes / self.total) if self.total else 0.0
        summary_text = ""
        if self.summaries:
            # Latest observation first (they were appended in scan order which
            # is created-at order for the DB source).
            prefix = (
                "imported from legacy memory "
                f"({self.total} runs, {self.successes} succeeded): "
            )
            summary_text = prefix
            summary_text += " ;; ".join(dict.fromkeys(self.summaries))[:700 - len(prefix)]
        return {
            "summary_text": summary_text,
            "navigation_steps": _dedupe(self.navigation_steps)[:_MAX_NAVIGATION_STEPS],
            "selectors": _dedupe(self.selectors)[:_MAX_SELECTORS],
            "success_rate": round(rate, 4),
        }


def import_legacy_site_memory(
    session: Session,
    *,
    db_path: str | Path | None = None,
    profiles_path: str | Path | None = None,
    ttl_days: int = IMPORT_TTL_DAYS,
) -> dict[str, int]:
    """Import both legacy stores into ``site_hints``; returns import counts."""
    if db_path is None or profiles_path is None:
        resolved_db, resolved_profiles = resolve_legacy_paths()
        if db_path is None:
            db_path = resolved_db
        if profiles_path is None:
            profiles_path = resolved_profiles
    db_file = Path(db_path)
    profiles_file = Path(profiles_path)

    accumulators: dict[tuple[str, str], _HintAccumulator] = {}

    def _acc_for(domain: str, page_type: str) -> _HintAccumulator:
        normalized_domain = _normalize_domain(domain) or str(domain or "").lower().strip()
        key = (normalized_domain, _normalize_page_type(page_type))
        if key not in accumulators:
            accumulators[key] = _HintAccumulator()
        return accumulators[key]

    entries_seen = 0
    if db_file is not None and db_file.exists():
        conn = sqlite3.connect(str(db_file))
        try:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            }
            if "site_memory_entries" in tables:
                rows = conn.execute(
                    """
                    SELECT domain, page_type, data, created_at
                    FROM site_memory_entries
                    ORDER BY created_at ASC
                    """
                ).fetchall()
                for domain, page_type, data_json, created_at in rows:
                    try:
                        data = json.loads(data_json or "{}")
                    except json.JSONDecodeError:
                        continue
                    if not isinstance(data, dict):
                        continue
                    try:
                        _acc_for(str(domain or ""), str(page_type or "")).add_entry(
                            data, str(created_at or "")
                        )
                        entries_seen += 1
                    except Exception:  # noqa: BLE001 - one poison row must not abort the migration
                        logger.warning(
                            "Skipping unimportable legacy entry (domain=%s page_type=%s)",
                            domain,
                            page_type,
                            exc_info=True,
                        )
                        continue
            else:
                logger.warning(
                    "Legacy DB %s has no site_memory_entries table; skipping", db_file
                )
        finally:
            conn.close()

    profiles_seen = 0
    if profiles_file is not None and profiles_file.exists():
        try:
            store = json.loads(profiles_file.read_text(encoding="utf-8") or "{}")
        except json.JSONDecodeError:
            logger.warning("Legacy profiles JSON %s is invalid; skipping", profiles_file)
            store = {}
        for profile in (store.get("profiles") or {}).values():
            if not isinstance(profile, dict):
                continue
            profiles_seen += 1
            _acc_for(
                str(profile.get("domain", "") or ""),
                str(profile.get("page_type", "") or ""),
            ).add_profile(profile)

    hints_upserted = 0
    repo = SiteHintRepository(session)
    expires = datetime.now(UTC) + timedelta(days=max(int(ttl_days), 1))
    for (domain, page_type), acc in sorted(accumulators.items()):
        if not domain:
            logger.warning("Skipping legacy hint with empty domain (%s)", page_type)
            continue
        payload = acc.build()
        repo.upsert_hint(
            domain=domain,
            page_type=page_type,
            summary_text=payload["summary_text"],
            navigation_steps=payload["navigation_steps"],
            selectors=payload["selectors"],
            success_rate=payload["success_rate"],
            ttl_expires_at=expires,
        )
        hints_upserted += 1

    return {
        "entries_seen": entries_seen,
        "profiles_seen": profiles_seen,
        "hints_upserted": hints_upserted,
    }
