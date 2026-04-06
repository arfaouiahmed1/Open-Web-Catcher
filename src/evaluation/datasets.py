"""Dataset helpers for local run curation and Phoenix dataset publishing."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from src.models.schemas import PipelineResult
from src.utils.config import Settings
from src.utils.phoenix import (
    resolve_phoenix_api_key,
    resolve_phoenix_base_url,
    resolve_phoenix_dataset_dir,
    resolve_phoenix_default_dataset_name,
)

DEFAULT_CASES_PATH = Path("data/test_cases/sites.json")


class PhoenixDatasetExample(BaseModel):
    input: dict[str, Any]
    output: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


def load_test_cases(path: str | Path = DEFAULT_CASES_PATH) -> list[dict[str, Any]]:
    """Load golden test cases from a JSON file."""
    p = Path(path)
    if not p.exists():
        return []
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def save_test_cases(cases: list[dict[str, Any]], path: str | Path = DEFAULT_CASES_PATH) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(cases, f, indent=2, ensure_ascii=False)


def pipeline_result_to_dataset_example(result: PipelineResult) -> PhoenixDatasetExample:
    metrics = result.metrics
    return PhoenixDatasetExample(
        input={
            "url": result.url,
        },
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
            "model_usage": [
                entry.model_dump(mode="json")
                for entry in (metrics.model_usage if metrics else [])
            ],
            "collected_at": datetime.utcnow().isoformat(),
        },
    )


def build_dataset_examples(results: list[PipelineResult]) -> list[PhoenixDatasetExample]:
    return [pipeline_result_to_dataset_example(result) for result in results]


def export_dataset_examples(
    examples: list[PhoenixDatasetExample],
    *,
    settings: Settings,
    dataset_name: str = "",
    path: str | Path | None = None,
) -> Path:
    resolved_dataset_name = dataset_name or resolve_phoenix_default_dataset_name(settings)
    if path is None:
        export_dir = resolve_phoenix_dataset_dir(settings)
        timestamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        path = export_dir / f"{resolved_dataset_name}-{timestamp}.jsonl"

    export_path = Path(path)
    export_path.parent.mkdir(parents=True, exist_ok=True)
    with open(export_path, "w", encoding="utf-8") as f:
        for example in examples:
            f.write(example.model_dump_json())
            f.write("\n")
    return export_path


def publish_dataset_to_phoenix(
    examples: list[PhoenixDatasetExample],
    *,
    settings: Settings,
    dataset_name: str = "",
    dataset_description: str = "",
) -> dict[str, Any]:
    try:
        from phoenix.client import Client
    except Exception as exc:  # pragma: no cover - import guard
        raise RuntimeError(
            "Phoenix client is not installed. Add 'arize-phoenix-client' to your environment first."
        ) from exc

    resolved_dataset_name = dataset_name or resolve_phoenix_default_dataset_name(settings)
    base_url = resolve_phoenix_base_url(settings)
    api_key = resolve_phoenix_api_key(settings) or None

    client_kwargs: dict[str, Any] = {"base_url": base_url}
    if api_key:
        client_kwargs["api_key"] = api_key
    client = Client(**client_kwargs)
    resolved_name = resolved_dataset_name

    try:
        client.datasets.get_dataset(dataset=resolved_dataset_name)
    except Exception:
        pass
    else:
        suffix = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
        resolved_name = f"{resolved_dataset_name}-{suffix}"

    dataset = client.datasets.create_dataset(
        name=resolved_name,
        dataset_description=dataset_description or f"Collected from Open Web Catcher runs for {resolved_name}",
        inputs=[example.input for example in examples],
        outputs=[example.output for example in examples],
        metadata=[example.metadata for example in examples],
    )
    return {
        "name": resolved_name,
        "example_count": len(examples),
        "base_url": base_url,
        "dataset": str(getattr(dataset, "name", resolved_name)),
    }
