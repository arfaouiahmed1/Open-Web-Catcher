"""Database-backed dataset management for the operator console."""

from __future__ import annotations

import asyncio
import json
import re
import time as _time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from src.storage.database import get_session
from src.storage.dataset_repository import DatasetRepository, LABELS, LANGUAGES
from src.storage.repositories import BackgroundJobRepository

router = APIRouter(prefix="/api/datasets", tags=["datasets"])
DEFAULT_SITES_CSV = Path(__file__).resolve().parents[2] / "datasets" / "sites.csv"
_SSE_KEEPALIVE_SECONDS = 20.0
_SITE_HEALTH_CONCURRENCY = 16
_SITE_HEALTH_MAX_CHECKS = 1000
_SITE_HEALTH_SAMPLE_BYTES = 65536
_SITE_HEALTH_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)
_SITE_DOWN_TEXT_RE = re.compile(
    r"(site\s+(is\s+)?down|website\s+unavailable|currently\s+unavailable|"
    r"temporarily\s+unavailable|service\s+unavailable|under\s+maintenance|"
    r"account\s+suspended|domain\s+(expired|suspended)|default\s+web\s+site\s+page|"
    r"apache2?\s+debian\s+default\s+page|nginx\s+default|404\s+not\s+found|"
    r"this\s+site\s+can't\s+be\s+reached)",
    re.IGNORECASE,
)
_SITE_SEIZED_TEXT_RE = re.compile(
    r"(federal\s+bureau\s+of\s+investigation|department\s+of\s+justice|"
    r"homeland\s+security|this\s+domain\s+(name\s+)?has\s+been\s+seized|"
    r"domain\s+seized|seized\s+by|ice\s*-\s*homeland\s+security|interpol)",
    re.IGNORECASE,
)
_SITE_PARKED_TEXT_RE = re.compile(
    r"(parked\s+domain|domain\s+parking|buy\s+this\s+domain|this\s+domain\s+is\s+for\s+sale|"
    r"sedo\s+domain\s+parking|namecheap\s+parking|godaddy\s+parking)",
    re.IGNORECASE,
)
_SITE_BLOCKED_TEXT_RE = re.compile(
    r"(just\s+a\s+moment|checking\s+your\s+browser|verify\s+you\s+are\s+human|"
    r"captcha|access\s+denied|attention\s+required|cloudflare|ddos-guard|"
    r"enable\s+javascript\s+and\s+cookies|forbidden)",
    re.IGNORECASE,
)


class SiteUpdate(BaseModel):
    url: str | None = None
    language: str | None = None
    label: str | None = None
    notes: str | None = None


class SiteCreate(BaseModel):
    url: str
    language: str = ""
    label: str = ""
    notes: str = ""


class BulkUpdate(BaseModel):
    ids: list[int] = Field(default_factory=list)
    language: str | None = None
    label: str | None = None
    notes: str | None = None


class BulkDelete(BaseModel):
    ids: list[int] = Field(default_factory=list)


class SiteHealthCheckRequest(BaseModel):
    site_ids: list[int] = Field(default_factory=list)
    urls: list[str] = Field(default_factory=list)
    timeout_seconds: float = Field(default=5.0, ge=1.0, le=15.0)
    limit: int = Field(default=80, ge=1, le=_SITE_HEALTH_MAX_CHECKS)


class DatasetBatchRequest(BaseModel):
    batch_name: str = ""
    language: str = ""
    label: str = ""
    query: str = ""
    limit: int = 0
    urls: list[str] = Field(default_factory=list)


def _with_repo(callback):
    session = get_session()
    try:
        repo = DatasetRepository(session)
        return callback(session, repo)
    finally:
        session.close()


def _seed_default_sites_if_empty(repo: DatasetRepository) -> None:
    repo.ensure_seeded_from_csv(DEFAULT_SITES_CSV)


def _health_probe_urls(url: str) -> list[str]:
    raw = str(url or "").strip()
    if not raw:
        return []
    parsed = urlparse(raw)
    if not parsed.scheme and "." in raw and " " not in raw:
        return [f"https://{raw}", f"http://{raw}"]
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return []
    urls = [raw]
    if parsed.scheme == "https":
        urls.append(urlunparse(parsed._replace(scheme="http")))
    return list(dict.fromkeys(urls))


def _health_probe_url(url: str) -> str:
    urls = _health_probe_urls(url)
    return urls[0] if urls else ""


def _site_content_problem(
    *,
    content_type: str = "",
    sample_text: str = "",
    sample_size: int = 0,
) -> tuple[str, str]:
    media_type = str(content_type or "").split(";", 1)[0].strip().lower()
    text = str(sample_text or "").strip()
    text_like = (
        not media_type
        or media_type.startswith("text/")
        or media_type in {
            "application/xhtml+xml",
            "application/xml",
            "application/json",
            "application/javascript",
        }
    )

    if media_type.startswith(("image/", "audio/", "video/")):
        return "asset_only", f"{media_type} response instead of a page"
    if sample_size <= 0:
        return "empty", "no response body sample"
    if text_like and len(text) < 64:
        return "empty", "body sample is too small to confirm a working page"
    if text:
        if _SITE_SEIZED_TEXT_RE.search(text):
            return "seized", "seizure notice detected"
        if _SITE_PARKED_TEXT_RE.search(text):
            return "parked", "parked or for-sale domain text detected"
        if _SITE_BLOCKED_TEXT_RE.search(text):
            return "anti_bot", "anti-bot or access-block page detected"
        if _SITE_DOWN_TEXT_RE.search(text):
            return "down", "down/default/error page text detected"
    return "", ""


def _classify_site_health(
    http_status: int | None = None,
    error: str = "",
    *,
    content_type: str = "",
    sample_text: str = "",
    sample_size: int = 0,
) -> dict[str, Any]:
    if error or http_status is None:
        return {
            "status": "down",
            "tone": "warning",
            "working": False,
            "delete_candidate": True,
            "content_status": "unreachable",
            "content_reason": error or "no HTTP response",
        }
    status = int(http_status)
    if status >= 400:
        if status in {401, 403, 407, 429}:
            return {
                "status": "blocked_access",
                "tone": "warning",
                "working": True,
                "delete_candidate": False,
                "content_status": "blocked_access",
                "content_reason": f"HTTP {status}",
            }
        if status in {405, 406, 409, 451}:
            return {
                "status": "limited",
                "tone": "warning",
                "working": False,
                "delete_candidate": True,
                "content_status": "limited",
                "content_reason": f"HTTP {status}",
            }
        return {
            "status": "down",
            "tone": "warning",
            "working": False,
            "delete_candidate": True,
            "content_status": "http_error",
            "content_reason": f"HTTP {status}",
        }
    problem, reason = _site_content_problem(
        content_type=content_type,
        sample_text=sample_text,
        sample_size=sample_size,
    )
    if problem:
        guarded = problem == "anti_bot"
        return {
            "status": problem,
            "tone": "warning",
            "working": guarded,
            "delete_candidate": not guarded,
            "content_status": problem,
            "content_reason": reason,
        }
    if 200 <= status < 400:
        return {
            "status": "working",
            "tone": "success",
            "working": True,
            "delete_candidate": False,
            "content_status": "ok",
            "content_reason": "page content returned",
        }
    return {
        "status": "down",
        "tone": "warning",
        "working": False,
        "delete_candidate": True,
        "content_status": "unknown",
        "content_reason": f"HTTP {status}",
    }


async def _site_health_request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
) -> dict[str, Any]:
    headers = {"Range": f"bytes=0-{_SITE_HEALTH_SAMPLE_BYTES - 1}"} if method == "GET" else {}
    async with client.stream(method, url, headers=headers) as response:
        sample = bytearray()
        if method == "GET":
            async for chunk in response.aiter_bytes(chunk_size=8192):
                remaining = _SITE_HEALTH_SAMPLE_BYTES - len(sample)
                if remaining <= 0:
                    break
                sample.extend(chunk[:remaining])
                if len(sample) >= _SITE_HEALTH_SAMPLE_BYTES:
                    break
        encoding = response.encoding or "utf-8"
        try:
            sample_text = sample.decode(encoding, errors="ignore") if sample else ""
        except LookupError:
            sample_text = sample.decode("utf-8", errors="ignore") if sample else ""
        return {
            "http_status": int(response.status_code),
            "final_url": str(response.url),
            "content_type": str(response.headers.get("content-type", "") or ""),
            "content_length": str(response.headers.get("content-length", "") or ""),
            "sample_size": len(sample),
            "sample_text": sample_text,
        }


async def _probe_site_health(
    client: httpx.AsyncClient,
    candidate: dict[str, Any],
) -> dict[str, Any]:
    urls = _health_probe_urls(str(candidate.get("url", "") or ""))
    url = urls[0] if urls else ""
    started = _time.perf_counter()
    base_payload = {
        "site_id": candidate.get("site_id"),
        "url": str(candidate.get("url", "") or ""),
        "checked_url": url,
        "attempted_urls": urls,
        "method": "GET",
        "http_status": None,
        "final_url": "",
        "content_type": "",
        "content_length": "",
        "sample_size": 0,
        "latency_ms": 0,
        "error": "",
    }
    if not urls:
        health = _classify_site_health(error="invalid_url")
        return {
            **base_payload,
            **health,
            "error": "invalid_url",
            "latency_ms": round((_time.perf_counter() - started) * 1000),
        }

    best_result: dict[str, Any] | None = None
    for attempt_url in urls:
        try:
            response = await _site_health_request(client, "GET", attempt_url)
            health = _classify_site_health(
                response["http_status"],
                content_type=response.get("content_type", ""),
                sample_text=response.get("sample_text", ""),
                sample_size=int(response.get("sample_size", 0) or 0),
            )
            result = {
                **base_payload,
                **response,
                **health,
                "checked_url": attempt_url,
                "method": "GET",
                "latency_ms": round((_time.perf_counter() - started) * 1000),
            }
            result.pop("sample_text", None)
            if health.get("working"):
                return result
            if best_result is None or not best_result.get("http_status"):
                best_result = result
        except httpx.TimeoutException as exc:
            health = _classify_site_health(error="timeout")
            result = {
                **base_payload,
                **health,
                "checked_url": attempt_url,
                "error": f"timeout: {exc}",
                "latency_ms": round((_time.perf_counter() - started) * 1000),
            }
            if best_result is None:
                best_result = result
        except httpx.HTTPError as exc:
            health = _classify_site_health(error=type(exc).__name__)
            result = {
                **base_payload,
                **health,
                "checked_url": attempt_url,
                "error": f"{type(exc).__name__}: {exc}",
                "latency_ms": round((_time.perf_counter() - started) * 1000),
            }
            if best_result is None:
                best_result = result

    return best_result or {
        **base_payload,
        **_classify_site_health(error="unreachable"),
        "error": "unreachable",
        "latency_ms": round((_time.perf_counter() - started) * 1000),
    }


def _dataset_stream_snapshot() -> dict[str, Any]:
    session = get_session()
    try:
        repo = DatasetRepository(session)
        _seed_default_sites_if_empty(repo)
        stats = repo.site_stats()
        batches_payload = repo.list_batches(limit=24, offset=0)
        batches = batches_payload.get("batches", []) if isinstance(batches_payload, dict) else []
        active_jobs = BackgroundJobRepository(session).list_active(limit=300)
        latest_batch = batches[0] if batches else {}
        batch_fingerprint = [
            {
                "batch_id": str(item.get("batch_id", "") or ""),
                "status": str(item.get("status", "") or ""),
                "requested_count": int(item.get("requested_count", 0) or 0),
                "completed_count": int(item.get("completed_count", 0) or 0),
                "success_rate": float(item.get("success_rate", 0) or 0),
                "created_at": item.get("created_at"),
                "updated_at": item.get("updated_at"),
                "finished_at": item.get("finished_at"),
            }
            for item in batches
        ]
        return {
            "stats": {
                "total": int(stats.get("total", 0) or 0),
                "unlabeled": int(stats.get("unlabeled", 0) or 0),
                "successful_runs": int(stats.get("successful_runs", 0) or 0),
                "total_runs": int(stats.get("total_runs", 0) or 0),
                "success_rate": float(stats.get("success_rate", 0) or 0),
            },
            "batches_total": int(batches_payload.get("total", len(batches)) or 0)
            if isinstance(batches_payload, dict)
            else len(batches),
            "latest_batch": {
                "batch_id": str(latest_batch.get("batch_id", "") or ""),
                "status": str(latest_batch.get("status", "") or ""),
                "created_at": latest_batch.get("created_at"),
                "updated_at": latest_batch.get("updated_at"),
            },
            "batch_fingerprint": batch_fingerprint,
            "active_jobs": len(active_jobs),
            "active_run_ids": sorted(
                str(item.run_id or "") for item in active_jobs if str(item.run_id or "").strip()
            )[:120],
        }
    finally:
        session.close()


async def _stream_dataset_changes(request: Request):
    last_signature = ""
    first_tick = True
    keepalive_last = _time.monotonic()
    try:
        while True:
            if await request.is_disconnected():
                return
            snapshot = _dataset_stream_snapshot()
            signature = json.dumps(snapshot, sort_keys=True, default=str)
            if first_tick or signature != last_signature:
                payload = {
                    "type": "dataset_snapshot",
                    "changed": not first_tick and signature != last_signature,
                    "snapshot": snapshot,
                    "timestamp": _time.time(),
                }
                yield f"data: {json.dumps(payload, default=str)}\n\n"
                last_signature = signature
                first_tick = False
            await asyncio.sleep(1.2)
            if _time.monotonic() - keepalive_last > _SSE_KEEPALIVE_SECONDS:
                yield ": heartbeat\n\n"
                keepalive_last = _time.monotonic()
    except (asyncio.CancelledError, GeneratorExit):
        return
    except Exception as exc:
        payload = {
            "type": "dataset_stream_error",
            "error": str(exc),
            "completed": True,
        }
        yield f"data: {json.dumps(payload, default=str)}\n\n"


@router.get("/stream")
async def stream_dataset_changes(request: Request):
    return StreamingResponse(
        _stream_dataset_changes(request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/meta")
def get_meta():
    def _handler(_: Any, repo: DatasetRepository):
        _seed_default_sites_if_empty(repo)
        return {
            "languages": LANGUAGES,
            "labels": LABELS,
            "stats": repo.site_stats(),
        }

    return _with_repo(_handler)


@router.get("/sites")
def list_sites(
    language: str = Query("", description="Filter by language"),
    label: str = Query("", description="Filter by label"),
    query: str = Query("", description="Search sites"),
    limit: int = Query(0, description="Max results (0=all)"),
    offset: int = Query(0),
):
    def _handler(_session: Any, repo: DatasetRepository):
        _seed_default_sites_if_empty(repo)
        return repo.list_sites(
            language=language,
            label=label,
            query=query,
            limit=limit,
            offset=offset,
        )

    return _with_repo(_handler)


@router.post("/sites")
def create_site(site: SiteCreate):
    def _handler(_: Any, repo: DatasetRepository):
        try:
            return repo.create_site(
                url=site.url,
                language=site.language,
                label=site.label,
                notes=site.notes,
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return _with_repo(_handler)


@router.get("/sites/stats")
def get_stats():
    return _with_repo(
        lambda _session, repo: (_seed_default_sites_if_empty(repo) or repo.site_stats())
    )


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


@router.post("/sites/bulk-delete")
def bulk_delete(payload: BulkDelete):
    return _with_repo(
        lambda _session, repo: {
            "deleted": repo.bulk_delete_sites(payload.ids),
        }
    )


@router.post("/sites/health-check")
async def check_site_health(payload: SiteHealthCheckRequest):
    def _handler(_: Any, repo: DatasetRepository):
        _seed_default_sites_if_empty(repo)
        rows: list[dict[str, Any]] = []
        if payload.site_ids:
            rows.extend(repo.list_sites_by_ids(payload.site_ids))
        seen_urls = {str(row.get("url", "") or "").strip() for row in rows}
        for url in payload.urls:
            normalized = str(url or "").strip()
            if normalized and normalized not in seen_urls:
                rows.append({"id": None, "url": normalized})
                seen_urls.add(normalized)
        limit = min(max(int(payload.limit or 1), 1), _SITE_HEALTH_MAX_CHECKS)
        return rows[:limit]

    site_rows = _with_repo(_handler)
    candidates = [
        {"site_id": row.get("id"), "url": row.get("url")}
        for row in site_rows
        if str(row.get("url", "") or "").strip()
    ]
    timeout_seconds = max(1.0, min(float(payload.timeout_seconds or 5.0), 15.0))
    timeout = httpx.Timeout(timeout_seconds, connect=min(3.0, timeout_seconds))
    limits = httpx.Limits(max_connections=_SITE_HEALTH_CONCURRENCY, max_keepalive_connections=4)
    semaphore = asyncio.Semaphore(_SITE_HEALTH_CONCURRENCY)

    async def _bounded(candidate: dict[str, Any]) -> dict[str, Any]:
        async with semaphore:
            return await _probe_site_health(client, candidate)

    async with httpx.AsyncClient(
        follow_redirects=True,
        verify=False,
        timeout=timeout,
        limits=limits,
        headers={
            "User-Agent": _SITE_HEALTH_USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
    ) as client:
        results = await asyncio.gather(*[_bounded(candidate) for candidate in candidates])

    checked_at = datetime.now(timezone.utc).isoformat()
    return {
        "checked_at": checked_at,
        "checked": len(results),
        "limit": _SITE_HEALTH_MAX_CHECKS,
        "results": [{**result, "checked_at": checked_at} for result in results],
    }


@router.get("/sites/{site_id}")
def get_site(site_id: int, limit: int = Query(20, ge=1, le=100)):
    def _handler(_: Any, repo: DatasetRepository):
        try:
            return repo.get_site_detail(site_id, limit=limit)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return _with_repo(_handler)


@router.delete("/sites/{site_id}")
def delete_site(site_id: int):
    def _handler(_: Any, repo: DatasetRepository):
        if not repo.delete_site(site_id):
            raise HTTPException(status_code=404, detail="Site not found")
        return {"ok": True, "deleted": site_id}

    return _with_repo(_handler)


@router.put("/sites/{site_id}")
def replace_site(site_id: int, update: SiteUpdate):
    return update_site(site_id, update)


@router.patch("/sites/{site_id}")
def update_site(site_id: int, update: SiteUpdate):
    def _handler(_: Any, repo: DatasetRepository):
        try:
            return repo.update_site(
                site_id,
                url=update.url,
                language=update.language,
                label=update.label,
                notes=update.notes,
            )
        except ValueError as exc:
            status = 404 if "not found" in str(exc).lower() else 400
            raise HTTPException(status_code=status, detail=str(exc)) from exc

    return _with_repo(_handler)


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
def get_batch(batch_id: str, include_runs: bool = Query(False)):
    def _handler(_: Any, repo: DatasetRepository):
        try:
            return repo.get_batch(batch_id, include_runs=include_runs)
        except ValueError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    return _with_repo(_handler)


@router.post("/batches")
def create_batch(req: DatasetBatchRequest):
    def _handler(session, repo: DatasetRepository):
        _seed_default_sites_if_empty(repo)
        urls = [str(item or "").strip() for item in req.urls if str(item or "").strip()]
        if not urls:
            payload = repo.list_sites(
                language=req.language,
                label=req.label,
                query=req.query,
                limit=max(0, int(req.limit or 0)),
                offset=0,
            )
            urls = [str(site.get("url", "") or "").strip() for site in payload.get("sites", []) if str(site.get("url", "") or "").strip()]
        if not urls:
            raise HTTPException(status_code=400, detail="No dataset URLs matched this batch request.")

        try:
            created = repo.create_batch(
                urls=urls,
                batch_name=req.batch_name,
                language_filter=req.language,
                label_filter=req.label,
                source="manual_urls" if req.urls else "dataset",
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
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
        return repo.get_batch(str(created.get("batch_id", "") or ""), include_runs=False)

    return _with_repo(_handler)
