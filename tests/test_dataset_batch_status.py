from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.storage.dataset_repository import DatasetRepository
from src.storage.models import Base, DatasetBatchRecord, DatasetSiteRunRecord


def _repo_session():
    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    session_factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    session = session_factory()
    return DatasetRepository(session), session


def test_created_batch_starts_queued_with_site_runs() -> None:
    repo, session = _repo_session()
    try:
        created = repo.create_batch(
            urls=["https://one.example/live", "https://two.example/live"],
            batch_name="Smoke batch",
        )

        payload = repo.get_batch(created["batch_id"])

        assert payload["status"] == "queued"
        assert payload["requested_count"] == 2
        assert payload["completed_count"] == 0
        assert [run["status"] for run in payload["runs"]] == ["queued", "queued"]
        assert {run["batch_status"] for run in payload["runs"]} == {"queued"}
    finally:
        session.close()


def test_cancel_batch_marks_only_non_terminal_site_runs_cancelled() -> None:
    repo, session = _repo_session()
    try:
        created = repo.create_batch(
            urls=[
                "https://queued.example/live",
                "https://running.example/live",
                "https://done.example/live",
            ],
            batch_name="Cancel batch",
        )
        batch = session.query(DatasetBatchRecord).filter_by(batch_id=created["batch_id"]).one()
        rows = (
            session.query(DatasetSiteRunRecord)
            .filter_by(batch_id=batch.id)
            .order_by(DatasetSiteRunRecord.id.asc())
            .all()
        )
        rows[1].status = "running"
        rows[2].status = "success"
        rows[2].final_status = "success"
        session.commit()

        payload = repo.cancel_batch(created["batch_id"], reason="operator stop")

        assert payload["cancelled"] == 2
        assert payload["skipped"] == 1
        assert payload["batch"]["status"] == "partial"
        assert [run["final_status"] for run in payload["batch"]["runs"]] == [
            "cancelled",
            "cancelled",
            "success",
        ]
    finally:
        session.close()


@pytest.mark.parametrize("active_status", ["retrying", "leased"])
def test_retrying_and_leased_site_runs_keep_batch_running(active_status: str) -> None:
    repo, session = _repo_session()
    try:
        created = repo.create_batch(
            urls=["https://active.example/live", "https://done.example/live"],
            batch_name="Active batch",
        )
        batch = session.query(DatasetBatchRecord).filter_by(batch_id=created["batch_id"]).one()
        rows = (
            session.query(DatasetSiteRunRecord)
            .filter_by(batch_id=batch.id)
            .order_by(DatasetSiteRunRecord.id.asc())
            .all()
        )
        rows[0].status = active_status
        rows[1].status = "success"
        rows[1].final_status = "success"
        session.commit()

        payload = repo.get_batch(created["batch_id"])

        assert payload["status"] == "running"
        assert payload["completed_count"] == 1
        assert {run["batch_status"] for run in payload["runs"]} == {"running"}

        repo._refresh_batch_metrics(batch.id)
        session.flush()
        session.refresh(batch)
        assert batch.status == "running"

        site_payload = repo.list_sites(query="active.example", limit=1)["sites"][0]
        assert site_payload["active_run_count"] == 1
    finally:
        session.close()
