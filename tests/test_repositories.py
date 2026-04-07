from __future__ import annotations

from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import (
    ClassificationResult,
    ExtractionResult,
    PipelineResult,
    ProviderInfo,
    RunMetrics,
    StreamURL,
    TakedownEmail,
)
from src.storage.models import (
    AgentRunRecord,
    Base,
    MemoryEntryRecord,
    PipelineRunRecord,
    RunSnapshotRecord,
)
from src.storage.repositories import RunRepository
from src.utils.observability import RuntimeEvent, RunTrace, TracingStatus


def _build_result() -> PipelineResult:
    extraction = ExtractionResult(
        url="https://example.com/watch",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        streams=[StreamURL(url="https://cdn.example.com/master.m3u8", protocol="hls")],
        screenshots=["https://img.example.com/1.png"],
        agent_type=AgentType.HOSTING_PAGE,
        metadata={"decision": "safe_exit", "servers": [{"label": "Server 2"}]},
    )
    provider = ProviderInfo(stream_url="https://cdn.example.com/master.m3u8", provider="Example CDN")
    email = TakedownEmail(
        provider="Example CDN",
        abuse_email="abuse@example.com",
        subject="test",
        body="body",
        infringing_url="https://example.com/watch",
        stream_urls=["https://cdn.example.com/master.m3u8"],
    )
    return PipelineResult(
        run_id="run-1",
        url="https://example.com/watch",
        classification=ClassificationResult(
            url="https://example.com/watch",
            page_type=PageType.HOSTING,
            confidence=Confidence.HIGH,
            reasoning="Has a player.",
        ),
        extraction_results=[extraction],
        final_status=ExtractionStatus.SUCCESS,
        all_streams=[StreamURL(url="https://cdn.example.com/master.m3u8", protocol="hls")],
        all_screenshots=["https://img.example.com/1.png"],
        provider_analysis=[provider],
        takedown_emails=[email],
        metrics=RunMetrics(
            run_id="run-1",
            url="https://example.com/watch",
            total_tokens_in=11,
            total_tokens_out=7,
            total_llm_calls=1,
            total_tool_calls=1,
            total_duration_seconds=9.5,
            success=True,
        ),
    )


def _build_trace() -> RunTrace:
    tracing = TracingStatus(
        provider="phoenix",
        enabled=False,
        api_key_configured=False,
        project="test",
        endpoint="http://localhost",
        ui_url="http://localhost",
        base_url="http://localhost",
        deployment="self-hosted",
        tracing_env="false",
        default_dataset_name="test",
    )
    return RunTrace(
        run_id="run-1",
        root_actor="orchestrator",
        started_at=datetime.utcnow(),
        tracing=tracing,
        events=[
            RuntimeEvent(seq=1, actor="orchestrator", kind="pipeline_started", message="Pipeline started for https://example.com/watch"),
            RuntimeEvent(seq=2, actor="classification", kind="agent_started", message="Classification agent started for https://example.com/watch"),
            RuntimeEvent(seq=3, actor="classification", kind="prompt_compiled", message="prompt", details={"agent_id": "classification", "prompt_version": "classification:v1", "prompt_hash": "hash-a", "compiled_prompt_hash": "compiled-a", "cache_mode": "provider_hook", "sections": ["base_policy", "task_brief"]}),
            RuntimeEvent(seq=4, actor="classification", kind="agent_loop_started", message="loop", details={"max_tool_calls": 5}),
            RuntimeEvent(seq=5, actor="classification", kind="llm_response", message="Model responded", details={"provider": "google", "model_name": "gemini", "tool_calls": 1, "tool_call_names": ["get_page_context"], "content_preview": "{\"page_type\":\"hosting_page\"}", "input_tokens": 11, "output_tokens": 7, "prompt": {"prompt_version": "classification:v1", "prompt_hash": "hash-a", "cache_mode": "provider_hook"}}),
            RuntimeEvent(seq=6, actor="classification", kind="agent_finished", message="Classification decided hosting_page", status="success"),
            RuntimeEvent(seq=7, actor="hosting", kind="agent_started", message="Hosting page agent started for https://example.com/watch"),
            RuntimeEvent(seq=8, actor="hosting", kind="memory_loaded", message="Loaded site memory hints for hosting_page", details={"page_type": "hosting_page", "url": "https://example.com/watch", "hint_preview": "SITE MEMORY HINTS"}),
            RuntimeEvent(seq=9, actor="hosting", kind="prompt_compiled", message="prompt", details={"agent_id": "hosting_page", "prompt_version": "hosting_page:v1", "prompt_hash": "hash-b", "compiled_prompt_hash": "compiled-b", "cache_mode": "provider_hook", "memory_injected": True, "sections": ["base_policy", "site_memory_hints", "working_state"]}),
            RuntimeEvent(seq=10, actor="hosting", kind="agent_loop_started", message="loop", details={"max_tool_calls": 20}),
            RuntimeEvent(seq=11, actor="hosting", kind="tool_call_started", message="Calling query_elements", details={"tool_name": "query_elements", "tool_args": {"text": "Server 2"}}),
            RuntimeEvent(seq=12, actor="hosting", kind="tool_call_finished", message="query_elements completed", status="success", details={"tool_name": "query_elements", "duration_seconds": 0.3, "result_preview": "{\"ok\":true}"}),
            RuntimeEvent(seq=13, actor="hosting", kind="llm_response", message="Model responded", details={"provider": "google", "model_name": "gemini", "tool_calls": 0, "tool_call_names": [], "content_preview": "{\"status\":\"success\"}", "input_tokens": 13, "output_tokens": 9, "prompt": {"prompt_version": "hosting_page:v1", "prompt_hash": "hash-b", "cache_mode": "provider_hook"}}),
            RuntimeEvent(seq=14, actor="hosting", kind="agent_finished", message="Hosting page agent finished", status="success"),
            RuntimeEvent(seq=15, actor="orchestrator", kind="pipeline_finished", message="Pipeline finished with status success", status="success"),
        ],
        metrics=_build_result().metrics,
    )


def test_run_repository_dual_writes_legacy_and_normalized_rows():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)

    session = Session(engine)
    repo = RunRepository(session)
    result = _build_result()
    trace = _build_trace()

    record = repo.save(result, trace=trace)

    assert record.page_type == "hosting_page"
    assert record.status == "success"
    assert record.streams_found == 1
    assert session.query(PipelineRunRecord).count() == 1
    assert session.query(RunSnapshotRecord).count() == 1
    assert session.query(AgentRunRecord).count() >= 2
    assert session.query(MemoryEntryRecord).count() >= 1


def test_run_repository_backfills_normalized_rows_from_legacy_snapshot():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)

    session = Session(engine)
    repo = RunRepository(session)
    result = _build_result()
    repo._upsert_legacy_run(result)
    session.commit()

    count = repo.backfill_normalized_from_legacy()

    assert count == 1
    assert session.query(PipelineRunRecord).count() == 1
