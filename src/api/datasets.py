"""Dataset management - single CSV with language/label columns."""

from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter(prefix="/api/datasets", tags=["datasets"])

SITES_CSV = Path("datasets/sites.csv")
RESULTS_DIR = Path("data/dataset_results")
LANGUAGES = ["arabic", "english", "spanish", "french", "portuguese", "other"]
LABELS = ["piracy", "sports", "news", "entertainment", "unknown"]

CSV_FIELDS = ["id", "url", "language", "label", "notes"]


def _read_sites() -> list[dict]:
    if not SITES_CSV.exists():
        return []
    with open(SITES_CSV, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _write_sites(rows: list[dict]) -> None:
    SITES_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(SITES_CSV, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


class SiteUpdate(BaseModel):
    language: str = ""
    label: str = ""
    notes: str = ""


class BulkUpdate(BaseModel):
    ids: list[int]
    language: str = ""
    label: str = ""


@router.get("/meta")
def get_meta():
    """Return available languages and labels."""
    return {"languages": LANGUAGES, "labels": LABELS}


@router.get("/sites")
def list_sites(
    language: str = Query("", description="Filter by language"),
    label: str = Query("", description="Filter by label"),
    limit: int = Query(0, description="Max results (0=all)"),
    offset: int = Query(0),
):
    rows = _read_sites()
    if language:
        rows = [r for r in rows if r.get("language") == language]
    if label:
        rows = [r for r in rows if r.get("label") == label]
    total = len(rows)
    if offset:
        rows = rows[offset:]
    if limit:
        rows = rows[:limit]
    return {"total": total, "sites": rows}


@router.get("/sites/stats")
def get_stats():
    rows = _read_sites()
    lang_counts: dict[str, int] = {}
    label_counts: dict[str, int] = {}
    unlabeled = 0
    for r in rows:
        lang = r.get("language") or "unlabeled"
        label = r.get("label") or "unlabeled"
        lang_counts[lang] = lang_counts.get(lang, 0) + 1
        label_counts[label] = label_counts.get(label, 0) + 1
        if not r.get("language"):
            unlabeled += 1
    return {
        "total": len(rows),
        "unlabeled": unlabeled,
        "by_language": lang_counts,
        "by_label": label_counts,
    }


@router.patch("/sites/{site_id}")
def update_site(site_id: int, update: SiteUpdate):
    rows = _read_sites()
    found = False
    for row in rows:
        if int(row.get("id", -1)) == site_id:
            if update.language is not None:
                row["language"] = update.language
            if update.label is not None:
                row["label"] = update.label
            if update.notes is not None:
                row["notes"] = update.notes
            found = True
            break
    if not found:
        raise HTTPException(status_code=404, detail="Site not found")
    _write_sites(rows)
    return {"status": "updated"}


@router.post("/sites/bulk-update")
def bulk_update(update: BulkUpdate):
    rows = _read_sites()
    id_set = set(update.ids)
    count = 0
    for row in rows:
        if int(row.get("id", -1)) in id_set:
            if update.language:
                row["language"] = update.language
            if update.label:
                row["label"] = update.label
            count += 1
    _write_sites(rows)
    return {"updated": count}


@router.get("/results")
def get_results(language: str = Query(""), label: str = Query("")):
    """Aggregate test results, optionally filtered."""
    results_file = RESULTS_DIR / "results.jsonl"
    if not results_file.exists():
        return {"total": 0, "successful": 0, "failed": 0, "success_rate": 0.0, "by_language": {}, "by_label": {}}

    total = 0
    successful = 0
    by_language: dict[str, dict] = {}
    by_label: dict[str, dict] = {}

    with open(results_file, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            r = json.loads(line)
            rlang = r.get("language", "")
            rlabel = r.get("label", "")
            if language and rlang != language:
                continue
            if label and rlabel != label:
                continue
            total += 1
            ok = r.get("success", False)
            if ok:
                successful += 1
            # by language
            if rlang not in by_language:
                by_language[rlang] = {"total": 0, "successful": 0}
            by_language[rlang]["total"] += 1
            if ok:
                by_language[rlang]["successful"] += 1
            # by label
            if rlabel not in by_label:
                by_label[rlabel] = {"total": 0, "successful": 0}
            by_label[rlabel]["total"] += 1
            if ok:
                by_label[rlabel]["successful"] += 1

    # compute rates
    for d in list(by_language.values()) + list(by_label.values()):
        d["success_rate"] = round(d["successful"] / d["total"] * 100, 1) if d["total"] else 0.0

    return {
        "total": total,
        "successful": successful,
        "failed": total - successful,
        "success_rate": round(successful / total * 100, 1) if total else 0.0,
        "by_language": by_language,
        "by_label": by_label,
    }


@router.post("/results/record")
def record_result(
    url: str = Query(...),
    success: bool = Query(...),
    language: str = Query(""),
    label: str = Query(""),
):
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    results_file = RESULTS_DIR / "results.jsonl"
    entry = {
        "url": url,
        "success": success,
        "language": language,
        "label": label,
        "timestamp": datetime.utcnow().isoformat(),
    }
    with open(results_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry) + "\n")
    return {"status": "recorded"}
