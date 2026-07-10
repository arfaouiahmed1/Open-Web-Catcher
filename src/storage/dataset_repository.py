"""Dataset persistence helpers backed by the operator-console database."""

from __future__ import annotations

import csv
import re
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlunparse

from sqlalchemy.orm import Session

from src.storage.models import (
    AgentRunRecord,
    BackgroundJobRecord,
    DatasetBatchRecord,
    DatasetSiteRecord,
    DatasetSiteRunRecord,
    PipelineRunRecord,
    RunModelUsageRecord,
)
from src.utils.console_state import (
    RUN_AGENT_FAILURE_STATUSES,
    RUN_CANCELLED_STATUSES,
    RUN_EXTERNAL_BLOCKER_STATUSES,
    RUN_FAILURE_STATUSES,
    RUN_PRODUCTIVE_SUCCESS_STATUSES,
    RUN_SUCCESS_STATUSES,
    RUN_TERMINAL_STATUSES,
    normalize_job_display_status,
    normalize_run_display_status,
)

LANGUAGES = [
    "english",
    "arabic",
    "spanish",
    "french",
    "portuguese",
    "turkish",
    "russian",
    "persian",
    "hindi",
    "other",
]
LABELS = ["piracy", "sports", "news", "entertainment", "unknown"]
SUCCESS_FINAL_STATUSES = set(RUN_SUCCESS_STATUSES)
FAILED_FINAL_STATUSES = set(RUN_FAILURE_STATUSES)
CANCELLED_FINAL_STATUSES = set(RUN_CANCELLED_STATUSES)
PRODUCTIVE_SUCCESS_STATUSES = set(RUN_PRODUCTIVE_SUCCESS_STATUSES)
EXTERNAL_BLOCKER_STATUSES = set(RUN_EXTERNAL_BLOCKER_STATUSES)
AGENT_FAILURE_STATUSES = set(RUN_AGENT_FAILURE_STATUSES)
TERMINAL_SITE_RUN_STATUSES = set(RUN_TERMINAL_STATUSES)
ACTIVE_SITE_RUN_STATUSES = {"queued", "running", "retrying", "leased"}
RUNNING_SITE_RUN_STATUSES = {"running", "retrying", "leased"}
_PAGE_INACCESSIBLE_RE = re.compile(
    r"(inaccessible|unreachable|could not be accessed|failed to load|navigation error|"
    r"browser-level|chrome-error|about:blank|err_|dns|ssl handshake|connection refused|"
    r"connection reset|site unavailable|timed out)",
    re.IGNORECASE,
)
_NO_HOSTING_RE = re.compile(
    r"(no hosting|no downstream|directory|portal|listing|hub|article-only|"
    r"no functional components|standard .*wordpress)",
    re.IGNORECASE,
)


def canonicalize_url(url: str) -> str:
    raw = str(url or "").strip()
    if not raw:
        return ""
    parsed = urlparse(raw)
    if not parsed.scheme or not parsed.netloc:
        return ""
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = parsed.path or "/"
    if path != "/" and path.endswith("/"):
        path = path[:-1]
    normalized = parsed._replace(scheme=scheme, netloc=netloc, path=path, params="", fragment="")
    return urlunparse((normalized.scheme, normalized.netloc, normalized.path, "", normalized.query, ""))


def _serialize_model(row: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for column in row.__table__.columns:
        value = getattr(row, column.name)
        payload[column.name] = value.isoformat() if isinstance(value, datetime) else value
    return payload


def _serialize_datetime(value: Any) -> str:
    return value.isoformat() if isinstance(value, datetime) else ""


def _terminal_site_status(value: str) -> str:
    status = str(value or "").strip().lower()
    return status if status in TERMINAL_SITE_RUN_STATUSES else ""


def _status_metrics_from_statuses(statuses: list[str]) -> dict[str, Any]:
    terminal_statuses = [_terminal_site_status(status) for status in statuses]
    terminal_statuses = [status for status in terminal_statuses if status]
    productive_success_count = len(
        [status for status in terminal_statuses if status in PRODUCTIVE_SUCCESS_STATUSES]
    )
    external_blocked_count = len(
        [status for status in terminal_statuses if status in EXTERNAL_BLOCKER_STATUSES]
    )
    agent_failed_count = len(
        [status for status in terminal_statuses if status in AGENT_FAILURE_STATUSES]
    )
    strict_failed_count = len(
        [status for status in terminal_statuses if status in FAILED_FINAL_STATUSES]
    )
    cancelled_count = len(
        [status for status in terminal_statuses if status in CANCELLED_FINAL_STATUSES]
    )
    terminal_non_cancelled_count = len(terminal_statuses) - cancelled_count
    adjusted_successful_count = productive_success_count + external_blocked_count
    return {
        "terminal_count": len(terminal_statuses),
        "terminal_non_cancelled_count": terminal_non_cancelled_count,
        "productive_success_count": productive_success_count,
        "adjusted_successful_count": adjusted_successful_count,
        "external_blocked_count": external_blocked_count,
        "agent_failed_count": agent_failed_count,
        "strict_failed_count": strict_failed_count,
        "cancelled_count": cancelled_count,
        "adjusted_success_rate": round(
            (adjusted_successful_count / terminal_non_cancelled_count) * 100.0,
            1,
        )
        if terminal_non_cancelled_count
        else 0.0,
    }


def _derive_failed_site_status(
    *,
    status: str,
    page_type: str = "",
    stream_count: int = 0,
    provider_analysis_count: int = 0,
    error_text: str = "",
) -> str:
    normalized = str(status or "").strip().lower()
    if normalized != "failed":
        return normalized
    text = " ".join([str(error_text or ""), str(page_type or "")])
    if _PAGE_INACCESSIBLE_RE.search(text):
        return "page_inaccessible"
    if str(page_type or "").strip().lower() == "landing_page" and int(stream_count or 0) == 0:
        if _NO_HOSTING_RE.search(text) or int(provider_analysis_count or 0) == 0:
            return "no_hosting_pages"
    if int(stream_count or 0) == 0 and int(provider_analysis_count or 0) == 0:
        return "no_streams"
    return normalized


class DatasetRepository:
    def __init__(self, session: Session) -> None:
        self._session = session

    def ensure_seeded_from_csv(self, csv_path: Path) -> dict[str, Any]:
        total = int(self._session.query(DatasetSiteRecord).count() or 0)
        if total > 0:
            return {"seeded": False, "inserted": 0, "updated": 0, "total": total}
        imported = self.import_csv(csv_path, source="csv_seed")
        imported["seeded"] = bool(imported.get("inserted") or imported.get("updated"))
        return imported

    def import_csv(self, csv_path: Path, *, source: str = "csv_import") -> dict[str, Any]:
        if not csv_path.exists():
            return {
                "inserted": 0,
                "updated": 0,
                "total": int(self._session.query(DatasetSiteRecord).count() or 0),
                "missing": True,
                "csv_path": str(csv_path),
            }

        inserted = 0
        updated = 0
        seen_sites: dict[str, DatasetSiteRecord] = {}
        with csv_path.open("r", encoding="utf-8", newline="") as handle:
            for row in csv.DictReader(handle):
                url = str(row.get("url", "") or "").strip()
                canonical = canonicalize_url(url)
                if not canonical:
                    continue
                site = seen_sites.get(canonical)
                if site is None:
                    site = self._session.query(DatasetSiteRecord).filter_by(canonical_url=canonical).first()
                if site is None:
                    site = DatasetSiteRecord(canonical_url=canonical)
                    self._session.add(site)
                    inserted += 1
                else:
                    updated += 1
                seen_sites[canonical] = site
                site.url = url
                site.source = str(row.get("source", "") or source or site.source or "csv_import")
                site.language = str(row.get("language", "") or site.language or "")
                site.label = str(row.get("label", "") or site.label or "")
                notes = str(row.get("notes", "") or "").strip()
                if notes:
                    site.notes = notes

        self._session.commit()
        return {
            "inserted": inserted,
            "updated": updated,
            "total": int(self._session.query(DatasetSiteRecord).count() or 0),
            "missing": False,
            "csv_path": str(csv_path),
        }

    def list_sites(
        self,
        *,
        language: str = "",
        label: str = "",
        query: str = "",
        limit: int = 0,
        offset: int = 0,
    ) -> dict[str, Any]:
        site_query = self._session.query(DatasetSiteRecord)
        if language:
            site_query = site_query.filter(DatasetSiteRecord.language == language)
        if label:
            site_query = site_query.filter(DatasetSiteRecord.label == label)
        rows = site_query.order_by(
            DatasetSiteRecord.last_tested_at.desc().nullslast(),
            DatasetSiteRecord.updated_at.desc(),
            DatasetSiteRecord.id.asc(),
        ).all()

        search = str(query or "").strip().lower()
        if search:
            rows = [
                row
                for row in rows
                if search in str(row.url or "").lower()
                or search in str(row.canonical_url or "").lower()
                or search in str(row.notes or "").lower()
                or search in str(row.language or "").lower()
                or search in str(row.label or "").lower()
            ]

        total = len(rows)
        if offset:
            rows = rows[offset:]
        if limit:
            rows = rows[:limit]
        return {"total": total, "sites": [self._site_payload(row) for row in rows]}

    def list_sites_by_ids(self, site_ids: list[int]) -> list[dict[str, Any]]:
        ids: list[int] = []
        seen: set[int] = set()
        for value in site_ids:
            try:
                site_id = int(value)
            except (TypeError, ValueError):
                continue
            if site_id <= 0 or site_id in seen:
                continue
            seen.add(site_id)
            ids.append(site_id)
        if not ids:
            return []
        rows = self._session.query(DatasetSiteRecord).filter(DatasetSiteRecord.id.in_(ids)).all()
        by_id = {int(row.id): row for row in rows}
        return [self._site_payload(by_id[site_id]) for site_id in ids if site_id in by_id]

    def create_site(
        self,
        *,
        url: str,
        language: str = "",
        label: str = "",
        notes: str = "",
        source: str = "manual",
    ) -> dict[str, Any]:
        canonical = canonicalize_url(url)
        if not canonical:
            raise ValueError("A valid website URL is required")
        row = self._session.query(DatasetSiteRecord).filter_by(canonical_url=canonical).first()
        if row is None:
            row = DatasetSiteRecord(canonical_url=canonical, source=source or "manual")
            self._session.add(row)
            self._session.flush()
        row.url = str(url or "").strip()
        row.language = str(language or "").strip()
        row.label = str(label or "").strip()
        row.notes = str(notes or "").strip()
        row.source = row.source or source or "manual"
        self._session.commit()
        self._session.refresh(row)
        return self._site_payload(row)

    def get_site_detail(self, site_id: int, *, limit: int = 20) -> dict[str, Any]:
        row = self._session.query(DatasetSiteRecord).filter_by(id=site_id).first()
        if row is None:
            raise ValueError("Site not found")
        runs = (
            self._session.query(DatasetSiteRunRecord)
            .filter_by(site_id=site_id)
            .order_by(
                DatasetSiteRunRecord.created_at.desc(),
                DatasetSiteRunRecord.id.desc(),
            )
            .limit(max(int(limit or 20), 1))
            .all()
        )
        run_payloads = [self._site_run_payload(item) for item in runs]
        terminal = [
            item
            for item in run_payloads
            if str(item.get("final_status") or item.get("status") or "").strip().lower()
            in TERMINAL_SITE_RUN_STATUSES
        ]
        total_cost = sum(float(item.get("total_cost_usd") or 0.0) for item in terminal)
        total_tokens = sum(int(item.get("total_tokens") or 0) for item in terminal)
        fastest = min(
            [item for item in terminal if float(item.get("duration_seconds") or 0.0) > 0.0],
            key=lambda item: float(item.get("duration_seconds") or 0.0),
            default=None,
        )
        best_streams = max(
            terminal,
            key=lambda item: int(item.get("stream_count") or 0),
            default=None,
        )
        return {
            "site": self._site_payload(row),
            "runs": run_payloads,
            "summary": {
                "terminal_runs": len(terminal),
                "total_cost_usd": round(total_cost, 6),
                "total_tokens": total_tokens,
                "avg_cost_usd": round(total_cost / len(terminal), 6) if terminal else 0.0,
                "fastest_run_id": fastest.get("run_id") if fastest else "",
                "best_stream_run_id": best_streams.get("run_id") if best_streams else "",
                "best_stream_count": int(best_streams.get("stream_count") or 0) if best_streams else 0,
            },
        }

    def get_run_context(self, run_id: str) -> dict[str, Any] | None:
        row = self._session.query(DatasetSiteRunRecord).filter_by(run_id=run_id).first()
        if row is None:
            return None
        batch = self._session.query(DatasetBatchRecord).filter_by(id=row.batch_id).first()
        site = (
            self._session.query(DatasetSiteRecord).filter_by(id=row.site_id).first()
            if row.site_id is not None
            else None
        )
        return {
            "site_run": self._site_run_payload(row),
            "batch": self._batch_payload(batch, include_runs=False) if batch is not None else None,
            "site": self._site_payload(site) if site is not None else None,
        }

    def site_stats(self) -> dict[str, Any]:
        rows = self._session.query(DatasetSiteRecord).all()
        by_language: dict[str, int] = {}
        by_label: dict[str, int] = {}
        unlabeled = 0
        recent_tested = 0
        total_successes = 0
        total_attempts = 0

        for row in rows:
            language = str(row.language or "")
            label = str(row.label or "")
            by_language[language or "unlabeled"] = by_language.get(language or "unlabeled", 0) + 1
            by_label[label or "unlabeled"] = by_label.get(label or "unlabeled", 0) + 1
            if not language or not label:
                unlabeled += 1
            if row.last_tested_at:
                recent_tested += 1
            total_successes += int(row.successful_runs or 0)
            total_attempts += int(row.total_runs or 0)

        status_rows = self._session.query(
            DatasetSiteRunRecord.final_status,
            DatasetSiteRunRecord.status,
        ).all()
        status_metrics = _status_metrics_from_statuses(
            [str(final_status or status or "") for final_status, status in status_rows]
        )
        success_rate = round((total_successes / total_attempts) * 100.0, 1) if total_attempts else 0.0
        return {
            "total": len(rows),
            "unlabeled": unlabeled,
            "tested": recent_tested,
            "by_language": by_language,
            "by_label": by_label,
            "successful_runs": total_successes,
            "total_runs": total_attempts,
            "success_rate": success_rate,
            "adjusted_success_rate": status_metrics["adjusted_success_rate"],
            "agent_failed_count": status_metrics["agent_failed_count"],
            "external_blocked_count": status_metrics["external_blocked_count"],
            "strict_failed_count": status_metrics["strict_failed_count"],
            "terminal_non_cancelled_count": status_metrics["terminal_non_cancelled_count"],
        }

    def update_site(
        self,
        site_id: int,
        *,
        url: str | None = None,
        language: str | None = None,
        label: str | None = None,
        notes: str | None = None,
    ) -> dict[str, Any]:
        row = self._session.query(DatasetSiteRecord).filter_by(id=site_id).first()
        if row is None:
            raise ValueError("Site not found")
        if url is not None:
            canonical = canonicalize_url(url)
            if not canonical:
                raise ValueError("A valid website URL is required")
            existing = (
                self._session.query(DatasetSiteRecord)
                .filter(DatasetSiteRecord.canonical_url == canonical, DatasetSiteRecord.id != site_id)
                .first()
            )
            if existing is not None:
                raise ValueError("Another site already uses this URL")
            row.url = str(url or "").strip()
            row.canonical_url = canonical
        if language is not None:
            row.language = str(language or "")
        if label is not None:
            row.label = str(label or "")
        if notes is not None:
            row.notes = str(notes or "")
        self._session.commit()
        self._session.refresh(row)
        return self._site_payload(row)

    def delete_site(self, site_id: int) -> bool:
        row = self._session.query(DatasetSiteRecord).filter_by(id=site_id).first()
        if row is None:
            return False
        self._session.delete(row)
        self._session.commit()
        return True

    def bulk_delete_sites(self, site_ids: list[int]) -> int:
        ids: list[int] = []
        seen: set[int] = set()
        for value in site_ids:
            try:
                site_id = int(value)
            except (TypeError, ValueError):
                continue
            if site_id <= 0 or site_id in seen:
                continue
            ids.append(site_id)
            seen.add(site_id)
        if not ids:
            return 0
        rows = self._session.query(DatasetSiteRecord).filter(DatasetSiteRecord.id.in_(ids)).all()
        for row in rows:
            self._session.delete(row)
        self._session.commit()
        return len(rows)

    def bulk_update(
        self,
        site_ids: list[int],
        *,
        language: str | None = None,
        label: str | None = None,
        notes: str | None = None,
    ) -> int:
        ids = [int(value) for value in site_ids if value is not None]
        if not ids:
            return 0
        rows = self._session.query(DatasetSiteRecord).filter(DatasetSiteRecord.id.in_(ids)).all()
        for row in rows:
            if language is not None:
                row.language = str(language or "")
            if label is not None:
                row.label = str(label or "")
            if notes is not None:
                row.notes = str(notes or "")
        self._session.commit()
        return len(rows)

    def record_result(
        self,
        *,
        url: str,
        success: bool,
        language: str = "",
        label: str = "",
        run_id: str = "",
    ) -> dict[str, Any]:
        batch = DatasetBatchRecord(
            batch_id=str(uuid.uuid4()),
            batch_name="Recorded result",
            status="success" if success else "failed",
            source="manual_record",
            requested_count=1,
            completed_count=1,
            passed_count=1 if success else 0,
            failed_count=0 if success else 1,
            urls_json=[url],
            started_at=datetime.utcnow(),
            finished_at=datetime.utcnow(),
        )
        self._session.add(batch)
        self._session.flush()

        site = self._ensure_site(url=url, language=language, label=label, source="manual_record")
        record = DatasetSiteRunRecord(
            batch_id=batch.id,
            site_id=site.id if site else None,
            run_id=run_id or str(uuid.uuid4()),
            url=url,
            language=language,
            label=label,
            status="success" if success else "failed",
            final_status="success" if success else "failed",
            started_at=datetime.utcnow(),
            finished_at=datetime.utcnow(),
        )
        self._session.add(record)
        self._session.flush()
        if site is not None:
            self._refresh_site_metrics(site.id)
        self._session.commit()
        return self.get_batch(batch.batch_id)

    def results_summary(self, *, language: str = "", label: str = "") -> dict[str, Any]:
        rows = (
            self._session.query(DatasetSiteRunRecord, DatasetSiteRecord)
            .outerjoin(DatasetSiteRecord, DatasetSiteRecord.id == DatasetSiteRunRecord.site_id)
            .order_by(DatasetSiteRunRecord.created_at.desc())
            .all()
        )
        total = 0
        successful = 0
        partial = 0
        failed = 0
        statuses: list[str] = []
        by_language: dict[str, dict[str, Any]] = {}
        by_label: dict[str, dict[str, Any]] = {}

        for run_row, site_row in rows:
            final_status = str(run_row.final_status or run_row.status or "").strip().lower()
            if final_status not in TERMINAL_SITE_RUN_STATUSES:
                continue
            row_language = str(run_row.language or (site_row.language if site_row else "") or "")
            row_label = str(run_row.label or (site_row.label if site_row else "") or "")
            if language and row_language != language:
                continue
            if label and row_label != label:
                continue

            statuses.append(final_status)
            total += 1
            ok = final_status in SUCCESS_FINAL_STATUSES
            if final_status == "partial":
                partial += 1
            if ok:
                successful += 1
            else:
                failed += 1

            lang_bucket = by_language.setdefault(row_language, {"total": 0, "successful": 0, "partial": 0, "failed": 0, "_statuses": []})
            label_bucket = by_label.setdefault(row_label, {"total": 0, "successful": 0, "partial": 0, "failed": 0, "_statuses": []})
            for bucket in (lang_bucket, label_bucket):
                bucket["total"] += 1
                bucket["_statuses"].append(final_status)
                if ok:
                    bucket["successful"] += 1
                else:
                    bucket["failed"] += 1
                if final_status == "partial":
                    bucket["partial"] += 1

        for bucket in list(by_language.values()) + list(by_label.values()):
            bucket["success_rate"] = round((bucket["successful"] / bucket["total"]) * 100.0, 1) if bucket["total"] else 0.0
            bucket_metrics = _status_metrics_from_statuses(bucket.pop("_statuses", []))
            bucket.update(
                {
                    "adjusted_success_rate": bucket_metrics["adjusted_success_rate"],
                    "agent_failed_count": bucket_metrics["agent_failed_count"],
                    "external_blocked_count": bucket_metrics["external_blocked_count"],
                    "strict_failed_count": bucket_metrics["strict_failed_count"],
                    "terminal_non_cancelled_count": bucket_metrics["terminal_non_cancelled_count"],
                }
            )

        metrics = _status_metrics_from_statuses(statuses)
        return {
            "total": total,
            "successful": successful,
            "partial": partial,
            "failed": failed,
            "success_rate": round((successful / total) * 100.0, 1) if total else 0.0,
            "adjusted_success_rate": metrics["adjusted_success_rate"],
            "agent_failed_count": metrics["agent_failed_count"],
            "external_blocked_count": metrics["external_blocked_count"],
            "strict_failed_count": metrics["strict_failed_count"],
            "terminal_non_cancelled_count": metrics["terminal_non_cancelled_count"],
            "by_language": by_language,
            "by_label": by_label,
        }

    def create_batch(
        self,
        *,
        urls: list[str],
        batch_name: str = "",
        language_filter: str = "",
        label_filter: str = "",
        source: str = "dataset",
    ) -> dict[str, Any]:
        normalized_urls = []
        seen_canonical: set[str] = set()
        for url in urls:
            raw = str(url or "").strip()
            canonical = canonicalize_url(raw)
            if not raw or not canonical or canonical in seen_canonical:
                continue
            seen_canonical.add(canonical)
            normalized_urls.append(raw)
        if not normalized_urls:
            raise ValueError("No valid dataset URLs were provided")
        batch = DatasetBatchRecord(
            batch_id=str(uuid.uuid4()),
            batch_name=str(batch_name or "").strip(),
            status="queued",
            source=source,
            language_filter=language_filter,
            label_filter=label_filter,
            requested_count=len(normalized_urls),
            urls_json=normalized_urls,
        )
        self._session.add(batch)
        self._session.flush()

        run_specs: list[dict[str, Any]] = []
        for url in normalized_urls:
            site = self._find_site(url)
            if site is None:
                site = self._ensure_site(url=url, source="manual_batch")
            run_id = str(uuid.uuid4())
            row = DatasetSiteRunRecord(
                batch_id=batch.id,
                site_id=site.id if site else None,
                run_id=run_id,
                url=url,
                language=str(site.language if site else ""),
                label=str(site.label if site else ""),
                status="queued",
            )
            self._session.add(row)
            self._session.flush()
            run_specs.append(
                {
                    "run_id": run_id,
                    "url": url,
                    "site_id": site.id if site else None,
                    "batch_id": batch.batch_id,
                    "site_run_id": row.id,
                    "language": str(site.language if site else ""),
                    "label": str(site.label if site else ""),
                }
            )

        self._session.commit()
        return {
            "batch_id": batch.batch_id,
            "requested_count": batch.requested_count,
            "runs": run_specs,
        }

    def list_batches(self, *, limit: int = 20, offset: int = 0) -> dict[str, Any]:
        query = self._session.query(DatasetBatchRecord)
        total = int(query.count() or 0)
        rows = (
            query.order_by(DatasetBatchRecord.created_at.desc(), DatasetBatchRecord.id.desc())
            .offset(max(offset, 0))
            .limit(max(limit, 1))
            .all()
        )
        return {
            "total": total,
            "batches": [self._batch_payload(row, include_runs=False) for row in rows],
        }

    def get_batch(self, batch_id: str) -> dict[str, Any]:
        batch = self._session.query(DatasetBatchRecord).filter_by(batch_id=batch_id).first()
        if batch is None:
            raise ValueError("Batch not found")
        return self._batch_payload(batch, include_runs=True)

    def mark_site_run_running(self, run_id: str) -> None:
        row = self._session.query(DatasetSiteRunRecord).filter_by(run_id=run_id).first()
        if row is None:
            return
        now = datetime.utcnow()
        row.status = "running"
        row.started_at = row.started_at or now
        batch = self._session.query(DatasetBatchRecord).filter_by(id=row.batch_id).first()
        if batch is not None:
            batch.status = "running"
            batch.started_at = batch.started_at or now
        self._session.commit()

    def mark_site_run_cancelled(self, run_id: str, *, reason: str = "") -> None:
        row = self._session.query(DatasetSiteRunRecord).filter_by(run_id=run_id).first()
        if row is None:
            return
        now = datetime.utcnow()
        row.status = "cancelled"
        row.final_status = "cancelled"
        row.error_text = str(reason or "")
        row.started_at = row.started_at or now
        row.finished_at = now
        if row.site_id is not None:
            self._refresh_site_metrics(row.site_id)
        self._refresh_batch_metrics(row.batch_id)
        self._session.commit()

    def cancel_batch(self, batch_id: str, *, reason: str = "") -> dict[str, Any]:
        batch = self._session.query(DatasetBatchRecord).filter_by(batch_id=batch_id).first()
        if batch is None:
            raise ValueError("Batch not found")

        rows = (
            self._session.query(DatasetSiteRunRecord)
            .filter_by(batch_id=batch.id)
            .order_by(DatasetSiteRunRecord.id.asc())
            .all()
        )
        now = datetime.utcnow()
        cancelled_run_ids: list[str] = []
        skipped_run_ids: list[str] = []
        for row in rows:
            current = str(row.final_status or row.status or "").strip().lower()
            if current in TERMINAL_SITE_RUN_STATUSES:
                skipped_run_ids.append(row.run_id)
                continue
            row.status = "cancelled"
            row.final_status = "cancelled"
            row.error_text = str(reason or "")
            row.started_at = row.started_at or now
            row.finished_at = now
            cancelled_run_ids.append(row.run_id)

        affected_site_ids = {int(row.site_id) for row in rows if row.site_id is not None}
        for site_id in affected_site_ids:
            self._refresh_site_metrics(site_id)
        self._refresh_batch_metrics(batch.id)
        self._session.commit()
        return {
            "batch_id": batch.batch_id,
            "cancelled": len(cancelled_run_ids),
            "skipped": len(skipped_run_ids),
            "run_ids": cancelled_run_ids,
            "skipped_run_ids": skipped_run_ids,
            "batch": self.get_batch(batch.batch_id),
        }

    def finalize_site_run(
        self,
        run_id: str,
        *,
        display_status: str,
        result_json: dict[str, Any] | None = None,
        error_text: str = "",
    ) -> None:
        row = self._session.query(DatasetSiteRunRecord).filter_by(run_id=run_id).first()
        if row is None:
            return

        status = str(display_status or "").strip().lower() or "failed"
        result_payload = result_json or {}
        now = datetime.utcnow()
        row.status = status
        row.final_status = str(result_payload.get("final_status", "") or status)
        row.error_text = error_text
        row.started_at = row.started_at or now
        if status in TERMINAL_SITE_RUN_STATUSES:
            row.finished_at = now
        row.stream_count = int(result_payload.get("stream_count") or len(result_payload.get("all_streams", []) or []))
        row.total_cost_usd = float(
            result_payload.get("total_cost_usd")
            or result_payload.get("estimated_total_cost_usd")
            or ((result_payload.get("metrics") or {}).get("estimated_total_cost_usd", 0.0))
            or 0.0
        )

        if row.site_id is not None:
            self._refresh_site_metrics(row.site_id)
        self._refresh_batch_metrics(row.batch_id)
        self._session.commit()

    def _site_payload(self, row: DatasetSiteRecord) -> dict[str, Any]:
        payload = _serialize_model(row)
        status_rows = (
            self._session.query(DatasetSiteRunRecord.final_status, DatasetSiteRunRecord.status)
            .filter_by(site_id=row.id)
            .all()
        )
        status_metrics = _status_metrics_from_statuses(
            [str(final_status or status or "") for final_status, status in status_rows]
        )
        payload["success_rate"] = round((float(row.successful_runs or 0) / float(row.total_runs or 1)) * 100.0, 1) if row.total_runs else 0.0
        payload["adjusted_success_rate"] = status_metrics["adjusted_success_rate"]
        payload["agent_failed_count"] = status_metrics["agent_failed_count"]
        payload["external_blocked_count"] = status_metrics["external_blocked_count"]
        payload["strict_failed_count"] = status_metrics["strict_failed_count"]
        payload["terminal_non_cancelled_count"] = status_metrics["terminal_non_cancelled_count"]
        payload["latest_run"] = self._latest_site_run_payload(row.id)
        payload["active_run_count"] = int(
            self._session.query(DatasetSiteRunRecord)
            .filter_by(site_id=row.id)
            .filter(DatasetSiteRunRecord.status.in_(sorted(ACTIVE_SITE_RUN_STATUSES)))
            .count()
            or 0
        )
        return payload

    def _batch_payload(self, row: DatasetBatchRecord, *, include_runs: bool) -> dict[str, Any]:
        payload = _serialize_model(row)
        runs = (
            self._session.query(DatasetSiteRunRecord)
            .filter_by(batch_id=row.id)
            .order_by(DatasetSiteRunRecord.created_at.asc(), DatasetSiteRunRecord.id.asc())
            .all()
        )
        run_payloads = [self._site_run_payload(item) for item in runs]
        completed = [
            item
            for item in run_payloads
            if _terminal_site_status(item.get("final_status") or item.get("status"))
        ]
        status_metrics = _status_metrics_from_statuses(
            [str(item.get("final_status") or item.get("status") or "") for item in run_payloads]
        )
        passed_count = len(
            [
                item
                for item in completed
                if _terminal_site_status(item.get("final_status") or item.get("status"))
                in SUCCESS_FINAL_STATUSES
            ]
        )
        failed_count = len(
            [
                item
                for item in completed
                if _terminal_site_status(item.get("final_status") or item.get("status"))
                in FAILED_FINAL_STATUSES
            ]
        )
        cancelled_count = len(
            [
                item
                for item in completed
                if _terminal_site_status(item.get("final_status") or item.get("status")) == "cancelled"
            ]
        )
        if not run_payloads:
            batch_status = "queued"
        elif any(str(item.get("status", "") or "").strip().lower() in RUNNING_SITE_RUN_STATUSES for item in run_payloads):
            batch_status = "running"
        elif any(str(item.get("status", "") or "").strip().lower() == "queued" for item in run_payloads):
            batch_status = "queued"
        elif len(completed) == len(run_payloads):
            if cancelled_count == len(run_payloads):
                batch_status = "cancelled"
            elif passed_count == len(run_payloads):
                batch_status = "success"
            elif passed_count > 0:
                batch_status = "partial"
            else:
                batch_status = "failed"
        else:
            batch_status = "running"

        payload["requested_count"] = len(run_payloads)
        payload["completed_count"] = len(completed)
        payload["passed_count"] = passed_count
        payload["failed_count"] = failed_count
        payload["cancelled_count"] = cancelled_count
        payload["agent_failed_count"] = status_metrics["agent_failed_count"]
        payload["external_blocked_count"] = status_metrics["external_blocked_count"]
        payload["strict_failed_count"] = status_metrics["strict_failed_count"]
        payload["terminal_non_cancelled_count"] = status_metrics["terminal_non_cancelled_count"]
        payload["status"] = batch_status
        payload["success_rate"] = (
            round((float(passed_count) / float(len(completed) or 1)) * 100.0, 1) if completed else 0.0
        )
        payload["adjusted_success_rate"] = status_metrics["adjusted_success_rate"]
        if len(completed) == len(run_payloads) and completed:
            finished_values = [
                item.get("finished_at")
                for item in completed
                if str(item.get("finished_at", "") or "").strip()
            ]
            if finished_values:
                payload["finished_at"] = max(finished_values)
        for item in run_payloads:
            item["batch_status"] = batch_status
        if include_runs:
            payload["runs"] = run_payloads
        return payload

    def _latest_site_run_payload(self, site_id: int) -> dict[str, Any] | None:
        row = (
            self._session.query(DatasetSiteRunRecord)
            .filter_by(site_id=site_id)
            .order_by(
                DatasetSiteRunRecord.created_at.desc(),
                DatasetSiteRunRecord.id.desc(),
            )
            .first()
        )
        return self._site_run_payload(row) if row is not None else None

    def _site_run_payload(self, row: DatasetSiteRunRecord) -> dict[str, Any]:
        payload = _serialize_model(row)
        batch = self._session.query(DatasetBatchRecord).filter_by(id=row.batch_id).first()
        if batch is not None:
            payload["batch_id"] = batch.batch_id
            payload["batch_name"] = batch.batch_name
            payload["batch_status"] = batch.status
        pipeline = self._session.query(PipelineRunRecord).filter_by(run_id=row.run_id).first()
        job = self._session.query(BackgroundJobRecord).filter_by(run_id=row.run_id).first()
        model_usage: list[dict[str, Any]] = []
        agent_rows: list[dict[str, Any]] = []
        persisted_status = _terminal_site_status(payload.get("final_status") or payload.get("status"))
        job_display_status = normalize_job_display_status(str(job.status or "")) if job is not None else ""
        resolved_status = str(payload.get("status", "") or "").strip().lower() or "queued"
        resolved_final_status = persisted_status
        derived_error = str(payload.get("error_text", "") or "")
        if pipeline is not None:
            model_usage_rows = (
                self._session.query(RunModelUsageRecord)
                .filter_by(pipeline_run_id=pipeline.id)
                .order_by(
                    RunModelUsageRecord.estimated_total_cost_usd.desc(),
                    RunModelUsageRecord.model_name.asc(),
                )
                .all()
            )
            model_usage = [_serialize_model(item) for item in model_usage_rows]
            agent_rows = [
                _serialize_model(item)
                for item in (
                    self._session.query(AgentRunRecord)
                    .filter_by(pipeline_run_id=pipeline.id)
                    .order_by(AgentRunRecord.started_at.asc(), AgentRunRecord.id.asc())
                    .all()
                )
            ]
            pipeline_status = normalize_run_display_status(
                str(pipeline.final_status or ""),
                success=bool(pipeline.success),
                failure_mode=str(pipeline.failure_mode or ""),
                job_status="",
            )
            if _terminal_site_status(pipeline_status):
                resolved_status = pipeline_status
                resolved_final_status = pipeline_status
            elif job_display_status:
                resolved_status = job_display_status
                if _terminal_site_status(job_display_status):
                    resolved_final_status = job_display_status
            if not derived_error and resolved_status in FAILED_FINAL_STATUSES:
                derived_error = (
                    str(getattr(job, "error_text", "") or "")
                    or str(pipeline.classification_reasoning or "")
                    or str(pipeline.failure_mode or "")
                )
            resolved_status = _derive_failed_site_status(
                status=resolved_status,
                page_type=str(pipeline.page_type or ""),
                stream_count=int(pipeline.stream_count or 0),
                provider_analysis_count=int(pipeline.provider_analysis_count or 0),
                error_text=derived_error or str(pipeline.classification_reasoning or ""),
            )
            resolved_final_status = _derive_failed_site_status(
                status=resolved_final_status or resolved_status,
                page_type=str(pipeline.page_type or ""),
                stream_count=int(pipeline.stream_count or 0),
                provider_analysis_count=int(pipeline.provider_analysis_count or 0),
                error_text=derived_error or str(pipeline.classification_reasoning or ""),
            )
            payload["run"] = {
                "run_id": pipeline.run_id,
                "url": pipeline.root_url,
                "status": resolved_status,
                "final_status": resolved_final_status or pipeline_status,
                "success": pipeline.success,
                "page_type": pipeline.page_type,
                "stream_count": int(pipeline.stream_count or 0),
                "screenshot_count": int(pipeline.screenshot_count or 0),
                "provider_analysis_count": int(pipeline.provider_analysis_count or 0),
                "total_tokens_in": int(pipeline.total_tokens_in or 0),
                "total_cached_input_tokens": int(getattr(pipeline, "total_cached_input_tokens", 0) or 0),
                "total_new_input_tokens": int(getattr(pipeline, "total_new_input_tokens", 0) or 0),
                "total_tokens_out": int(pipeline.total_tokens_out or 0),
                "total_tokens": int(pipeline.total_tokens_in or 0) + int(pipeline.total_tokens_out or 0),
                "total_llm_calls": int(pipeline.total_llm_calls or 0),
                "total_tool_calls": int(pipeline.total_tool_calls or 0),
                "estimated_total_cost_usd": float(pipeline.estimated_total_cost_usd or 0.0),
                "duration_seconds": float(pipeline.duration_seconds or 0.0),
                "started_at": _serialize_datetime(pipeline.started_at),
                "finished_at": _serialize_datetime(pipeline.finished_at),
                "created_at": _serialize_datetime(pipeline.created_at),
            }
            payload["status"] = resolved_status
            payload["final_status"] = payload["run"]["final_status"] or payload.get("final_status", "")
            payload["stream_count"] = payload["run"]["stream_count"]
            payload["total_cost_usd"] = float(payload["run"]["estimated_total_cost_usd"] or payload.get("total_cost_usd") or 0.0)
            payload["total_tokens"] = payload["run"]["total_tokens"]
            payload["duration_seconds"] = payload["run"]["duration_seconds"]
        else:
            if job_display_status:
                resolved_status = job_display_status
                if _terminal_site_status(job_display_status):
                    resolved_final_status = job_display_status
            payload["status"] = resolved_status
            payload["final_status"] = resolved_final_status or payload.get("final_status") or payload.get("status") or ""
            payload["total_tokens"] = 0
            payload["duration_seconds"] = 0.0
        if not derived_error and resolved_status in FAILED_FINAL_STATUSES:
            derived_error = str(getattr(job, "error_text", "") or "")
        if not (pipeline is None and resolved_status == "failed" and not derived_error):
            resolved_status = _derive_failed_site_status(
                status=resolved_status,
                page_type=str(payload.get("page_type", "") or ""),
                stream_count=int(payload.get("stream_count") or 0),
                provider_analysis_count=0,
                error_text=derived_error,
            )
        if not (pipeline is None and (resolved_final_status or resolved_status) == "failed" and not derived_error):
            resolved_final_status = _derive_failed_site_status(
                status=resolved_final_status or resolved_status,
                page_type=str(payload.get("page_type", "") or ""),
                stream_count=int(payload.get("stream_count") or 0),
                provider_analysis_count=0,
                error_text=derived_error,
            )
        payload["status"] = resolved_status
        payload["final_status"] = resolved_final_status or payload.get("final_status") or payload.get("status") or ""
        payload["error_text"] = derived_error
        payload["model_usage"] = model_usage
        payload["agent_runs"] = agent_rows
        return payload

    def _find_site(self, url: str) -> DatasetSiteRecord | None:
        canonical = canonicalize_url(url)
        if not canonical:
            return None
        return self._session.query(DatasetSiteRecord).filter_by(canonical_url=canonical).first()

    def _ensure_site(
        self,
        *,
        url: str,
        language: str = "",
        label: str = "",
        source: str = "dataset",
    ) -> DatasetSiteRecord | None:
        canonical = canonicalize_url(url)
        if not canonical:
            return None
        row = self._session.query(DatasetSiteRecord).filter_by(canonical_url=canonical).first()
        if row is None:
            row = DatasetSiteRecord(canonical_url=canonical)
            self._session.add(row)
            self._session.flush()
        row.url = url
        row.source = row.source or source
        if language:
            row.language = language
        if label:
            row.label = label
        return row

    def _refresh_site_metrics(self, site_id: int) -> None:
        site = self._session.query(DatasetSiteRecord).filter_by(id=site_id).first()
        if site is None:
            return
        rows = (
            self._session.query(DatasetSiteRunRecord)
            .filter_by(site_id=site_id)
            .order_by(DatasetSiteRunRecord.finished_at.desc().nullslast(), DatasetSiteRunRecord.created_at.desc())
            .all()
        )
        terminal_rows = [row for row in rows if str(row.final_status or row.status or "").strip().lower() in TERMINAL_SITE_RUN_STATUSES]
        site.total_runs = len(terminal_rows)
        site.successful_runs = len([row for row in terminal_rows if str(row.final_status or row.status or "").strip().lower() in SUCCESS_FINAL_STATUSES])
        site.failed_runs = len([row for row in terminal_rows if str(row.final_status or row.status or "").strip().lower() in FAILED_FINAL_STATUSES])
        site.last_tested_at = next((row.finished_at or row.created_at for row in terminal_rows if row.finished_at or row.created_at), None)
        site.last_success_at = next(
            (
                row.finished_at or row.created_at
                for row in terminal_rows
                if str(row.final_status or row.status or "").strip().lower() in SUCCESS_FINAL_STATUSES
            ),
            None,
        )

    def _refresh_batch_metrics(self, batch_pk: int) -> None:
        batch = self._session.query(DatasetBatchRecord).filter_by(id=batch_pk).first()
        if batch is None:
            return
        rows = self._session.query(DatasetSiteRunRecord).filter_by(batch_id=batch_pk).all()
        completed = [row for row in rows if str(row.final_status or row.status or "").strip().lower() in TERMINAL_SITE_RUN_STATUSES]
        batch.requested_count = len(rows)
        batch.completed_count = len(completed)
        batch.passed_count = len([row for row in completed if str(row.final_status or row.status or "").strip().lower() in SUCCESS_FINAL_STATUSES])
        batch.failed_count = len(
            [
                row
                for row in completed
                if str(row.final_status or row.status or "").strip().lower()
                in FAILED_FINAL_STATUSES
            ]
        )
        batch.cancelled_count = len([row for row in completed if str(row.final_status or row.status or "").strip().lower() == "cancelled"])

        if not rows:
            batch.status = "queued"
        elif any(str(row.status or "").strip().lower() in RUNNING_SITE_RUN_STATUSES for row in rows):
            batch.status = "running"
        elif any(str(row.status or "").strip().lower() == "queued" for row in rows):
            batch.status = "queued"
        elif batch.completed_count == batch.requested_count:
            if batch.cancelled_count == batch.requested_count:
                batch.status = "cancelled"
            elif batch.passed_count == batch.requested_count:
                batch.status = "success"
            elif batch.passed_count > 0:
                batch.status = "partial"
            else:
                batch.status = "failed"
        else:
            batch.status = "running"

        if rows and batch.started_at is None:
            batch.started_at = min((row.started_at or row.created_at) for row in rows if row.started_at or row.created_at)
        if batch.completed_count == batch.requested_count and rows:
            finished_values = [row.finished_at or row.created_at for row in completed if row.finished_at or row.created_at]
            batch.finished_at = max(finished_values) if finished_values else datetime.utcnow()
