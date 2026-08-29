"""Baseline characterization for ``BackgroundJobRepository.claim_next`` (Task 5).

These tests pin the CURRENT observable contract of ``claim_next`` on unchanged
code: oldest-by-created_at candidate wins, and claiming mutates exactly the
fields the legacy implementation mutates. They must pass BEFORE any fix lands.

Fixtures here are deliberately self-contained (file-based SQLite in a pytest
``tmp_path``, i.e. tempfile-backed, NOT in-memory) so concurrent access hits
real OS-level file locking; they do not rely on tests/conftest.py fixtures.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from src.storage.models import BackgroundJobRecord, Base
from src.storage.repositories import BackgroundJobRepository


@pytest.fixture()
def job_session_factory(tmp_path: Path) -> sessionmaker:
    """File-based SQLite engine + sessionmaker over a fresh temp database.

    A real file (not ``sqlite://``) is required so that multiple sessions map
    to separate connections contending on actual OS-level locks.
    """
    db_path = tmp_path / "jobs-baseline.db"
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
        poolclass=NullPool,
        future=True,
    )
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(
        bind=engine,
        autoflush=False,
        expire_on_commit=False,
        future=True,
    )
    try:
        yield factory
    finally:
        engine.dispose()


def _seed_jobs(factory: sessionmaker, count: int) -> list[int]:
    """Insert ``count`` queued jobs with strictly increasing created_at."""
    base = datetime(2026, 8, 22, 12, 0, 0)
    ids: list[int] = []
    with factory() as session:
        for i in range(count):
            record = BackgroundJobRecord(
                job_id=f"job-{i}",
                run_id=f"run-{i}",
                job_type="workflow",
                status="queued",
                url=f"https://example.com/{i}",
                actor="baseline-test",
                payload_json={},
                max_attempts=2,
                created_at=base + timedelta(seconds=i),
            )
            session.add(record)
            session.flush()
            ids.append(record.id)
        session.commit()
    return ids


def test_claim_next_returns_oldest_and_marks_running(job_session_factory: sessionmaker) -> None:
    seeded = _seed_jobs(job_session_factory, 3)
    assert len(seeded) == 3

    with job_session_factory() as session:
        repo = BackgroundJobRepository(session)
        claimed = repo.claim_next(lease_seconds=90)

        assert claimed is not None
        # Oldest-by-created_at wins.
        assert claimed.run_id == "run-0"
        assert claimed.status == "running"
        # Exact field-mutation semantics of the current implementation.
        assert claimed.attempts == 1
        assert claimed.started_at is not None
        assert claimed.error_text == ""
        assert claimed.heartbeat_at is not None
        assert claimed.lease_expires_at is not None
        assert claimed.started_at <= claimed.heartbeat_at <= claimed.lease_expires_at

    # Mutation is committed and visible from an independent session.
    with job_session_factory() as session:
        row = session.query(BackgroundJobRecord).filter_by(run_id="run-0").one()
        assert row.status == "running"
        assert row.attempts == 1
        others = (
            session.query(BackgroundJobRecord)
            .filter(BackgroundJobRecord.run_id != "run-0")
            .all()
        )
        assert {r.run_id for r in others} == {"run-1", "run-2"}
        assert all(r.status == "queued" for r in others)


def test_claim_next_drains_in_created_at_order_then_returns_none(
    job_session_factory: sessionmaker,
) -> None:
    _seed_jobs(job_session_factory, 3)

    with job_session_factory() as session:
        repo = BackgroundJobRepository(session)
        first = repo.claim_next()
        second = repo.claim_next()
        third = repo.claim_next()
        exhausted = repo.claim_next()

        assert [r.run_id for r in (first, second, third)] == ["run-0", "run-1", "run-2"]
        assert all(r.status == "running" for r in (first, second, third))
        assert exhausted is None


def test_claim_next_claims_retrying_jobs_too(job_session_factory: sessionmaker) -> None:
    base = datetime(2026, 8, 22, 12, 0, 0)
    with job_session_factory() as session:
        session.add(
            BackgroundJobRecord(
                job_id="job-retry",
                run_id="run-retry",
                job_type="workflow",
                status="retrying",
                url="https://example.com/retry",
                actor="baseline-test",
                payload_json={},
                attempts=1,
                max_attempts=2,
                created_at=base,
            )
        )
        session.commit()

    with job_session_factory() as session:
        claimed = BackgroundJobRepository(session).claim_next()
        assert claimed is not None
        assert claimed.run_id == "run-retry"
        assert claimed.status == "running"
        # attempts increments from the existing value.
        assert claimed.attempts == 2


def test_claim_next_lease_floor_is_five_seconds(job_session_factory: sessionmaker) -> None:
    _seed_jobs(job_session_factory, 1)
    before = datetime.now(UTC)

    with job_session_factory() as session:
        claimed = BackgroundJobRepository(session).claim_next(lease_seconds=0)
        assert claimed is not None
        assert claimed.lease_expires_at is not None
        delta = (claimed.lease_expires_at - claimed.started_at).total_seconds()
        # Current semantics: lease floor is max(5, lease_seconds).
        assert 4.5 <= delta <= 10.0, f"unexpected lease length {delta}s"
        # Sanity: claim happened around 'now'.
        assert claimed.started_at >= before - timedelta(seconds=5)


def test_claim_next_preserves_existing_started_at(job_session_factory: sessionmaker) -> None:
    original_start = datetime(2026, 8, 21, 8, 30, 0, tzinfo=UTC)
    with job_session_factory() as session:
        session.add(
            BackgroundJobRecord(
                job_id="job-resumed",
                run_id="run-resumed",
                job_type="workflow",
                status="retrying",
                url="https://example.com/resumed",
                actor="baseline-test",
                payload_json={},
                started_at=original_start,
                attempts=1,
                max_attempts=3,
                created_at=original_start,
            )
        )
        session.commit()

    with job_session_factory() as session:
        claimed = BackgroundJobRepository(session).claim_next()
        assert claimed is not None
        # started_at is only set when previously NULL ("started_at or now").
        assert claimed.started_at == original_start
