"""RunPlan artifact (plan task 27): storage, helper module, SSE carrier.

Covers:
- create -> transitions -> SSE event capture via a fake RunObserver,
- RunPlanRepository round-trip (declaration + live step statuses),
- validation failures (bad status, unknown step, missing step id),
- app.py's read-only plan attachment in the _stream_trace poll loop.

TODO(plan-T27-wire): production wiring is DEFERRED to the next wave. The three
call sites that must invoke these helpers inside node bodies are documented in
``src/orchestrator/run_plan.py`` (run start emit + per-node in_progress and
terminal transitions). Until then, fixture-run transitions only happen when a
caller invokes :func:`emit_run_plan` / :func:`transition_run_step` directly —
which is exactly what these tests do. The acceptance criterion "every node
transitions step statuses" lands when the wire TODO is closed.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from src.orchestrator.run_plan import (
    PLAN_STEP_UPDATE_KIND,
    RUN_PLAN_CREATED_KIND,
    emit_run_plan,
    transition_run_step,
)
from src.storage.models import Base, PlanStepRecord, RunPlanRecord, RunRecord
from src.storage.repositories import RunPlanRepository

PLAN_STEPS = [
    {
        "id": "classify",
        "title": "Classify page",
        "criteria": "page_type assigned with confidence",
        "budget": {"max_llm_calls": 1},
    },
    {"id": "extract", "title": "Extract streams", "criteria": ">= 0 stream URLs"},
    {"id": "email", "title": "Render takedown email"},
]


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


@pytest.fixture()
def session(session_factory):
    db = session_factory()
    try:
        yield db
    finally:
        db.close()


class FakeObserver:
    """Captures emitted events like a real RunObserver would expose them."""

    def __init__(self) -> None:
        self._seq = 1
        self.events: list[dict[str, Any]] = []

    def emit(self, kind: str, message: str, *, status: str = "info", details=None):
        event = {
            "seq": self._seq,
            "kind": kind,
            "message": message,
            "status": status,
            "details": dict(details or {}),
            "timestamp": datetime.now(UTC).isoformat(),
        }
        self._seq += 1
        self.events.append(event)
        return event


@pytest.fixture()
def run_id(session: Any) -> str:
    """A parent run row so the run_plans FK resolves."""
    record = RunRecord(run_id="run-t27", url="https://example.com")
    session.add(record)
    session.commit()
    return "run-t27"


# ------------------------------------------------- create -> transition -> SSE


def test_emit_then_transition_sequence_produces_sse_events(session, run_id):
    observer = FakeObserver()

    created = emit_run_plan(observer, session, run_id, "sequential", PLAN_STEPS)
    assert created is not None
    assert created["kind"] == RUN_PLAN_CREATED_KIND
    assert created["details"]["strategy"] == "sequential"
    assert [step["id"] for step in created["details"]["steps"]] == [
        "classify",
        "extract",
        "email",
    ]

    # Full lifecycle for one step, partial for another.
    transition_run_step(observer, session, run_id, "classify", "in_progress")
    transition_run_step(observer, session, run_id, "classify", "done")
    transition_run_step(observer, session, run_id, "extract", "in_progress")
    transition_run_step(observer, session, run_id, "extract", "failed")

    plan_events = [e for e in observer.events if e["kind"] == PLAN_STEP_UPDATE_KIND]
    assert [(e["details"]["step_id"], e["details"]["status"]) for e in plan_events] == [
        ("classify", "in_progress"),
        ("classify", "done"),
        ("extract", "in_progress"),
        ("extract", "failed"),
    ]
    # seq strictly increases so the existing SSE poll loop dedupes by last_seq.
    seqs = [e["seq"] for e in observer.events]
    assert seqs == sorted(seqs) and len(set(seqs)) == len(seqs)

    repo = RunPlanRepository(session)
    snapshot = repo.get_plan(run_id)
    statuses = {step["id"]: step["status"] for step in snapshot["steps"]}
    assert statuses == {
        "classify": "done",
        "extract": "failed",
        "email": "pending",
    }

    # A stream consumer sees both the carried events AND a `plan` attachment:
    # app.py attaches get_plan() output whenever these kinds appear.
    sse_kinds = {e["kind"] for e in observer.events}
    assert {RUN_PLAN_CREATED_KIND, PLAN_STEP_UPDATE_KIND} <= sse_kinds


def test_observer_is_optional_for_persistence_only_callers(session, run_id):
    assert emit_run_plan(None, session, run_id, "solo", PLAN_STEPS) is None
    assert transition_run_step(None, session, run_id, "extract", "in_progress") is None
    snapshot = RunPlanRepository(session).get_plan(run_id)
    assert snapshot["steps"][1]["status"] == "in_progress"


def test_create_plan_is_idempotent_per_run(session, run_id):
    emit_run_plan(FakeObserver(), session, run_id, "a", PLAN_STEPS)
    second = emit_run_plan(FakeObserver(), session, run_id, "b", PLAN_STEPS)
    assert second is not None  # announcement still happens on retry
    count = session.query(RunPlanRecord).filter_by(run_id=run_id).count()
    assert count == 1
    steps = session.query(PlanStepRecord).filter_by(run_id=run_id).count()
    assert steps == len(PLAN_STEPS)


# ------------------------------------------------------------ repository round-trip


def test_repository_round_trip_declaration_and_live_statuses(session, run_id):
    repo = RunPlanRepository(session)

    assert repo.get_plan(run_id) is None  # no artifact yet

    repo.create_plan(run_id, "stream-hunter", PLAN_STEPS)
    snapshot = repo.get_plan(run_id)
    assert snapshot["strategy"] == "stream-hunter"
    assert snapshot["created_at"] is not None
    assert [(s["position"], s["id"]) for s in snapshot["steps"]] == [
        (0, "classify"),
        (1, "extract"),
        (2, "email"),
    ]
    assert all(s["status"] == "pending" for s in snapshot["steps"])
    assert snapshot["steps"][0]["criteria"] == "page_type assigned with confidence"
    assert snapshot["steps"][0]["budget"] == {"max_llm_calls": 1}

    repo.transition_step(run_id, "extract", "in_progress")
    reloaded = repo.get_plan(run_id)
    assert reloaded["steps"][1]["status"] == "in_progress"
    assert reloaded["steps"][1]["updated_at"] is not None

    # JSON document round-trips cleanly (what the SSE payload serializes).
    assert json.loads(json.dumps(reloaded))["run_id"] == run_id


def test_repository_rejects_bad_transitions(session, run_id):
    repo = RunPlanRepository(session)
    repo.create_plan(run_id, "s", PLAN_STEPS)

    with pytest.raises(ValueError, match="invalid plan step status"):
        repo.transition_step(run_id, "classify", "teleported")
    with pytest.raises(ValueError, match="no plan step"):
        repo.transition_step(run_id, "nonexistent", "done")


def test_repository_requires_step_ids(session, run_id):
    with pytest.raises(ValueError, match="missing an 'id'"):
        RunPlanRepository(session).create_plan(run_id, "s", [{"title": "no id"}])


# --------------------------------------------- app.py SSE carrier (read-only side)


def test_stream_payload_carries_plan_attachment(session, run_id, monkeypatch):
    """The exact shape _stream_trace attaches as payload['plan']."""
    from src.api import app as app_module

    # Point the app-level read path at this test's in-memory database.
    monkeypatch.setattr(app_module, "get_session", lambda: session)
    assert RUN_PLAN_CREATED_KIND in app_module._PLAN_EVENT_KINDS
    assert PLAN_STEP_UPDATE_KIND in app_module._PLAN_EVENT_KINDS

    # No plan yet -> no attachment key.
    assert app_module._load_run_plan_snapshot(run_id) is None

    observer = FakeObserver()
    emit_run_plan(observer, session, run_id, "carrier-check", PLAN_STEPS[:2])
    transition_run_step(observer, session, run_id, "classify", "in_progress")

    snapshot = app_module._load_run_plan_snapshot(run_id)
    assert snapshot is not None
    assert snapshot["strategy"] == "carrier-check"
    assert snapshot["steps"][0]["status"] == "in_progress"
    # Serializes straight into the SSE data: line.
    json.dumps(snapshot)


def test_plan_snapshot_failure_never_raises(monkeypatch, run_id):
    from src.api import app as app_module

    class BoomSession:
        def close(self):  # pragma: no cover - trivial
            pass

    def broken_repo(_session):
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(app_module, "get_session", lambda: BoomSession())
    monkeypatch.setattr(app_module, "RunPlanRepository", broken_repo)
    assert app_module._load_run_plan_snapshot(run_id) is None


# ------------------------------------------------- orchestrator wiring (plan T27)


def test_run_plan_wiring_helpers_exist() -> None:
    """The orchestrator exposes emit + transition helpers for graph wiring."""
    from src.agents.orchestrator import _RUN_PLAN_STEPS, _wrap_plan_step

    declared_ids = [s["id"] for s in _RUN_PLAN_STEPS]
    assert declared_ids == [
        "classify",
        "landing_page",
        "analyze_providers",
        "validate_evidence",
        "generate_takedown_emails",
    ]
    # The wrapper is a callable factory accepting (step_id, node_fn, observer).
    assert callable(_wrap_plan_step)


@pytest.mark.asyncio
async def test_step_wrapper_emits_in_progress_then_done(monkeypatch, run_id, session) -> None:
    """The node wrapper emits in_progress on entry and done on exit."""
    from src.agents.orchestrator import _RUN_PLAN_STEPS, _wrap_plan_step
    from src.orchestrator.run_plan import emit_run_plan

    transitions: list[tuple[str, str]] = []

    class Obs:
        run_id = run_id
        session = session

        def emit(self, kind, message, *, status="info", details=None):
            return {"kind": kind, "details": details or {}}

    emit_run_plan(Obs(), session, run_id, "sequential", _RUN_PLAN_STEPS)

    def spy(observer, rid, step_id, status):
        transitions.append((step_id, status))

    monkeypatch.setattr("src.agents.orchestrator._safe_transition", spy)

    calls: list[dict[str, Any]] = []

    async def fake_node(state: dict[str, Any]) -> dict[str, Any]:
        calls.append(state)
        return {"ok": True}

    node = _wrap_plan_step("classify", fake_node, Obs())
    await node({"run_id": run_id})

    assert ("classify", "in_progress") in transitions
    assert ("classify", "done") in transitions
    assert calls


