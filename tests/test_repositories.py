from __future__ import annotations

from datetime import datetime

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import (
    ClassificationResult,
    ExtractionResult,
    ModelUsage,
    PipelineResult,
    ProviderInfo,
    RunMetrics,
    StreamURL,
    TakedownEmail,
)
from src.storage.models import (
    AgentRunRecord,
    Base,
    LLMCallRecord,
    MemoryEntryRecord,
    PipelineRunRecord,
    RunSnapshotRecord,
)
from src.storage.repositories import RunRepository
from src.storage.ui_repository import OperatorConsoleRepository
from src.utils.observability import ObservabilityStatus, RunTrace, RuntimeEvent


def _build_result(
    *,
    run_id: str = "run-1",
    final_status: ExtractionStatus = ExtractionStatus.SUCCESS,
    tokens_in: int = 11,
    tokens_out: int = 7,
    llm_calls: int = 1,
    tool_calls: int = 1,
    duration_seconds: float = 9.5,
    total_cost_usd: float = 0.12,
    provider_name: str = "Example CDN",
    model_name: str = "gemini",
) -> PipelineResult:
    extraction = ExtractionResult(
        url="https://example.com/watch",
        page_type=PageType.HOSTING,
        status=final_status,
        streams=[StreamURL(url="https://cdn.example.com/master.m3u8", protocol="hls")],
        screenshots=["https://img.example.com/1.png"],
        agent_type=AgentType.HOSTING_PAGE,
        metadata={"decision": "safe_exit", "servers": [{"label": "Server 2"}]},
    )
    provider = ProviderInfo(stream_url="https://cdn.example.com/master.m3u8", provider=provider_name)
    email = TakedownEmail(
        provider=provider_name,
        abuse_email="abuse@example.com",
        subject="test",
        body="body",
        infringing_url="https://example.com/watch",
        stream_urls=["https://cdn.example.com/master.m3u8"],
    )
    return PipelineResult(
        run_id=run_id,
        url="https://example.com/watch",
        classification=ClassificationResult(
            url="https://example.com/watch",
            page_type=PageType.HOSTING,
            confidence=Confidence.HIGH,
            reasoning="Has a player.",
        ),
        extraction_results=[extraction],
        final_status=final_status,
        all_streams=[StreamURL(url="https://cdn.example.com/master.m3u8", protocol="hls")],
        all_screenshots=["https://img.example.com/1.png"],
        provider_analysis=[provider],
        takedown_emails=[email],
        metrics=RunMetrics(
            run_id=run_id,
            url="https://example.com/watch",
            total_tokens_in=tokens_in,
            total_tokens_out=tokens_out,
            total_llm_calls=llm_calls,
            total_tool_calls=tool_calls,
            total_duration_seconds=duration_seconds,
            estimated_total_cost_usd=total_cost_usd,
            model_usage=[
                ModelUsage(
                    model_name=model_name,
                    provider="google",
                    llm_calls=llm_calls,
                    input_tokens=tokens_in,
                    output_tokens=tokens_out,
                    estimated_total_cost_usd=total_cost_usd,
                )
            ],
            success=final_status in {ExtractionStatus.SUCCESS, ExtractionStatus.PARTIAL},
            failure_mode="" if final_status in {ExtractionStatus.SUCCESS, ExtractionStatus.PARTIAL} else "failed",
        ),
    )


def _build_trace(
    *,
    run_id: str = "run-1",
    tool_finish_status: str = "success",
    model_name: str = "gemini",
) -> RunTrace:
    observability = ObservabilityStatus(
        enabled=True,
        project="test",
        pricing_models=["gemini"],
        default_dataset_name="test",
    )
    return RunTrace(
        run_id=run_id,
        root_actor="orchestrator",
        started_at=datetime.utcnow(),
        observability=observability,
        events=[
            RuntimeEvent(seq=1, actor="orchestrator", kind="pipeline_started", message="Pipeline started for https://example.com/watch"),
            RuntimeEvent(seq=2, actor="classification", kind="agent_started", message="Classification agent started for https://example.com/watch"),
            RuntimeEvent(seq=3, actor="classification", kind="prompt_compiled", message="prompt", details={"agent_id": "classification", "prompt_version": "classification:v1", "prompt_hash": "hash-a", "compiled_prompt_hash": "compiled-a", "cache_mode": "provider_hook", "sections": ["base_policy", "task_brief"]}),
            RuntimeEvent(seq=4, actor="classification", kind="agent_loop_started", message="loop", details={"max_tool_calls": 5}),
            RuntimeEvent(seq=5, actor="classification", kind="llm_response", message="Model responded", details={"provider": "google", "model_name": model_name, "tool_calls": 1, "tool_call_names": ["get_page_context"], "content_preview": "{\"page_type\":\"hosting_page\"}", "input_tokens": 11, "output_tokens": 7, "estimated_input_cost_usd": 0.000011, "estimated_output_cost_usd": 0.000014, "estimated_total_cost_usd": 0.000025, "cost_source": "provider_pricing_catalog", "pricing": {"provider": "google", "input_per_million": 1.0, "output_per_million": 2.0}, "prompt": {"prompt_version": "classification:v1", "prompt_hash": "hash-a", "cache_mode": "provider_hook"}}),
            RuntimeEvent(seq=6, actor="classification", kind="agent_finished", message="Classification decided hosting_page", status="success"),
            RuntimeEvent(seq=7, actor="hosting", kind="agent_started", message="Hosting page agent started for https://example.com/watch"),
            RuntimeEvent(seq=8, actor="hosting", kind="memory_loaded", message="Loaded site memory hints for hosting_page", details={"page_type": "hosting_page", "url": "https://example.com/watch", "hint_preview": "SITE MEMORY HINTS"}),
            RuntimeEvent(seq=9, actor="hosting", kind="prompt_compiled", message="prompt", details={"agent_id": "hosting_page", "prompt_version": "hosting_page:v1", "prompt_hash": "hash-b", "compiled_prompt_hash": "compiled-b", "cache_mode": "provider_hook", "memory_injected": True, "sections": ["base_policy", "site_memory_hints", "working_state"]}),
            RuntimeEvent(seq=10, actor="hosting", kind="agent_loop_started", message="loop", details={"max_tool_calls": 20}),
            RuntimeEvent(seq=11, actor="hosting", kind="tool_call_started", message="Calling query_elements", details={"tool_name": "query_elements", "tool_args": {"text": "Server 2"}}),
            RuntimeEvent(seq=12, actor="hosting", kind="tool_call_finished", message="query_elements completed", status=tool_finish_status, details={"tool_name": "query_elements", "duration_seconds": 0.3, "result_preview": "{\"ok\":true}"}),
            RuntimeEvent(seq=13, actor="hosting", kind="llm_response", message="Model responded", details={"provider": "google", "model_name": model_name, "tool_calls": 0, "tool_call_names": [], "content_preview": "{\"status\":\"success\"}", "input_tokens": 13, "output_tokens": 9, "estimated_input_cost_usd": 0.000013, "estimated_output_cost_usd": 0.000018, "estimated_total_cost_usd": 0.000031, "cost_source": "provider_pricing_catalog", "pricing": {"provider": "google", "input_per_million": 1.0, "output_per_million": 2.0}, "prompt": {"prompt_version": "hosting_page:v1", "prompt_hash": "hash-b", "cache_mode": "provider_hook"}}),
            RuntimeEvent(seq=14, actor="hosting", kind="agent_finished", message="Hosting page agent finished", status="success"),
            RuntimeEvent(seq=15, actor="orchestrator", kind="pipeline_finished", message="Pipeline finished with status success", status="success"),
        ],
        metrics=_build_result(run_id=run_id, model_name=model_name).metrics,
    )


def _session() -> Session:
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return Session(engine)


def test_run_repository_dual_writes_legacy_and_normalized_rows():
    session = _session()
    repo = RunRepository(session)

    record = repo.save(_build_result(), trace=_build_trace())

    assert record.page_type == "hosting_page"
    assert record.status == "success"
    assert record.streams_found == 1
    assert session.query(PipelineRunRecord).count() == 1
    assert session.query(RunSnapshotRecord).count() == 1
    assert session.query(AgentRunRecord).count() >= 2
    llm_rows = session.query(LLMCallRecord).all()
    assert llm_rows
    assert sum(float(row.estimated_total_cost_usd or 0.0) for row in llm_rows) > 0.0
    assert session.query(MemoryEntryRecord).count() >= 1


def test_run_repository_backfills_normalized_rows_from_legacy_snapshot():
    session = _session()
    repo = RunRepository(session)
    repo._upsert_legacy_run(_build_result())
    session.commit()

    count = repo.backfill_normalized_from_legacy()

    assert count == 1
    assert session.query(PipelineRunRecord).count() == 1


def test_operator_console_repository_builds_db_backed_overview_and_seeds_evaluations():
    session = _session()
    run_repo = RunRepository(session)
    run_repo.save(
        _build_result(run_id="run-1", total_cost_usd=0.12, model_name="gemini"),
        trace=_build_trace(run_id="run-1", tool_finish_status="success", model_name="gemini"),
    )
    run_repo.save(
        _build_result(
            run_id="run-2",
            final_status=ExtractionStatus.PARTIAL,
            tokens_in=20,
            tokens_out=10,
            llm_calls=2,
            tool_calls=2,
            duration_seconds=3.2,
            total_cost_usd=0.44,
            provider_name="Backup CDN",
            model_name="gemini-flash",
        ),
        trace=_build_trace(run_id="run-2", tool_finish_status="error", model_name="gemini-flash"),
    )
    run_repo.save(
        _build_result(
            run_id="run-3",
            final_status=ExtractionStatus.FAILED,
            tokens_in=5,
            tokens_out=3,
            llm_calls=1,
            tool_calls=0,
            duration_seconds=7.0,
            total_cost_usd=0.05,
            provider_name="Example CDN",
            model_name="gemini",
        ),
        trace=_build_trace(run_id="run-3", tool_finish_status="success", model_name="gemini"),
    )
    repo = OperatorConsoleRepository(session)

    overview = repo.get_overview(active_traces=[{"run_id": "active-1"}], limit=5)
    suites = repo.ensure_default_evaluation_suites()
    table = repo.list_database_table("pipeline_runs", limit=10, offset=0)

    assert overview["summary"]["total_runs"] == 3
    assert overview["summary"]["active_runs"] == 1
    assert overview["summary"]["total_tokens"] == 56
    assert overview["summary"]["total_cost_usd"] == 0.61
    assert overview["summary"]["tool_success_rate"] == 0.6667
    assert overview["summary"]["avg_cost_usd"] == 0.203333
    assert overview["model_breakdown"]
    assert overview["provider_breakdown"]
    assert overview["top_tools"][0]["tool_name"] == "query_elements"
    assert len(suites) >= 1
    assert table["table"] == "pipeline_runs"
    assert "run_id" in table["columns"]
    assert table["total"] == 3


def test_operator_console_repository_persists_tool_playground_history():
    session = _session()
    repo = OperatorConsoleRepository(session)

    repo.record_tool_playground_call(
        call_id="call-1",
        profile="hosting",
        tool_name="capture_streams",
        args={"frame_path": "root"},
        status="success",
        duration_seconds=0.42,
        result={"ok": True},
    )
    repo.record_tool_playground_call(
        call_id="call-2",
        profile="hosting",
        tool_name="capture_streams",
        args={"frame_path": "player"},
        status="error",
        duration_seconds=0.91,
        error_text="timeout",
        origin="evaluation",
        related_run_id="eval-1",
    )

    history = repo.list_tool_playground_calls(limit=10, offset=0, profile="hosting")
    table = repo.list_database_table("tool_playground_calls", limit=10, offset=0)

    assert history["total"] == 2
    assert history["rows"][0]["tool_name"] == "capture_streams"
    assert table["table"] == "tool_playground_calls"
    assert table["total"] == 2


def test_operator_console_repository_persists_provider_lookup_history():
    session = _session()
    repo = OperatorConsoleRepository(session)

    rows = repo.record_provider_lookup_batch(
        "lookup-1",
        [
            ProviderInfo(
                stream_url="https://cdn.example.com/live/master.m3u8",
                hostname="cdn.example.com",
                ip="1.2.3.4",
                org="AS13335 Cloudflare, Inc.",
                provider="Cloudflare, Inc.",
                country="US",
                abuse_email="abuse@cloudflare.com",
            ),
            ProviderInfo(
                stream_url="https://video.example.net/index.m3u8",
                hostname="video.example.net",
                ip="5.6.7.8",
                org="AS9000 Example Networks",
                provider="Example Networks",
                country="DE",
            ),
        ],
    )
    history = repo.get_provider_lookup_history(limit=10, offset=0)
    table = repo.list_database_table("provider_lookup_checks", limit=10, offset=0)

    assert len(rows) == 2
    assert history["summary"]["total_checks"] == 2
    assert history["summary"]["resolved_ips"] == 2
    assert history["summary"]["abuse_contacts_found"] == 1
    assert table["table"] == "provider_lookup_checks"
    assert table["total"] == 2
