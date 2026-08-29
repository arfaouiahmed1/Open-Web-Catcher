from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from src.storage.dataset_repository import DatasetRepository
from src.storage.models import Base, DatasetBatchRecord, DatasetSiteRecord, DatasetSiteRunRecord


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


def test_bulk_delete_sites_removes_unique_matching_rows() -> None:
    repo, session = _repo_session()
    try:
        first = repo.create_site(url="https://one.example/live", language="english", label="sports")
        second = repo.create_site(url="https://two.example/live", language="english", label="sports")

        deleted = repo.bulk_delete_sites([first["id"], first["id"], 999999])

        remaining = repo.list_sites(limit=0)["sites"]
        assert deleted == 1
        assert [site["id"] for site in remaining] == [second["id"]]
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


def test_batch_adjusted_success_counts_external_blockers_and_excludes_cancelled() -> None:
    repo, session = _repo_session()
    try:
        created = repo.create_batch(
            urls=[
                "https://success.example/live",
                "https://inaccessible.example/live",
                "https://empty.example/live",
                "https://failed.example/live",
                "https://cancelled.example/live",
            ],
            batch_name="Adjusted metrics",
        )
        batch = session.query(DatasetBatchRecord).filter_by(batch_id=created["batch_id"]).one()
        rows = (
            session.query(DatasetSiteRunRecord)
            .filter_by(batch_id=batch.id)
            .order_by(DatasetSiteRunRecord.id.asc())
            .all()
        )
        statuses = ["success", "page_inaccessible", "no_streams", "failed", "cancelled"]
        now = datetime.now(UTC)
        for row, status in zip(rows, statuses, strict=True):
            row.status = status
            row.final_status = status
            row.started_at = now
            row.finished_at = now
        for site_id in {row.site_id for row in rows if row.site_id is not None}:
            repo._refresh_site_metrics(int(site_id))
        repo._refresh_batch_metrics(batch.id)
        session.commit()

        payload = repo.get_batch(created["batch_id"])

        assert payload["status"] == "partial"
        assert payload["success_rate"] == 20.0
        assert payload["adjusted_success_rate"] == 75.0
        assert payload["agent_failed_count"] == 1
        assert payload["external_blocked_count"] == 2
        assert payload["strict_failed_count"] == 3
        assert payload["terminal_non_cancelled_count"] == 4
    finally:
        session.close()


def test_site_payload_exposes_adjusted_metrics_without_changing_strict_counts() -> None:
    repo, session = _repo_session()
    try:
        created = repo.create_batch(
            urls=[
                "https://one-site.example/live",
                "https://one-site.example/live?retry=1",
                "https://one-site.example/live?retry=2",
                "https://one-site.example/live?retry=3",
            ],
            batch_name="Site metrics",
        )
        batch = session.query(DatasetBatchRecord).filter_by(batch_id=created["batch_id"]).one()
        first_site = session.query(DatasetSiteRecord).filter_by(canonical_url="https://one-site.example/live").one()
        rows = (
            session.query(DatasetSiteRunRecord)
            .filter_by(batch_id=batch.id)
            .order_by(DatasetSiteRunRecord.id.asc())
            .all()
        )
        statuses = ["success", "page_inaccessible", "failed", "cancelled"]
        now = datetime.now(UTC)
        for row, status in zip(rows, statuses, strict=True):
            row.site_id = first_site.id
            row.status = status
            row.final_status = status
            row.started_at = now
            row.finished_at = now
        session.flush()
        repo._refresh_site_metrics(first_site.id)
        repo._refresh_batch_metrics(batch.id)
        session.commit()

        site_payload = repo._site_payload(first_site)

        assert site_payload["total_runs"] == 4
        assert site_payload["successful_runs"] == 1
        assert site_payload["failed_runs"] == 2
        assert site_payload["success_rate"] == 25.0
        assert site_payload["adjusted_success_rate"] == 66.7
        assert site_payload["external_blocked_count"] == 1
        assert site_payload["agent_failed_count"] == 1
        assert site_payload["strict_failed_count"] == 2
    finally:
        session.close()
