"""Concurrency race proof for ``BackgroundJobRepository.claim_next`` (Task 5).

Failing-first discipline: against the legacy implementation (plain SELECT
``.first()`` -> mutate -> commit, no row lock) this test intermittently fails
with double-claims or worker crashes. After the atomic dialect-aware fix it
must pass repeatedly (3 consecutive greens required).

Setup: 20 queued jobs, 8 threads each calling ``claim_next`` in a loop until
exhausted. Every job must be claimed EXACTLY once: duplicates or lost jobs are
failures. The database is file-based SQLite in a pytest ``tmp_path``
(tempfile-backed) so threads contend on real OS-level locks — an in-memory
database would not exercise the same code path.

Fixtures here are self-contained and do not rely on tests/conftest.py.
"""

from __future__ import annotations

import threading
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from src.storage.models import BackgroundJobRecord, Base
from src.storage.repositories import BackgroundJobRepository

JOB_COUNT = 20
THREAD_COUNT = 8


@pytest.fixture()
def job_session_factory(tmp_path: Path) -> sessionmaker:
    """File-based SQLite engine + sessionmaker over a fresh temp database."""
    db_path = tmp_path / "jobs-race.db"
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
                actor="race-test",
                payload_json={},
                max_attempts=2,
                created_at=base + timedelta(seconds=i),
            )
            session.add(record)
            session.flush()
            ids.append(record.id)
        session.commit()
    return ids


def test_concurrent_claim_yields_each_job_exactly_once(
    job_session_factory: sessionmaker,
) -> None:
    seeded_ids = _seed_jobs(job_session_factory, JOB_COUNT)
    assert len(seeded_ids) == JOB_COUNT

    claimed: list[tuple[str, int]] = []
    worker_errors: list[BaseException] = []
    results_lock = threading.Lock()
    start_barrier = threading.Barrier(THREAD_COUNT)

    def worker(worker_index: int) -> None:
        try:
            start_barrier.wait(timeout=30)
            while True:
                # Fresh session per claim attempt mirrors real worker loops and
                # avoids any identity-map staleness between iterations.
                with job_session_factory() as session:
                    record = BackgroundJobRepository(session).claim_next(
                        lease_seconds=90,
                    )
                if record is None:
                    return
                with results_lock:
                    claimed.append((f"worker-{worker_index}", record.id))
        except BaseException as exc:  # noqa: BLE001 - surfaced to main thread below
            with results_lock:
                worker_errors.append(exc)

    threads = [
        threading.Thread(target=worker, args=(i,), name=f"claimer-{i}")
        for i in range(THREAD_COUNT)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=120)
        assert not thread.is_alive(), "claim worker hung"

    # A crashed worker means claim_next itself blew up under contention.
    assert not worker_errors, f"claim_next raised under concurrency: {worker_errors!r}"

    claimed_job_ids = [job_id for _, job_id in claimed]
    counts = Counter(claimed_job_ids)
    duplicates = {job_id: n for job_id, n in counts.items() if n > 1}
    assert not duplicates, (
        f"DOUBLE-CLAIM detected: {len(duplicates)} job(s) claimed more than "
        f"once: {duplicates}; total claims={len(claimed_job_ids)}"
    )
    assert sorted(claimed_job_ids) == sorted(seeded_ids), (
        f"LOST jobs: {sorted(set(seeded_ids) - set(claimed_job_ids))}; "
        f"total claims={len(claimed_job_ids)}"
    )

    # Post-state check from an independent session: every job running exactly
    # with attempts == 1.
    with job_session_factory() as session:
        rows = session.query(BackgroundJobRecord).all()
        assert len(rows) == JOB_COUNT
        assert all(row.status == "running" for row in rows)
        assert all(int(row.attempts or 0) == 1 for row in rows)
