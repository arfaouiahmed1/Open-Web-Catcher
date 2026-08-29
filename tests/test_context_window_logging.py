from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.storage.models import Base, AgentRunRecord, LLMCallRecord, RuntimeEventRecord
from src.storage.repositories import RunRepository
from src.storage.ui_repository import OperatorConsoleRepository
from src.utils.config import Settings
from src.utils.instrumentation import resolve_model_pricing
from src.utils.observability import ObservabilityStatus, RunTrace, RuntimeEvent
from src.utils.provider_models import resolve_model_context_window


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


def _trace_with_context_and_compaction(
    *,
    run_id: str = "ctx-run-1",
    model_name: str = "gemini-test",
    context_window: int = 10000,
    first_input_tokens: int = 7800,
    first_output_tokens: int = 700,
    second_input_tokens: int = 1200,
    second_output_tokens: int = 200,
) -> RunTrace:
    first_context_tokens = first_input_tokens + first_output_tokens
    second_context_tokens = second_input_tokens + second_output_tokens
    first_usage_pct = round(first_context_tokens / context_window, 4) if context_window else 0.0
    second_usage_pct = round(second_context_tokens / context_window, 4) if context_window else 0.0
    return RunTrace(
        run_id=run_id,
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
                    "model_name": model_name,
                    "input_tokens": first_input_tokens,
                    "output_tokens": first_output_tokens,
                    "context_tokens": first_context_tokens,
                    "context_window": context_window,
                    "context_usage_pct": first_usage_pct,
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
                    "context_tokens": first_context_tokens,
                    "context_window": context_window,
                    "context_usage_pct": first_usage_pct,
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
                    "context_tokens": first_context_tokens,
                    "context_window": context_window,
                    "context_usage_pct": first_usage_pct,
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
                    "context_tokens": first_context_tokens,
                    "context_window": context_window,
                    "context_usage_pct": first_usage_pct,
                },
            ),
            _event(
                8,
                "landing",
                "llm_response",
                details={
                    "provider": "google_genai",
                    "model_name": model_name,
                    "input_tokens": second_input_tokens,
                    "output_tokens": second_output_tokens,
                    "context_tokens": second_context_tokens,
                    "context_window": context_window,
                    "context_usage_pct": second_usage_pct,
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


def test_gemini_31_flash_lite_context_window_is_reported_through_compaction() -> None:
    context_window = resolve_model_context_window("gemini-3.1-flash-lite", "google_genai")
    assert context_window == 1_048_576

    settings = Settings()
    settings.model_pricing_json = "{}"
    pricing = resolve_model_pricing(
        settings,
        model_name="gemini-3.1-flash-lite",
        provider="google_genai",
    )
    # Cost math v2: unpriced models resolve to None instead of a zeroed row.
    assert pricing is None
    expected_usage_pct = round(900000 / context_window, 6)
    event_usage_pct = round(900000 / context_window, 4)

    session = _session()
    try:
        trace = _trace_with_context_and_compaction(
            run_id="ctx-run-gemini-31",
            model_name="gemini-3.1-flash-lite",
            context_window=context_window,
            first_input_tokens=899000,
            first_output_tokens=1000,
            second_input_tokens=4096,
            second_output_tokens=512,
        )
        RunRepository(session).save_trace_snapshot(
            run_id=trace.run_id,
            root_actor=trace.root_actor,
            url="https://site.example",
            trace=trace,
        )

        llm_rows = session.query(LLMCallRecord).order_by(LLMCallRecord.seq.asc()).all()
        assert [row.model_name for row in llm_rows] == [
            "gemini-3.1-flash-lite",
            "gemini-3.1-flash-lite",
        ]
        assert [row.context_window for row in llm_rows] == [context_window, context_window]
        assert llm_rows[0].input_tokens + llm_rows[0].output_tokens == 900000

        agent_rows = session.query(AgentRunRecord).order_by(AgentRunRecord.id.asc()).all()
        assert agent_rows[0].context_tokens == 900000
        assert agent_rows[0].context_usage_pct == expected_usage_pct

        started = (
            session.query(RuntimeEventRecord)
            .filter_by(kind="context_compaction_started")
            .one()
        )
        assert started.details_json["context_window"] == context_window
        assert started.details_json["context_usage_pct"] == event_usage_pct

        overview = OperatorConsoleRepository(session).get_overview(limit=10)
        assert overview["summary"]["peak_context_window"] == context_window
        assert overview["summary"]["peak_context_tokens"] == 900000
    finally:
        session.close()
