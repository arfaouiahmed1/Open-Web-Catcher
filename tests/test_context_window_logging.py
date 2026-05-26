from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.storage.models import Base, AgentRunRecord, LLMCallRecord, RuntimeEventRecord
from src.storage.repositories import RunRepository
from src.storage.ui_repository import OperatorConsoleRepository
from src.utils.observability import ObservabilityStatus, RunTrace, RuntimeEvent


def _session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    return session_factory()


def _event(seq: int, actor: str, kind: str, *, status: str = "info", details: dict | None = None) -> RuntimeEvent:
    return RuntimeEvent(
        seq=seq,
        actor=actor,
        kind=kind,
        status=status,
        message=kind,
        details=details or {},
        timestamp=datetime(2026, 5, 20, 12, 0, 0) + timedelta(seconds=seq),
    )


def _trace_with_context_and_compaction() -> RunTrace:
    return RunTrace(
        run_id="ctx-run-1",
        root_actor="orchestrator",
        started_at=datetime(2026, 5, 20, 12, 0, 0),
        finished_at=datetime(2026, 5, 20, 12, 0, 20),
        completed=True,
        observability=ObservabilityStatus(enabled=False, project="", default_dataset_name=""),
        events=[
            _event(1, "landing", "agent_started", details={"url": "https://site.example"}),
            _event(
                2,
                "landing",
                "agent_loop_started",
                details={
                    "max_tool_calls": 8,
                    "context_continuation_enabled": True,
                    "context_continuation_threshold": 0.8,
                },
            ),
            _event(
                3,
                "landing",
                "llm_response",
                details={
                    "provider": "google_genai",
                    "model_name": "gemini-test",
                    "input_tokens": 7800,
                    "output_tokens": 700,
                    "context_tokens": 8500,
                    "context_window": 10000,
                    "context_usage_pct": 0.85,
                    "tool_calls": 1,
                    "content_preview": '{"hosting_pages":[]}',
                    "content_full": '{"hosting_pages":[]}',
                },
            ),
            _event(
                4,
                "landing",
                "context_compaction_started",
                details={
                    "continuation_of_actor": "landing",
                    "continuation_index": 1,
                    "compaction_reason": "context_window_threshold",
                    "context_tokens": 8500,
                    "context_window": 10000,
                    "context_usage_pct": 0.85,
                    "continuation_capsule": {
                        "target_url": "https://site.example",
                        "pending_frontier": ["https://site.example/live/2"],
                    },
                },
            ),
            _event(
                5,
                "landing",
                "agent_finished",
                status="warning",
                details={
                    "stop_reason": "context_compacted",
                    "continuation_index": 1,
                    "context_tokens": 8500,
                    "context_window": 10000,
                    "context_usage_pct": 0.85,
                },
            ),
            _event(
                6,
                "landing",
                "agent_started",
                details={
                    "continuation_of_actor": "landing",
                    "continuation_index": 1,
                    "url": "https://site.example",
                },
            ),
            _event(
                7,
                "landing",
                "context_compaction_finished",
                details={
                    "continuation_of_actor": "landing",
                    "continuation_index": 1,
                    "context_tokens": 8500,
                    "context_window": 10000,
                    "context_usage_pct": 0.85,
                },
            ),
            _event(
                8,
                "landing",
                "llm_response",
                details={
                    "provider": "google_genai",
                    "model_name": "gemini-test",
                    "input_tokens": 1200,
                    "output_tokens": 200,
                    "context_tokens": 1400,
                    "context_window": 10000,
                    "context_usage_pct": 0.14,
                    "tool_calls": 0,
                    "content_preview": '{"hosting_pages":[{"url":"https://site.example/live/2"}]}',
                    "content_full": '{"hosting_pages":[{"url":"https://site.example/live/2"}]}',
                },
            ),
            _event(9, "landing", "agent_finished", status="success", details={"page_type": "landing_page"}),
        ],
    )


def test_context_window_fields_are_persisted_into_llm_calls_and_rollups() -> None:
    session = _session()
    try:
        trace = _trace_with_context_and_compaction()
        RunRepository(session).save_trace_snapshot(
            run_id=trace.run_id,
            root_actor=trace.root_actor,
            url="https://site.example",
            trace=trace,
        )

        llm_rows = session.query(LLMCallRecord).order_by(LLMCallRecord.seq.asc()).all()
        assert [row.context_window for row in llm_rows] == [10000, 10000]
        assert [row.input_tokens + row.output_tokens for row in llm_rows] == [8500, 1400]

        agent_rows = session.query(AgentRunRecord).order_by(AgentRunRecord.id.asc()).all()
        assert [row.context_window for row in agent_rows] == [10000, 10000]
        assert [row.context_tokens for row in agent_rows] == [8500, 1400]
        assert [row.context_usage_pct for row in agent_rows] == [0.85, 0.14]
        assert [row.model_name for row in agent_rows] == ["gemini-test", "gemini-test"]

        payload = OperatorConsoleRepository(session).get_run_detail(trace.run_id)
        rollups = [
            row for row in payload["agent_rollups"]
            if row["actor"] == "landing"
        ]
        assert [row["invocation_index"] for row in rollups] == [1, 2]
        assert rollups[0]["context_window"] == 10000
        assert rollups[0]["context_tokens"] == 8500
        assert rollups[0]["context_usage_pct"] == 0.85
        assert rollups[0]["provider"] == "google_genai"
        assert rollups[0]["model_name"] == "gemini-test"
        assert rollups[1]["context_tokens"] == 1400
        assert rollups[1]["context_usage_pct"] == 0.14

        overview = OperatorConsoleRepository(session).get_overview(limit=10)
        assert overview["summary"]["context_tracked_agent_runs"] == 2
        assert overview["summary"]["context_tracked_llm_calls"] == 2
        assert overview["summary"]["peak_context_window"] == 10000
        assert overview["summary"]["peak_context_tokens"] == 8500
        assert overview["summary"]["peak_context_usage_pct"] == 0.85
    finally:
        session.close()


def test_context_compaction_events_keep_visible_context_metadata() -> None:
    session = _session()
    try:
        trace = _trace_with_context_and_compaction()
        RunRepository(session).save_trace_snapshot(
            run_id=trace.run_id,
            root_actor=trace.root_actor,
            url="https://site.example",
            trace=trace,
        )

        started = (
            session.query(RuntimeEventRecord)
            .filter_by(kind="context_compaction_started")
            .one()
        )
        finished = (
            session.query(RuntimeEventRecord)
            .filter_by(kind="context_compaction_finished")
            .one()
        )
        assert started.agent_run_id is not None
        assert started.details_json["context_window"] == 10000
        assert started.details_json["context_tokens"] == 8500
        assert started.details_json["context_usage_pct"] == 0.85
        assert started.details_json["continuation_capsule"]["pending_frontier"] == [
            "https://site.example/live/2"
        ]
        assert finished.agent_run_id is not None
        assert finished.details_json["continuation_index"] == 1
    finally:
        session.close()
