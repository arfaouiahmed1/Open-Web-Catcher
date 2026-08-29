"""Dataset helpers for local run curation and JSONL export."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from src.models.schemas import PipelineResult
from src.utils.config import Settings
from src.utils.instrumentation import resolve_default_dataset_name

EXPORTS_ROOT = Path("data") / "exports"


def _safe_dataset_slug(name: str, fallback: str) -> str:
    """Neutralize path separators and traversal sequences in a caller-supplied name."""
    cleaned = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in name.strip())
    return cleaned or fallback


class DatasetExample(BaseModel):
    input: dict[str, Any]
    output: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


def pipeline_result_to_dataset_example(result: PipelineResult) -> DatasetExample:
    metrics = result.metrics
    return DatasetExample(
        input={"url": result.url},
        output={
            "run_id": result.run_id,
            "page_type": result.classification.page_type.value if result.classification else "unknown",
            "final_status": result.final_status.value,
            "stream_urls": [stream.url for stream in result.all_streams],
            "provider_names": [provider.provider for provider in result.provider_analysis if provider.provider],
            "email_targets": [email.abuse_email for email in result.takedown_emails if email.abuse_email],
        },
        metadata={
            "success": bool(metrics.success) if metrics else result.final_status.value == "success",
            "failure_mode": metrics.failure_mode if metrics else "",
            "tool_calls": metrics.total_tool_calls if metrics else 0,
            "llm_calls": metrics.total_llm_calls if metrics else 0,
            "tokens_in": metrics.total_tokens_in if metrics else 0,
            "tokens_out": metrics.total_tokens_out if metrics else 0,
            "message_count": metrics.total_messages if metrics else 0,
            "estimated_total_cost_usd": metrics.estimated_total_cost_usd if metrics else 0.0,
            "matches_found": len(result.matches),
            "stream_count": len(result.all_streams),
            "screenshot_count": len(result.all_screenshots),
            "provider_count": len(result.provider_analysis),
            "email_count": len(result.takedown_emails),
            "agents_invoked": [agent.value for agent in (metrics.agents_invoked if metrics else [])],
            "model_usage": [entry.model_dump(mode="json") for entry in (metrics.model_usage if metrics else [])],
            "collected_at": datetime.now(UTC).isoformat(),
        },
    )


def build_dataset_examples(results: list[PipelineResult]) -> list[DatasetExample]:
    return [pipeline_result_to_dataset_example(result) for result in results]


def export_dataset_examples(
    examples: list[DatasetExample],
    *,
    settings: Settings,
    dataset_name: str = "",
    path: str | Path | None = None,
) -> Path:
    """Write ``examples`` to a server-controlled location and return its path.

    The destination is always derived internally as
    ``data/exports/<utc-timestamp>/<dataset-slug>-<utc-timestamp>.jsonl``.
    ``path`` is accepted for backward compatibility but IGNORED: caller input
    must never steer where exports are written (arbitrary-file-write fix).
    """
    del path
    resolved_dataset_name = _safe_dataset_slug(
        dataset_name, resolve_default_dataset_name(settings)
    )
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    export_dir = EXPORTS_ROOT / timestamp
    export_dir.mkdir(parents=True, exist_ok=True)
    export_path = export_dir / f"{resolved_dataset_name}-{timestamp}.jsonl"

    with open(export_path, "w", encoding="utf-8") as f:
        for example in examples:
            f.write(example.model_dump_json())
            f.write("\n")
    return export_path


def load_json_rows(path: str | Path) -> list[dict[str, Any]]:
    target = Path(path)
    if not target.exists():
        return []
    with open(target, encoding="utf-8") as f:
        return json.load(f)
