"""Notebook helpers for agent-by-agent and orchestrator evaluation labs."""

from __future__ import annotations

import csv
import json
import uuid
from collections import Counter
from pathlib import Path
from typing import Any

from src.evaluation.scoring import evaluate_case_artifact
from src.models.schemas import ClassificationResult, EvaluationCase, ExtractionResult, PipelineResult
from src.storage.database import get_session
from src.storage.repositories import RunRepository
from src.utils.config import Settings
from src.utils.observability import get_observability_status, run_registry

try:
    import pandas as pd
except ImportError:  # pragma: no cover - optional dependency for notebooks only
    pd = None


CSV_COLUMNS = [
    "case_id",
    "enabled",
    "url",
    "tags",
    "notes",
    "expected_page_type",
    "confidence_at_least",
    "expected_final_status",
    "min_streams",
    "max_streams",
    "min_hosting_pages",
    "min_embedded_urls",
    "requires_provider_analysis",
    "requires_email_targets",
    "required_tools",
    "forbidden_tools",
    "max_tool_errors",
    "expected_provider_keywords",
    "expected_stream_host_keywords",
    "expected_hosting_url_keywords",
    "expected_embedded_url_keywords",
    "expected_failure_mode",
]

TARGET_TO_CASE_FILE = {
    "classification": Path("data/evals/classification_cases.csv"),
    "landing": Path("data/evals/landing_cases.csv"),
    "hosting": Path("data/evals/hosting_cases.csv"),
    "embedded": Path("data/evals/embedded_cases.csv"),
    "orchestrator": Path("data/evals/orchestrator_cases.csv"),
}


def load_case_rows(csv_path: str | Path) -> list[dict[str, Any]]:
    path = Path(csv_path)
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        return [_normalize_row(row) for row in reader]


def results_dataframe(results: list[dict[str, Any]]):
    if pd is None:
        raise RuntimeError("pandas is not installed. Run `uv pip install --python .venv\\Scripts\\python.exe -e \".[dev]\"` first.")
    return pd.DataFrame(results)


def assertions_dataframe(results: list[dict[str, Any]]):
    if pd is None:
        raise RuntimeError("pandas is not installed. Run the dev dependency install before using notebook dataframes.")
    rows: list[dict[str, Any]] = []
    for result in results:
        for item in result.get("assertion_results", []):
            rows.append(
                {
                    "case_id": result.get("case_id"),
                    "target": result.get("target"),
                    "url": result.get("url"),
                    "assertion_name": item.get("name"),
                    "passed": item.get("passed"),
                    "expected": item.get("expected"),
                    "actual": item.get("actual"),
                    "message": item.get("message"),
                }
            )
    return pd.DataFrame(rows)


def summarize_results(results: list[dict[str, Any]]) -> dict[str, Any]:
    total = len(results)
    if total == 0:
        return {
            "overall": {
                "total_cases": 0,
                "pass_rate": 0.0,
                "hallucination_rate": 0.0,
                "avg_tool_accuracy": 0.0,
                "avg_reliability": 0.0,
                "avg_latency_ms": 0.0,
                "avg_cost_usd": 0.0,
            },
            "failure_modes": {},
            "status_counts": {},
        }

    passes = sum(1 for item in results if item.get("evaluation_status") == "passed")
    return {
        "overall": {
            "total_cases": total,
            "pass_rate": round(passes / total, 4),
            "hallucination_rate": round(sum(1.0 - float(item.get("hallucination_score", 0.0)) for item in results) / total, 4),
            "avg_tool_accuracy": round(sum(float(item.get("tool_accuracy_score", 0.0)) for item in results) / total, 4),
            "avg_reliability": round(sum(float(item.get("reliability_score", 0.0)) for item in results) / total, 4),
            "avg_latency_ms": round(sum(float(item.get("latency_ms", 0.0)) for item in results) / total, 3),
            "avg_cost_usd": round(sum(float(item.get("total_cost_usd", 0.0)) for item in results) / total, 6),
        },
        "failure_modes": dict(Counter(item.get("failure_mode", "") for item in results if item.get("failure_mode"))),
        "status_counts": dict(Counter(item.get("evaluation_status", "unknown") for item in results)),
    }


def save_results_csv(results: list[dict[str, Any]], path: str | Path) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    flat_rows = []
    for result in results:
        flat_rows.append(
            {
                key: value
                for key, value in result.items()
                if key not in {"artifact", "trace", "assertion_results", "raw_case"}
            }
        )
    if pd is not None:
        results_dataframe(flat_rows).to_csv(target, index=False)
    else:
        fieldnames = sorted({key for row in flat_rows for key in row.keys()})
        with target.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            writer.writerows(flat_rows)
    return target


async def run_case_batch(
    target: str,
    *,
    csv_path: str | Path | None = None,
    settings: Settings | None = None,
    enabled_only: bool = True,
    limit: int | None = None,
    persist_orchestrator_runs: bool = False,
) -> list[dict[str, Any]]:
    case_path = Path(csv_path) if csv_path is not None else TARGET_TO_CASE_FILE[target]
    rows = load_case_rows(case_path)
    if enabled_only:
        rows = [row for row in rows if row.get("enabled", True)]
    if limit is not None:
        rows = rows[:limit]

    active_settings = settings or Settings.from_yaml()
    results: list[dict[str, Any]] = []
    for index, row in enumerate(rows, start=1):
        results.append(
            await run_single_case(
                target,
                row,
                case_index=index,
                settings=active_settings,
                persist_orchestrator_run=persist_orchestrator_runs,
            )
        )
    return results


async def run_single_case(
    target: str,
    row: dict[str, Any],
    *,
    case_index: int = 1,
    settings: Settings | None = None,
    persist_orchestrator_run: bool = False,
) -> dict[str, Any]:
    active_settings = settings or Settings.from_yaml()
    run_id = str(uuid.uuid4())
    observer = run_registry.create(
        run_id=run_id,
        root_actor=target,
        observability=get_observability_status(active_settings),
    )
    url = str(row.get("url", "") or "").strip()
    observer.set_url(url)
    case = row_to_evaluation_case(row, target=target, case_index=case_index)

    artifact: dict[str, Any]
    error_text = ""
    try:
        result = await _run_target(target, url, active_settings, observer)
        artifact = _normalize_artifact(result)
        if persist_orchestrator_run and isinstance(result, PipelineResult):
            session = get_session()
            try:
                RunRepository(session).save(result, trace=run_registry.get(run_id))
            finally:
                session.close()
    except Exception as exc:
        error_text = str(exc)
        artifact = {
            "url": url,
            "status": "failed",
            "final_status": "failed",
            "error_message": str(exc),
            "failure_mode": type(exc).__name__,
        }

    trace_model = observer.trace()
    trace_payload = trace_model.model_dump(mode="json")
    metrics = trace_model.metrics
    latency_ms = (metrics.total_duration_seconds if metrics else 0.0) * 1000.0
    total_cost_usd = metrics.estimated_total_cost_usd if metrics else 0.0
    case_result = evaluate_case_artifact(
        case,
        artifact=artifact,
        trace=trace_payload,
        latency_ms=latency_ms,
        total_cost_usd=total_cost_usd,
    )
    stream_urls = set(_collect_urls(artifact, "all_streams")) | set(_collect_urls(artifact, "streams"))
    return {
        "case_id": row.get("case_id") or f"{target}-{case_index:03d}",
        "target": target,
        "url": url,
        "enabled": row.get("enabled", True),
        "tags": row.get("tags", []),
        "notes": row.get("notes", ""),
        "run_id": run_id,
        "evaluation_status": case_result.status,
        "artifact_status": artifact.get("final_status") or artifact.get("status") or "",
        "page_type": artifact.get("page_type") or (artifact.get("classification") or {}).get("page_type", ""),
        "stream_count": len(stream_urls),
        "provider_count": len(artifact.get("provider_analysis", []) or []),
        "email_count": len(artifact.get("takedown_emails", []) or []),
        "latency_ms": round(latency_ms, 3),
        "total_cost_usd": round(total_cost_usd, 6),
        "total_tokens_in": metrics.total_tokens_in if metrics else 0,
        "total_tokens_out": metrics.total_tokens_out if metrics else 0,
        "total_llm_calls": metrics.total_llm_calls if metrics else 0,
        "total_tool_calls": metrics.total_tool_calls if metrics else 0,
        "hallucination_score": case_result.hallucination_score,
        "tool_accuracy_score": case_result.tool_accuracy_score,
        "reliability_score": case_result.reliability_score,
        "failure_mode": artifact.get("failure_mode") or error_text,
        "error_text": error_text,
        "assertion_results": [item.model_dump(mode="json") for item in case_result.assertion_results],
        "artifact": artifact,
        "trace": trace_payload,
        "raw_case": row,
    }


def row_to_evaluation_case(row: dict[str, Any], *, target: str, case_index: int) -> EvaluationCase:
    assertions: dict[str, Any] = {}
    for field in (
        "expected_page_type",
        "confidence_at_least",
        "expected_final_status",
        "expected_failure_mode",
    ):
        value = _clean_string(row.get(field, ""))
        if value:
            assertions[field] = value

    for field in ("min_streams", "max_streams", "min_hosting_pages", "min_embedded_urls", "max_tool_errors"):
        value = _maybe_int(row.get(field, ""))
        if value is not None:
            assertions[field] = value

    for field in ("requires_provider_analysis", "requires_email_targets"):
        value = _maybe_bool(row.get(field, ""))
        if value is not None:
            assertions[field] = value

    for field in (
        "required_tools",
        "forbidden_tools",
        "expected_provider_keywords",
        "expected_stream_host_keywords",
        "expected_hosting_url_keywords",
        "expected_embedded_url_keywords",
    ):
        values = _split_multi(row.get(field, ""))
        if values:
            assertions[field] = values

    return EvaluationCase(
        id=case_index,
        name=str(row.get("case_id") or f"{target}-{case_index:03d}"),
        description=str(row.get("notes", "") or ""),
        mode="live",
        target_type="workflow" if target == "orchestrator" else "agent",
        input={"url": str(row.get("url", "") or "")},
        assertions=assertions,
        metadata={"tags": row.get("tags", [])},
    )


def template_dataframe(target: str):
    rows = load_case_rows(TARGET_TO_CASE_FILE[target])
    return results_dataframe(rows) if pd is not None else rows


async def _run_target(target: str, url: str, settings: Settings, observer):
    normalized = target.strip().lower()
    if normalized == "classification":
        from src.agents.classification import ClassificationAgent

        return await ClassificationAgent(settings).run(url=url, observer=observer)
    if normalized == "landing":
        from src.agents.landing_page import LandingPageAgent

        return await LandingPageAgent(settings).run(url=url, observer=observer)
    if normalized == "hosting":
        from src.agents.hosting_page import HostingPageAgent

        return await HostingPageAgent(settings).run(url=url, observer=observer)
    if normalized == "embedded":
        from src.agents.embedded_page import EmbeddedPageAgent

        return await EmbeddedPageAgent(settings).run(url=url, observer=observer)
    if normalized == "orchestrator":
        from src.agents.orchestrator import run_pipeline

        return await run_pipeline(url=url, settings=settings, observer=observer)
    raise ValueError(f"Unknown target '{target}'")


def _normalize_artifact(result: Any) -> dict[str, Any]:
    if isinstance(result, (PipelineResult, ExtractionResult, ClassificationResult)):
        return result.model_dump(mode="json")
    if isinstance(result, dict):
        return json.loads(json.dumps(result))
    return {"result": str(result)}


def _normalize_row(row: dict[str, Any]) -> dict[str, Any]:
    normalized = {column: row.get(column, "") for column in CSV_COLUMNS}
    normalized["enabled"] = _maybe_bool(normalized.get("enabled", True))
    normalized["tags"] = _split_multi(normalized.get("tags", ""))
    normalized["notes"] = _clean_string(normalized.get("notes", ""))
    return normalized


def _split_multi(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    text = str(value or "").replace(",", "|")
    return [item.strip() for item in text.split("|") if item.strip()]


def _maybe_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    text = str("" if value is None else value).strip().lower()
    if text in {"1", "true", "yes", "y"}:
        return True
    if text in {"0", "false", "no", "n"}:
        return False
    return None


def _maybe_int(value: Any) -> int | None:
    if isinstance(value, int):
        return value
    text = str("" if value is None else value).strip()
    if not text:
        return None
    return int(text)


def _clean_string(value: Any) -> str:
    return str(value or "").strip()


def _collect_urls(artifact: dict[str, Any], key: str) -> list[str]:
    values = artifact.get(key, []) or []
    collected: list[str] = []
    for item in values:
        if isinstance(item, dict) and item.get("url"):
            collected.append(str(item["url"]))
        elif isinstance(item, str):
            collected.append(item)
    return collected
