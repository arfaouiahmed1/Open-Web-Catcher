"""Database-backed dataset management for the operator console."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from src.storage.database import get_session
from src.storage.dataset_repository import DatasetRepository, LABELS, LANGUAGES
from src.storage.repositories import BackgroundJobRepository

router = APIRouter(prefix="/api/datasets", tags=["datasets"])

REPO_ROOT = Path(__file__).resolve().parents[2]
SITES_CSV = (REPO_ROOT / "datasets" / "sites.csv").resolve()


class SiteUpdate(BaseModel):
    language: str | None = None
    label: str | None = None
    notes: str | None = None


class BulkUpdate(BaseModel):
    ids: list[int] = Field(default_factory=list)
    language: str | None = None
    label: str | None = None
    notes: str | None = None


class DatasetBatchRequest(BaseModel):
    batch_name: str = ""
    language: str = ""
    label: str = ""
    limit: int = 20
    urls: list[str] = Field(default_factory=list)


def _with_repo(callback):
    session = get_session()
    try:
        repo = DatasetRepository(session)
        repo.ensure_seeded_from_csv(SITES_CSV)
        return callback(session, repo)
    finally:
        session.close()


@router.get("/meta")
def get_meta():
    def _handler(_: Any, repo: DatasetRepository):
        return {
            "languages": LANGUAGES,
            "labels": LABELS,
            "stats": repo.site_stats(),
            "csv": {
                "path": str(SITES_CSV),
                "exists": SITES_CSV.exists(),
            },
        }

    return _with_repo(_handler)


@router.post("/import")
def import_sites():
    result = _with_repo(lambda _session, repo: repo.import_csv(SITES_CSV, source="csv_import"))
    if result.get("missing"):
        raise HTTPException(status_code=404, detail=f"Dataset CSV not found at {result.get('csv_path')}")
    return result


@router.get("/sites")
def list_sites(
    language: str = Query("", description="Filter by language"),
    label: str = Query("", description="Filter by label"),
    query: str = Query("", description="Search sites"),
    limit: int = Query(0, description="Max results (0=all)"),
    offset: int = Query(0),
):
    return _with_repo(
        lambda _session, repo: repo.list_sites(
            language=language,
            label=label,
            query=query,
            limit=limit,
            offset=offset,
        )
    )


@router.get("/sites/stats")
def get_stats():
    return _with_repo(lambda _session, repo: repo.site_stats())


@router.patch("/sites/{site_id}")
def update_site(site_id: int, update: SiteUpdate):
    def _handler(_: Any, repo: DatasetRepository):
        try:
            return repo.update_site(
                site_id,
                language=update.language,
                label=update.label,
                notes=update.notes,
            )
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return _with_repo(_handler)


@router.post("/sites/bulk-update")
def bulk_update(update: BulkUpdate):
    return _with_repo(
        lambda _session, repo: {
            "updated": repo.bulk_update(
                update.ids,
                language=update.language,
                label=update.label,
                notes=update.notes,
            )
        }
    )


@router.get("/results")
def get_results(language: str = Query(""), label: str = Query("")):
    return _with_repo(lambda _session, repo: repo.results_summary(language=language, label=label))


@router.post("/results/record")
def record_result(
    url: str = Query(...),
    success: bool = Query(...),
    language: str = Query(""),
    label: str = Query(""),
):
    return _with_repo(
        lambda _session, repo: repo.record_result(
            url=url,
            success=success,
            language=language,
            label=label,
        )
    )


@router.get("/batches")
def list_batches(limit: int = Query(20, ge=1, le=200), offset: int = Query(0, ge=0)):
    return _with_repo(lambda _session, repo: repo.list_batches(limit=limit, offset=offset))


@router.get("/batches/{batch_id}")
def get_batch(batch_id: str):
    def _handler(_: Any, repo: DatasetRepository):
        try:
            return repo.get_batch(batch_id)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return _with_repo(_handler)


@router.post("/batches")
def create_batch(req: DatasetBatchRequest):
    def _handler(session, repo: DatasetRepository):
        urls = [str(item or "").strip() for item in req.urls if str(item or "").strip()]
        if not urls:
            payload = repo.list_sites(
                language=req.language,
                label=req.label,
                query="",
                limit=max(1, int(req.limit or 20)),
                offset=0,
            )
            urls = [str(site.get("url", "") or "").strip() for site in payload.get("sites", []) if str(site.get("url", "") or "").strip()]
        if not urls:
            raise HTTPException(status_code=400, detail="No dataset URLs matched this batch request.")

        created = repo.create_batch(
            urls=urls,
            batch_name=req.batch_name,
            language_filter=req.language,
            label_filter=req.label,
            source="manual_urls" if req.urls else "dataset",
        )
        job_repo = BackgroundJobRepository(session)
        for row in created.get("runs", []):
            job_repo.enqueue(
                run_id=str(row.get("run_id", "") or ""),
                job_type="workflow",
                url=str(row.get("url", "") or ""),
                actor="orchestrator",
                payload={
                    "url": str(row.get("url", "") or ""),
                    "dataset_batch_id": str(created.get("batch_id", "") or ""),
                    "dataset_site_id": row.get("site_id"),
                    "dataset_site_run_id": row.get("site_run_id"),
                },
                idempotency_key="",
            )
        return repo.get_batch(str(created.get("batch_id", "") or ""))

    return _with_repo(_handler)
