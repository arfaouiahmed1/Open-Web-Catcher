"""Shared operator-console helpers for status and display state."""

from __future__ import annotations

from typing import Any

JOB_ACTIVE_STATUSES = {"queued", "running", "retrying"}
JOB_TERMINAL_STATUSES = {"succeeded", "failed", "dead_letter", "cancelled"}
RUN_SUCCESS_STATUSES = {"success", "partial"}
RUN_FAILURE_STATUSES = {
    "failed",
    "timeout",
    "site_dead",
    "redirect",
    "page_inaccessible",
    "no_hosting_pages",
    "no_streams",
}
RUN_CANCELLED_STATUSES = {"cancelled"}
RUN_TERMINAL_STATUSES = RUN_SUCCESS_STATUSES | RUN_FAILURE_STATUSES | RUN_CANCELLED_STATUSES
RUN_ACTIVE_STATUSES = {"queued", "running", "retrying", "leased"}


def normalize_job_display_status(status: str) -> str:
    normalized = str(status or "").strip().lower()
    if normalized == "succeeded":
        return "success"
    if normalized == "queued":
        return "queued"
    if normalized in {"running", "retrying"}:
        return "running"
    if normalized == "cancelled":
        return "cancelled"
    if normalized in {"failed", "dead_letter"}:
        return "failed"
    return normalized or "unknown"


def normalize_run_display_status(
    final_status: str = "",
    *,
    success: bool | None = None,
    failure_mode: str = "",
    job_status: str = "",
) -> str:
    if job_status:
        job_display = normalize_job_display_status(job_status)
        if job_display in {"queued", "running", "cancelled", "failed"}:
            return job_display

    normalized = str(final_status or "").strip().lower()
    if normalized in RUN_ACTIVE_STATUSES | RUN_TERMINAL_STATUSES:
        if normalized in {"retrying", "leased"}:
            return "running"
        return normalized

    failure = str(failure_mode or "").strip().lower()
    if failure in {"cancelled", "canceled", "runcancellederror"}:
        return "cancelled"
    if failure in RUN_FAILURE_STATUSES:
        return failure
    if normalized in {"retrying"}:
        return "running"
    if success is True:
        return "success"
    if success is False and normalized in {"", "unknown"}:
        return "failed"
    return normalized or "unknown"


def country_code_from_value(value: str) -> str:
    code = str(value or "").strip().upper()
    if len(code) == 2 and code.isalpha():
        return code
    return ""


def flag_emoji_from_country_code(code: str) -> str:
    normalized = country_code_from_value(code)
    if not normalized:
        return ""
    return "".join(chr(127397 + ord(char)) for char in normalized)


def isoformat_or_empty(value: Any) -> str:
    if hasattr(value, "isoformat"):
        try:
            return value.isoformat()
        except Exception:  # noqa: BLE001
            return ""
    return ""
