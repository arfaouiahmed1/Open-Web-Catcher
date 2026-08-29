"""Event schema v2 (plan T31 / SCH-M6/H5): typed enums + schema_version stamping.

Covers:
- ``EventKind`` / ``EventStatus`` StrEnums exist in ``src.models.enums``.
- runtime_events write path validates kinds: unknown kind RAISES in dev
  (``Settings.environment == "dev"``), coerces to ``unknown`` + warns in prod.
- Every persisted JSON blob carries ``schema_version == 2``: runtime-event
  details, run snapshots (both legacy upsert and trace-snapshot paths), and
  llm-row metadata dicts (usage_metadata / response_metadata / prompt
  compilation metadata).
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import NullPool

from src.models.enums import EventKind, EventStatus
from src.storage.models import (
    AgentRunRecord,
    Base,
    LLMCallRecord,
    PipelineRunRecord,
    RunSnapshotRecord,
    RuntimeEventRecord,
)
from src.storage.repositories import (
    EVENT_SCHEMA_VERSION,
    RunRepository,
    stamp_schema_version,
    validate_runtime_event_kind,
)
from src.utils.observability import ObservabilityStatus, RuntimeEvent, RunTrace


@pytest.fixture()
def session_factory(tmp_path: Path) -> Iterator[sessionmaker]:
    engine = create_engine(
        f"sqlite:///{tmp_path / 'event-schema.db'}",
        connect_args={"check_same_thread": False},
        poolclass=NullPool,
        future=True,
    )
    Base.metadata.create_all(bind=engine)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=True, future=True)
    try:
        yield factory
    finally:
        engine.dispose()


@pytest.fixture(autouse=True)
def _clean_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Isolate the dev/prod flag from any ambient ENVIRONMENT variable."""
    monkeypatch.delenv("ENVIRONMENT", raising=False)


def _trace(run_id: str, url: str, events: list[RuntimeEvent]) -> RunTrace:
    started = datetime(2026, 8, 24, 9, 0, 0)
    return RunTrace(
        run_id=run_id,
        root_actor="orchestrator",
        started_at=started,
        finished_at=started + timedelta(seconds=5),
        completed=True,
        observability=ObservabilityStatus(enabled=False, project="", default_dataset_name=""),
        events=events,
    )


def _event(seq: int, kind: str, *, details: dict[str, Any] | None = None) -> RuntimeEvent:
    return RuntimeEvent(
        seq=seq, actor="test", kind=kind, message=f"evt-{seq}", details=details or {}
    )


# ── Typed enums ──────────────────────────────────────────────────────────────


def test_event_kind_and_status_are_strenums_with_expected_members() -> None:
    assert issubclass(EventKind, str)
    assert issubclass(EventStatus, str)
    for member in ("llm_response", "tool_call_started", "pipeline_started", "run_started"):
        assert member in EventKind._value2member_map_
    for member in ("info", "warning", "error", "success"):
        assert member in EventStatus._value2member_map_


# ── Dev/prod validation matrix ───────────────────────────────────────────────


def test_validate_kind_matrix_dev_raises_prod_coerces() -> None:
    # Known kinds pass through untouched in both modes.
    assert validate_runtime_event_kind("llm_response", is_dev=True) == "llm_response"
    assert validate_runtime_event_kind("llm_response", is_dev=False) == "llm_response"

    # Unknown kinds: raise in dev...
    with pytest.raises(ValueError, match="unknown runtime event kind"):
        validate_runtime_event_kind("totally_bogus_kind", is_dev=True)

    # ...coerce + warn in prod.
    assert validate_runtime_event_kind("totally_bogus_kind", is_dev=False) == str(EventKind.UNKNOWN)


def test_unknown_kind_raises_in_dev_on_persist(
    session_factory: sessionmaker,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ENVIRONMENT", "dev")
    trace = _trace("run-dev-raise", "https://example.com/dev", [_event(1, "not_a_real_kind")])
    with pytest.raises(ValueError, match="not_a_real_kind"):
        with session_factory() as session:
            RunRepository(session).save_trace_snapshot(
                run_id=trace.run_id,
                root_actor="orchestrator",
                url="https://example.com/dev",
                trace=trace,
            )


def test_unknown_kind_coerces_and_warns_in_prod_on_persist(
    session_factory: sessionmaker,
    caplog: pytest.LogCaptureFixture,
) -> None:
    trace = _trace("run-prod-coerce", "https://example.com/prod", [_event(1, "not_a_real_kind")])
    with caplog.at_level("WARNING", logger="src.storage.repositories"):
        with session_factory() as session:
            RunRepository(session).save_trace_snapshot(
                run_id=trace.run_id,
                root_actor="orchestrator",
                url="https://example.com/prod",
                trace=trace,
            )

    assert any("not_a_real_kind" in rec.message for rec in caplog.records)
    with session_factory() as verify:
        row = verify.query(RuntimeEventRecord).one()
        assert row.kind == str(EventKind.UNKNOWN)
        assert isinstance(row.details_json, dict)
        assert row.details_json.get("schema_version") == EVENT_SCHEMA_VERSION


def test_known_kinds_persist_untouched(session_factory: sessionmaker) -> None:
    events = [
        _event(1, "pipeline_started"),
        _event(2, "llm_response"),
        _event(3, "tool_call_finished"),
    ]
    with session_factory() as session:
        RunRepository(session).save_trace_snapshot(
            run_id="run-known-kinds",
            root_actor="orchestrator",
            url="https://example.com/known",
            trace=_trace("run-known-kinds", "https://example.com/known", events),
        )
    with session_factory() as verify:
        stored = {
            row.seq: row.kind
            for row in verify.query(RuntimeEventRecord).order_by(RuntimeEventRecord.seq)
        }
        assert stored == {1: "pipeline_started", 2: "llm_response", 3: "tool_call_finished"}
        for row in verify.query(RuntimeEventRecord):
            assert row.details_json.get("schema_version") == EVENT_SCHEMA_VERSION


# ── schema_version stamping ──────────────────────────────────────────────────


def test_stamp_schema_version_helper() -> None:
    assert stamp_schema_version({"a": 1}) == {"a": 1, "schema_version": 2}
    assert stamp_schema_version(None) == {"schema_version": 2}
    # Force-overwrite stale versions.
    assert stamp_schema_version({"schema_version": 1})["schema_version"] == 2


def test_save_upserts_snapshot_blob_with_schema_version(session_factory: sessionmaker) -> None:
    from src.models.enums import ExtractionStatus
    from src.models.schemas import PipelineResult, RunMetrics

    result = PipelineResult(
        run_id="run-upsert-snap",
        url="https://example.com/upsert",
        final_status=ExtractionStatus.SUCCESS,
        metrics=RunMetrics(
            run_id="run-upsert-snap", url="https://example.com/upsert", success=True
        ),
    )
    with session_factory() as session:
        RunRepository(session).save(result, trace=None)

    with session_factory() as verify:
        snapshot = verify.query(RunSnapshotRecord).filter_by(run_id="run-upsert-snap").one()
        assert snapshot.snapshot_json.get("schema_version") == EVENT_SCHEMA_VERSION


def _seed_agent_run(session_factory: sessionmaker, run_id: str) -> int:
    with session_factory() as session:
        pipeline = PipelineRunRecord(
            run_id=run_id,
            root_url="https://example.com/x",
            final_status="success",
            success=True,
        )
        session.add(pipeline)
        session.flush()
        agent_run = AgentRunRecord(
            pipeline_run_id=pipeline.id,
            actor="landing_page",
            agent_type="landing_page",
            target_url="https://example.com/x",
            page_type="landing_page",
            status="success",
        )
        session.add(agent_run)
        session.commit()
        return int(agent_run.id)


def test_llm_row_metadata_dicts_carry_schema_version(session_factory: sessionmaker) -> None:
    agent_run_id = _seed_agent_run(session_factory, "run-llm-meta")
    details = {
        "model_name": "gemini-2.5-flash",
        "provider": "google",
        "input_tokens": 10,
        "output_tokens": 5,
        "usage_metadata": {"input_token_count": 10},
        "response_metadata": {"finish_reason": "stop"},
        "content_preview": "hello",
    }
    ctx = {"events": [_event(1, "llm_response", details=details)], "prompt": {}}

    with session_factory() as session:
        RunRepository(session)._persist_llm_calls(agent_run_id, ctx)
        session.commit()

    with session_factory() as verify:
        row = verify.query(LLMCallRecord).one()
        assert row.usage_metadata_json["schema_version"] == EVENT_SCHEMA_VERSION
        assert row.response_metadata_json["schema_version"] == EVENT_SCHEMA_VERSION
