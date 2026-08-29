"""Memory retention tick tests (plan task 19, batch W4).

Covers the retention tick against a thin in-memory fake of the
``SiteHintRepository`` (real repo lands with task 18) and the orphaned-
embedding sweep against an in-memory SQLite database mirroring the agreed
``logo_embeddings`` / ``run_screenshots`` schema.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

from src.memory.retention import run_retention_tick


class InMemorySiteHintRepository:
    """Thin duck-typed stand-in for ``SiteHintRepository.prune_expired``."""

    def __init__(self, hints: list[dict]) -> None:
        # Each hint: {"id": int, "expires_at": datetime | None}
        self.hints = list(hints)
        self.pruned_ids: list[int] = []

    def prune_expired(self, now: datetime | None = None) -> int:
        now = now or datetime.now(UTC)
        expired = [h for h in self.hints if h["expires_at"] is not None and h["expires_at"] <= now]
        self.pruned_ids = [h["id"] for h in expired]
        self.hints = [h for h in self.hints if h not in expired]
        return len(expired)


@pytest.fixture()
def db_session():
    """In-memory SQLite with minimal logo_embeddings/run_screenshots tables."""
    engine = create_engine("sqlite:///:memory:")
    with engine.connect() as conn:
        conn.execute(text("CREATE TABLE run_screenshots (id INTEGER PRIMARY KEY)"))
        conn.execute(
            text(
                "CREATE TABLE logo_embeddings ("
                "id INTEGER PRIMARY KEY, source_screenshot_id INTEGER)"
            )
        )
        conn.commit()
    factory = sessionmaker(bind=engine)
    session = factory()
    yield session
    session.close()


def _seed_embeddings(session, rows: list[tuple[int, int | None]]) -> None:
    for emb_id, screenshot_id in rows:
        session.execute(
            text("INSERT INTO logo_embeddings (id, source_screenshot_id) VALUES (:i, :s)"),
            {"i": emb_id, "s": screenshot_id},
        )
    session.commit()


class TestHintsPruned:
    def test_stale_hints_removed_and_counted(self) -> None:
        now = datetime.now(UTC)
        repo = InMemorySiteHintRepository(
            [
                {"id": 1, "expires_at": now - timedelta(hours=1)},
                {"id": 2, "expires_at": now - timedelta(seconds=1)},
            ]
        )
        counts = run_retention_tick(repo)
        assert counts == {"hints_pruned": 2, "embeddings_orphaned": 0}
        assert repo.hints == []
        assert repo.pruned_ids == [1, 2]

    def test_fresh_and_never_expiring_hints_survive(self) -> None:
        now = datetime.now(UTC)
        fresh = {"id": 3, "expires_at": now + timedelta(days=7)}
        forever = {"id": 4, "expires_at": None}
        repo = InMemorySiteHintRepository([fresh, forever])
        counts = run_retention_tick(repo)
        assert counts["hints_pruned"] == 0
        assert repo.hints == [fresh, forever]

    def test_boundary_hint_exactly_now_is_pruned(self) -> None:
        now = datetime.now(UTC)
        boundary = {"id": 5, "expires_at": now}
        repo = InMemorySiteHintRepository([boundary])
        assert run_retention_tick(repo)["hints_pruned"] == 1
        assert repo.hints == []


class TestOrphanSweep:
    def test_only_unresolvable_embeddings_deleted(self, db_session) -> None:
        # 10 resolves (kept), 20/30 dangle, NULL never counts as orphan.
        _seed_embeddings(db_session, [(1, 10), (2, 20), (3, 30), (4, None)])
        db_session.execute(text("INSERT INTO run_screenshots (id) VALUES (10)"))
        db_session.commit()

        counts = run_retention_tick(InMemorySiteHintRepository([]), session=db_session)

        assert counts == {"hints_pruned": 0, "embeddings_orphaned": 2}
        remaining = [
            row
            for row in db_session.execute(
                text("SELECT id FROM logo_embeddings ORDER BY id")
            ).fetchall()
        ]
        assert remaining == [(1,), (4,)]

    def test_no_orphans_yields_zero(self, db_session) -> None:
        _seed_embeddings(db_session, [(1, 7)])
        db_session.execute(text("INSERT INTO run_screenshots (id) VALUES (7)"))
        db_session.commit()
        counts = run_retention_tick(InMemorySiteHintRepository([]), session=db_session)
        assert counts["embeddings_orphaned"] == 0

    def test_missing_tables_degrade_to_noop(self, db_session) -> None:
        # Pre-task-18 database: tables absent -> sweep is a silent no-op.
        db_session.execute(text("DROP TABLE logo_embeddings"))
        db_session.commit()
        counts = run_retention_tick(InMemorySiteHintRepository([]), session=db_session)
        assert counts == {"hints_pruned": 0, "embeddings_orphaned": 0}

    def test_combined_counts_across_both_sweeps(self, db_session) -> None:
        now = datetime.now(UTC)
        repo = InMemorySiteHintRepository(
            [{"id": 1, "expires_at": now - timedelta(minutes=5)}]
        )
        _seed_embeddings(db_session, [(9, 999)])
        counts = run_retention_tick(repo, session=db_session)
        assert counts == {"hints_pruned": 1, "embeddings_orphaned": 1}


# TODO(plan-T19-integrate): once task 18's SiteHintRepository and the
# logo_embeddings migration land, register this tick in src/api/app.py
# lifespan() beside RunRepository.cleanup_old_artifacts, passing the real
# repository + session; replace InMemorySiteHintRepository here with the
# real repository in an integration test.
