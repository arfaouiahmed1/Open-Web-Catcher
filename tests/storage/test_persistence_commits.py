"""Persistence-commit characterization + failing-first captures (Plan Task 7).

Covers the two silent data-loss paths from `.omo/drafts/full-audit.md`:

- [DM-C1] ``RunRepository.save()`` used ``begin_nested()`` whenever a prior
  SELECT had autobegun a transaction. A SAVEPOINT release is not a COMMIT, so
  callers that close their session without committing (the backfill script)
  silently lost every row while printing "Backfilled N run(s)".
- [DM-C4] trace-snapshot durability must come from the snapshot write's own
  committed transaction, never from ``BackgroundJobRepository.heartbeat``'s
  side-effect commit.

Driver note: stock pysqlite legacy isolation mode never emits ``BEGIN`` for
SELECT-only transactions, so a ``SAVEPOINT``/``RELEASE`` pair accidentally
autocommits and MASKS the [DM-C1] loss on SQLite. Production runs Postgres,
where the autobegun transaction is real and ``session.close()`` rolls it back.
The ``strict_session_factory`` fixture below installs SQLAlchemy's documented
pysqlite recipe (isolation_level=None + explicit ``BEGIN`` on the session
begin event) so SQLite enforces the SAME transactional semantics as Postgres;
the failing-first captures run against it.

Test layout:
- ``test_save_on_fresh_session_persists_pipeline_run`` — baseline
  characterization that must pass on UNCHANGED code (fresh session takes the
  ``begin()`` branch, whose context manager commits).
- ``test_save_persists_even_after_prior_select_autobegin`` — failing-first
  unit-level capture of the [DM-C1] mechanism.
- ``test_backfill_persists_seeded_legacy_rows`` — failing-first end-to-end
  capture of the backfill script flow ([DM-C1]).
- ``test_backfill_leaves_no_uncommitted_transaction_open`` — driver-independent
  root-cause pin: backfill must COMMIT, not leave an open outer transaction.
- ``test_snapshot_survives_close_without_background_job_row`` — pins the
  [DM-C4] contract: snapshot durability must not depend on heartbeat.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from typing import Iterator

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from src.models.enums import ExtractionStatus
from src.models.schemas import PipelineResult, RunMetrics
from src.storage.models import (
    Base,
    PipelineRunRecord,
    RunRecord,
    RunSnapshotRecord,
)
from src.storage.repositories import RunRepository
from src.utils.observability import ObservabilityStatus, RunTrace, RuntimeEvent


def _build_engine(db_path: Path, *, strict_transactions: bool) -> Engine:
    """File-based SQLite engine; optionally enforce real BEGIN/ROLLBACK semantics."""
    engine = create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False, "timeout": 30},
        poolclass=NullPool,
        future=True,
    )
    if strict_transactions:
        # SQLAlchemy-documented pysqlite recipe for real transactional
        # semantics (Serializable isolation / Savepoints section). Without it,
        # pysqlite's implicit DML-only BEGIN masks uncommitted outer
        # transactions behind SAVEPOINT autocommit — hiding [DM-C1].
        @event.listens_for(engine, "connect")
        def _set_isolation_level(dbapi_connection, connection_record):  # noqa: ANN001
            dbapi_connection.isolation_level = None

        @event.listens_for(engine, "begin")
        def _emit_real_begin(conn):  # noqa: ANN001
            conn.exec_driver_sql("BEGIN")

    return engine


@pytest.fixture()
def persist_session_factory(tmp_path: Path) -> Iterator[sessionmaker]:
    """Stock-pysqlite engine + sessionmaker over a fresh temp database."""
    engine = _build_engine(tmp_path / "persistence-commits.db", strict_transactions=False)
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=True, future=True)
    try:
        yield factory
    finally:
        engine.dispose()


@pytest.fixture()
def strict_session_factory(tmp_path: Path) -> Iterator[sessionmaker]:
    """Engine with REAL transactional semantics (Postgres-like BEGIN/ROLLBACK)."""
    engine = _build_engine(tmp_path / "persistence-commits-strict.db", strict_transactions=True)
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=True, future=True)
    try:
        yield factory
    finally:
        engine.dispose()


def _pipeline_result(run_id: str, url: str) -> PipelineResult:
    """Minimal but valid normalized result, as a legacy row would carry."""
    return PipelineResult(
        run_id=run_id,
        url=url,
        final_status=ExtractionStatus.SUCCESS,
        metrics=RunMetrics(
            run_id=run_id,
            url=url,
            started_at=datetime(2026, 8, 22, 12, 0, 0),
            finished_at=datetime(2026, 8, 22, 12, 0, 10),
            total_tokens_in=100,
            total_tokens_out=50,
            total_tool_calls=2,
            success=True,
        ),
    )


def _seed_legacy_run(factory: sessionmaker, run_id: str, url: str) -> None:
    """Insert a legacy ``runs`` row exactly as the pre-normalization write path left it."""
    with factory() as session:
        session.add(
            RunRecord(
                run_id=run_id,
                url=url,
                page_type="hosting_page",
                status="success",
                streams_found=1,
                success=True,
                result_json=_pipeline_result(run_id, url).model_dump(mode="json"),
                created_at=datetime(2026, 8, 22, 12, 0, 0),
            )
        )
        session.commit()


def _make_trace(run_id: str, url: str) -> RunTrace:
    started = datetime(2026, 8, 22, 12, 0, 0)
    return RunTrace(
        run_id=run_id,
        root_actor="orchestrator",
        started_at=started,
        finished_at=started + timedelta(seconds=5),
        completed=True,
        observability=ObservabilityStatus(enabled=False, project="", default_dataset_name=""),
        events=[
            RuntimeEvent(seq=1, actor="orchestrator", kind="run_started", message="started"),
        ],
        metrics=RunMetrics(run_id=run_id, url=url, started_at=started, success=True),
    )


def test_save_on_fresh_session_persists_pipeline_run(
    persist_session_factory: sessionmaker,
) -> None:
    """BASELINE (must pass on unchanged code): save() on a FRESH session commits.

    A fresh session is not in a transaction, so the legacy heuristic took the
    ``begin()`` branch whose context manager commits. This test pins that the
    fix must never regress the working path.
    """
    result = _pipeline_result("run-fresh", "https://example.com/fresh")
    session = persist_session_factory()
    try:
        record = RunRepository(session).save(result, trace=None)
        assert record.run_id == "run-fresh"
    finally:
        session.close()

    # Durable: visible from an INDEPENDENT session after close().
    with persist_session_factory() as verify:
        pipeline = verify.query(PipelineRunRecord).filter_by(run_id="run-fresh").one_or_none()
        assert pipeline is not None, "save() on a fresh session must persist pipeline_runs"
        assert pipeline.final_status == "success"
        snapshot = verify.query(RunSnapshotRecord).filter_by(run_id="run-fresh").one_or_none()
        assert snapshot is not None


def test_save_persists_even_after_prior_select_autobegin(
    strict_session_factory: sessionmaker,
) -> None:
    """FAILING-FIRST [DM-C1] mechanism: save() after an autobegun txn commits.

    The legacy heuristic took the ``begin_nested()`` branch here, releasing a
    SAVEPOINT only; ``close()`` then rolled back the outer transaction and the
    row vanished. Durability must not depend on how the caller's session was
    left.
    """
    result = _pipeline_result("run-autobegin", "https://example.com/autobegin")
    session = strict_session_factory()
    try:
        # Any prior SELECT autobegins a transaction on the session.
        assert RunRepository(session).get_by_run_id("does-not-exist") is None
        assert session.in_transaction(), "SELECT should autobegin a transaction"

        RunRepository(session).save(result, trace=None)
    finally:
        # Mirrors the backfill script: close() without an explicit commit.
        session.close()

    with strict_session_factory() as verify:
        pipeline = verify.query(PipelineRunRecord).filter_by(run_id="run-autobegin").one_or_none()
        assert pipeline is not None, (
            "save() must commit even when a prior SELECT autobegan the transaction"
        )


def test_backfill_persists_seeded_legacy_rows(
    strict_session_factory: sessionmaker,
) -> None:
    """FAILING-FIRST [DM-C1] end-to-end: seeded legacy rows survive backfill.

    Reproduces scripts/backfill_normalized_runs.py exactly: one session, seed
    query materialized via ``query.all()`` (autobegins a txn), per-record
    ``save()``, then ``session.close()`` with no explicit commit. Pre-fix this
    printed "Backfilled N run(s)" while persisting ZERO rows.
    """
    seeded = [
        ("run-backfill-1", "https://example.com/1"),
        ("run-backfill-2", "https://example.com/2"),
        ("run-backfill-3", "https://example.com/3"),
    ]
    for run_id, url in seeded:
        _seed_legacy_run(strict_session_factory, run_id, url)

    session = strict_session_factory()
    try:
        count = RunRepository(session).backfill_normalized_from_legacy()
    finally:
        session.close()

    # The misleading-success half: the method REPORTS full success even pre-fix.
    assert count == len(seeded), f"expected {len(seeded)} reported backfills, got {count}"

    # The durability half (this is what failed pre-fix): rows actually exist.
    with strict_session_factory() as verify:
        persisted = {
            row.run_id
            for row in verify.query(PipelineRunRecord.run_id).all()
        }
        assert persisted == {run_id for run_id, _ in seeded}, (
            f"backfill lost data: expected all {len(seeded)} runs in pipeline_runs, "
            f"found {sorted(persisted)}"
        )
        for run_id, _ in seeded:
            snapshot = verify.query(RunSnapshotRecord).filter_by(run_id=run_id).one_or_none()
            assert snapshot is not None, f"run_snapshots row missing for {run_id}"


def test_backfill_leaves_no_uncommitted_transaction_open(
    persist_session_factory: sessionmaker,
) -> None:
    """Driver-independent [DM-C1] root-cause pin: backfill COMMITS per record.

    Pre-fix the seed query's autobegun transaction stayed open across the whole
    loop (SAVEPOINT releases only); any caller relying on close()-without-
    commit lost everything. Post-fix each record lands in its own committed
    transaction, so the method must return with NO transaction open.
    """
    _seed_legacy_run(persist_session_factory, "run-open-txn", "https://example.com/open")

    session = persist_session_factory()
    try:
        count = RunRepository(session).backfill_normalized_from_legacy()
        assert count == 1
        assert not session.in_transaction(), (
            "backfill must not return with an uncommitted outer transaction open"
        )
    finally:
        session.close()


def test_snapshot_survives_close_without_background_job_row(
    strict_session_factory: sessionmaker,
) -> None:
    """[DM-C4] contract: snapshot persists with NO background_jobs row/heartbeat.

    Durability of the snapshot write must come from the snapshot write's own
    committed transaction, never from a later heartbeat side-effect commit.
    """
    run_id = "run-no-job"
    url = "https://example.com/no-job"
    trace = _make_trace(run_id, url)

    session = strict_session_factory()
    try:
        # Deliberately NO BackgroundJobRepository row and NO heartbeat call.
        RunRepository(session).save_trace_snapshot(
            run_id=run_id, root_actor="orchestrator", url=url, trace=trace
        )
    finally:
        session.close()

    with strict_session_factory() as verify:
        assert verify.query(PipelineRunRecord).filter_by(run_id=run_id).count() == 1
        snapshot = verify.query(RunSnapshotRecord).filter_by(run_id=run_id).one_or_none()
        assert snapshot is not None, (
            "snapshot must survive session.close() without any heartbeat commit"
        )
        payload = snapshot.snapshot_json
        assert isinstance(payload, dict)
        assert payload.get("run_id") == run_id
        assert payload.get("url") == url
