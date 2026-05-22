from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.storage.models import Base, PipelineRunRecord
from src.storage.ui_repository import OperatorConsoleRepository


def _repo_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = session_factory()
    return OperatorConsoleRepository(session), session


def test_overview_returns_strict_adjusted_and_bucketed_trend_metrics() -> None:
    repo, session = _repo_session()
    try:
        now = datetime.utcnow()
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
        assert summary["adjusted_success_rate"] == 0.75
        assert summary["agent_failure_rate"] == 0.25
        assert summary["external_blocked_rate"] == 0.5
        assert summary["status_bucket_breakdown"] == {
            "productive_success": 1,
            "external_or_expected_blocker": 2,
            "agent_failure": 1,
            "cancelled": 1,
        }
        assert today["successes"] == 1
        assert today["agent_failures"] == 1
        assert today["external_blockers"] == 2
    finally:
        session.close()
