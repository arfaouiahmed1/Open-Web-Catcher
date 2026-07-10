from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.storage.models import Base, PipelineRunRecord, RuntimeEventRecord
from src.storage.ui_repository import OperatorConsoleRepository


def _repo_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = session_factory()
    return OperatorConsoleRepository(session), session


def test_overview_returns_strict_status_and_trend_metrics_without_agent_success() -> None:
    repo, session = _repo_session()
    try:
        now = datetime.utcnow().replace(hour=12, minute=0, second=0, microsecond=0)
        rows = [
            PipelineRunRecord(
                run_id="success-run",
                root_url="https://success.example/live",
                final_status="success",
                success=True,
                stream_count=2,
                created_at=now,
            ),
            PipelineRunRecord(
                run_id="site-dead-run",
                root_url="https://dead.example/live",
                final_status="site_dead",
                success=False,
                created_at=now - timedelta(hours=1),
            ),
            PipelineRunRecord(
                run_id="empty-run",
                root_url="https://empty.example/live",
                final_status="no_streams",
                success=False,
                created_at=now - timedelta(hours=2),
            ),
            PipelineRunRecord(
                run_id="failed-run",
                root_url="https://failed.example/live",
                final_status="failed",
                success=False,
                stream_count=1,
                provider_analysis_count=1,
                failure_mode="agent assertion failed",
                created_at=now - timedelta(hours=3),
            ),
            PipelineRunRecord(
                run_id="cancelled-run",
                root_url="https://cancelled.example/live",
                final_status="cancelled",
                success=False,
                created_at=now - timedelta(hours=4),
            ),
        ]
        session.add_all(rows)
        session.commit()

        overview = repo.get_overview(limit=10)
        summary = overview["summary"]
        today = overview["trend"][-1]

        assert summary["success_rate"] == 0.2
        assert "adjusted_success_rate" not in summary
        assert "agent_failure_rate" not in summary
        assert "external_blocked_rate" not in summary
        assert "status_bucket_breakdown" not in summary
        assert today["successes"] == 1
        assert today["failures"] == 3
    finally:
        session.close()


def test_overview_exposes_llm_provider_blockers_without_changing_strict_rate() -> None:
    repo, session = _repo_session()
    try:
        now = datetime.utcnow()
        rate_limited = PipelineRunRecord(
            run_id="rate-limited-run",
            root_url="https://quota.example/live",
            final_status="failed",
            success=False,
            failure_mode="google_genai ResourceExhausted 429 quota exceeded",
            created_at=now,
        )
        api_down = PipelineRunRecord(
            run_id="api-down-run",
            root_url="https://timeout.example/live",
            final_status="failed",
            success=False,
            failure_mode="TimeoutError",
            created_at=now - timedelta(minutes=1),
        )
        hard_failure = PipelineRunRecord(
            run_id="hard-failed-run",
            root_url="https://failed.example/live",
            final_status="failed",
            success=False,
            failure_mode="agent assertion failed",
            created_at=now - timedelta(minutes=2),
        )
        session.add_all([rate_limited, api_down, hard_failure])
        session.flush()
        session.add(
            RuntimeEventRecord(
                pipeline_run_id=api_down.id,
                actor="landing",
                seq=1,
                kind="llm_timeout",
                status="error",
                message="Model call timed out after 90s",
                details_json={"provider": "google", "model_name": "gemini-3.1-flash-lite"},
                created_at=now,
            )
        )
        session.commit()

        overview = repo.get_overview(limit=10)
        summary = overview["summary"]
        rows = repo.list_runs(status="llm_rate_limited", limit=10)["rows"]

        assert summary["success_rate"] == 0.0
        assert summary["llm_provider_status"] == "rate_limited"
        assert summary["llm_provider_blocked_runs"] == 2
        assert summary["llm_rate_limited_runs"] == 1
        assert summary["llm_api_down_runs"] == 1
        assert rows[0]["final_status"] == "llm_rate_limited"
    finally:
        session.close()


def test_overview_counts_distinct_working_sites_and_no_stream_hosting_runs() -> None:
    repo, session = _repo_session()
    try:
        now = datetime.utcnow()
        rows = [
            PipelineRunRecord(
                run_id="duplicate-success-run",
                root_url="https://duplicate.example/live",
                final_status="success",
                success=True,
                stream_count=1,
                created_at=now,
            ),
            PipelineRunRecord(
                run_id="duplicate-partial-run",
                root_url="HTTPS://DUPLICATE.EXAMPLE/LIVE",
                final_status="partial",
                success=False,
                created_at=now - timedelta(minutes=1),
            ),
            PipelineRunRecord(
                run_id="other-partial-run",
                root_url="https://other.example/live",
                final_status="partial",
                success=False,
                created_at=now - timedelta(minutes=2),
            ),
            PipelineRunRecord(
                run_id="no-streams-run",
                root_url="https://empty.example/live",
                final_status="no_streams",
                success=False,
                created_at=now - timedelta(minutes=3),
            ),
            PipelineRunRecord(
                run_id="no-hosting-run",
                root_url="https://portal.example/live",
                final_status="no_hosting_pages",
                success=False,
                created_at=now - timedelta(minutes=4),
            ),
            PipelineRunRecord(
                run_id="hard-failure-run",
                root_url="https://failed.example/live",
                final_status="failed",
                success=False,
                created_at=now - timedelta(minutes=5),
            ),
        ]
        session.add_all(rows)
        session.commit()

        summary = repo.get_overview(limit=10)["summary"]

        assert summary["distinct_working_websites"] == 2
        assert summary["no_stream_or_hosting_runs"] == 2
    finally:
        session.close()
