"""Legacy memory store migration round-trip (plan task 18, phase 2).

Builds fixture ``site_memory.db`` (SQLite) and ``site_memory_profiles.json``
stores in-test, runs the one-shot importer, and asserts every accumulated
memory artifact survives into summarized ``site_hints`` rows before the old
stores are removed.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.memory.legacy_import import import_legacy_site_memory
from src.storage.models import Base, SiteHintRecord
from src.storage.repositories import SiteHintRepository


@pytest.fixture()
def session_factory():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
        future=True,
    )
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)
    try:
        yield factory
    finally:
        engine.dispose()


def _build_legacy_db(path, entries: list[dict]) -> None:
    conn = sqlite3.connect(str(path))
    try:
        conn.execute(
            """
            CREATE TABLE site_memory_entries (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT NOT NULL,
                page_type TEXT NOT NULL,
                status TEXT NOT NULL,
                run_id TEXT NOT NULL,
                url TEXT NOT NULL,
                success INTEGER NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT
            )
            """
        )
        now = datetime.now(UTC)
        for index, entry in enumerate(entries):
            created = (now - timedelta(days=10 - index)).isoformat()
            expires = (now + timedelta(days=80)).isoformat()
            conn.execute(
                """
                INSERT INTO site_memory_entries
                (domain, page_type, status, run_id, url, success, data, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry["domain"],
                    entry["page_type"],
                    entry["status"],
                    "run-1",
                    entry["url"],
                    1 if entry["success"] else 0,
                    json.dumps(entry),
                    created,
                    expires,
                ),
            )
        conn.commit()
    finally:
        conn.close()


def _entry(**overrides) -> dict:
    entry = {
        "domain": "legacy.tv",
        "url": "https://legacy.tv/watch",
        "page_type": "landing_page",
        "status": "success",
        "success": True,
        "selectors": ["title=Live Matches"],
        "playbook_steps": ["1: navigate used url=https://legacy.tv"],
        "tool_steps": ["navigate(url=https://legacy.tv)"],
        "short_memory_summary": "found 3 hosting candidates via nav bar",
    }
    entry.update(overrides)
    return entry


def test_migration_round_trip_preserves_accumulated_memory(
    tmp_path, session_factory
) -> None:
    db_path = tmp_path / "site_memory.db"
    profiles_path = tmp_path / "site_memory_profiles.json"

    _build_legacy_db(
        db_path,
        [
            _entry(),
            _entry(status="failed", success=False, failure_cues=["stop_reason=max_tool_calls"]),
            _entry(page_type="hosting_page", url="https://legacy.tv/hosting"),
        ],
    )
    profiles_path.write_text(
        json.dumps(
            {
                "version": 1,
                "profiles": {
                    "legacy.tv::landing_page": {
                        "domain": "legacy.tv",
                        "page_type": "landing_page",
                        "last_refresh_reason": "auto refresh from landing_page (success)",
                        "updated_at": datetime.now(UTC).isoformat(),
                        "selectors": ["channel=Sports 1"],
                        "playbook_steps": ["2: click used selector=.play"],
                    },
                    # Unknown page types collapse onto 'unknown' rather than dying.
                    "other.tv::weird_type": {
                        "domain": "other.tv",
                        "page_type": "weird_type",
                        "selectors": [],
                        "playbook_steps": ["1: navigate used url=https://other.tv"],
                    },
                },
            }
        ),
        encoding="utf-8",
    )

    session = session_factory()
    try:
        counts = import_legacy_site_memory(
            session, db_path=db_path, profiles_path=profiles_path
        )
        assert counts == {"entries_seen": 3, "profiles_seen": 2, "hints_upserted": 3}

        repo = SiteHintRepository(session)
        landing = repo.get_hints(domain="legacy.tv", page_type="landing_page")
        assert len(landing) == 1
        hint = landing[0]

        # Success playbook from successful runs survived; failure cues are in summary.
        assert any("1: navigate" in step for step in hint.navigation_steps)
        assert any("2: click used selector=.play" in step for step in hint.navigation_steps)
        assert "title=Live Matches" in hint.selectors
        assert "channel=Sports 1" in hint.selectors
        assert 0.0 < float(hint.success_rate) < 1.0  # 2/3 legacy runs succeeded
        assert "imported from legacy memory (2 runs, 1 succeeded)" in hint.summary_text

        hosting = repo.get_hints(domain="legacy.tv", page_type="hosting_page")
        assert len(hosting) == 1

        unknown = repo.get_hints(domain="other.tv")
        assert len(unknown) == 1
        assert unknown[0].page_type == "unknown"

        # TTL was granted so retention keeps imported hints fresh.
        assert hint.ttl_expires_at is not None
        assert hint.ttl_expires_at > datetime.now(UTC)

        # Re-running the one-shot import must not duplicate rows.
        counts_again = import_legacy_site_memory(
            session, db_path=db_path, profiles_path=profiles_path
        )
        assert counts_again["hints_upserted"] == 3
        total_rows = session.query(SiteHintRecord).count()
        assert total_rows == 3
    finally:
        session.close()


def test_migration_skips_missing_stores_gracefully(session_factory, tmp_path) -> None:
    session = session_factory()
    try:
        counts = import_legacy_site_memory(
            session,
            db_path=tmp_path / "missing.db",
            profiles_path=tmp_path / "missing.json",
        )
        assert counts == {"entries_seen": 0, "profiles_seen": 0, "hints_upserted": 0}
    finally:
        session.close()
