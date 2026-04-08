"""Internal observability and pricing helpers."""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from src.utils.config import Settings

_PLACEHOLDER_VALUES = {
    "",
    "your_api_key_here",
    "changeme",
    "replace-me",
}


def _clean_value(value: str | None) -> str:
    cleaned = (value or "").strip()
    if cleaned.lower() in _PLACEHOLDER_VALUES:
        return ""
    return cleaned


def _parse_bool(value: str | None) -> bool | None:
    if value is None:
        return None

    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def _safe_json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return str(value)


def _coerce_span_value(value: Any) -> bool | int | float | str:
    if isinstance(value, (bool, int, float, str)):
        return value
    return _safe_json(value)


def resolve_observability_enabled(settings: Settings) -> bool:
    parsed = _parse_bool(os.getenv("OBSERVABILITY_ENABLED"))
    if parsed is not None:
        return parsed
    return bool(settings.observability_enabled)


def resolve_observability_project_name(settings: Settings) -> str:
    value = (os.getenv("OBSERVABILITY_PROJECT_NAME") or settings.observability_project_name or "").strip()
    return value or "open-web-catcher"


def resolve_default_dataset_name(settings: Settings) -> str:
    value = _clean_value(os.getenv("OBSERVABILITY_DEFAULT_DATASET_NAME")) or settings.default_dataset_name
    return value or "open-web-catcher-runs"


def resolve_dataset_dir(settings: Settings) -> Path:
    value = _clean_value(os.getenv("OBSERVABILITY_DATASET_DIR")) or settings.dataset_dir
    return Path(value or "data/datasets")


def resolve_model_pricing_config(settings: Settings) -> dict[str, dict[str, Any]]:
    raw = _clean_value(os.getenv("MODEL_PRICING_JSON")) or settings.model_pricing_json
    if not raw:
        return {}

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {}

    if not isinstance(parsed, dict):
        return {}

    normalized: dict[str, dict[str, Any]] = {}
    for model_name, config in parsed.items():
        if not isinstance(model_name, str) or not isinstance(config, dict):
            continue

        normalized[model_name.strip().lower()] = {
            "provider": str(config.get("provider", "") or "").strip(),
            "input_per_million": float(config.get("input_per_million", 0.0) or 0.0),
            "output_per_million": float(config.get("output_per_million", 0.0) or 0.0),
        }
    return normalized


def resolve_model_pricing(settings: Settings, model_name: str, provider: str = "") -> dict[str, Any]:
    pricing = resolve_model_pricing_config(settings)
    match = pricing.get((model_name or "").strip().lower(), {})
    return {
        "provider": str(match.get("provider") or provider or "").strip(),
        "input_per_million": float(match.get("input_per_million", 0.0) or 0.0),
        "output_per_million": float(match.get("output_per_million", 0.0) or 0.0),
    }


def estimate_usage_cost(
    input_tokens: int,
    output_tokens: int,
    *,
    input_per_million: float = 0.0,
    output_per_million: float = 0.0,
) -> dict[str, float]:
    input_cost = (max(input_tokens, 0) / 1_000_000.0) * max(input_per_million, 0.0)
    output_cost = (max(output_tokens, 0) / 1_000_000.0) * max(output_per_million, 0.0)
    return {
        "estimated_input_cost_usd": round(input_cost, 8),
        "estimated_output_cost_usd": round(output_cost, 8),
        "estimated_total_cost_usd": round(input_cost + output_cost, 8),
    }


@contextmanager
def using_observability_context(
    *,
    session_id: str = "",
    user_id: str = "",
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
) -> Iterator[None]:
    _ = (session_id, user_id, metadata, tags)
    yield


class _NoopSpan:
    def set_attribute(self, *args: Any, **kwargs: Any) -> None:
        return None


def set_span_input(span: Any, value: Any) -> None:
    try:
        span.set_attribute("input.value", _coerce_span_value(value))
    except Exception:
        pass


def set_span_output(span: Any, value: Any) -> None:
    try:
        span.set_attribute("output.value", _coerce_span_value(value))
    except Exception:
        pass


def set_span_attributes(span: Any, attributes: dict[str, Any] | None = None) -> None:
    if not attributes:
        return
    for key, value in attributes.items():
        if value is None:
            continue
        try:
            span.set_attribute(key, _coerce_span_value(value))
        except Exception:
            continue


@contextmanager
def observability_span(
    name: str,
    *,
    kind: str = "CHAIN",
    input_value: Any | None = None,
    attributes: dict[str, Any] | None = None,
) -> Iterator[Any]:
    _ = (name, kind)
    span = _NoopSpan()
    if input_value is not None:
        set_span_input(span, input_value)
    set_span_attributes(span, attributes)
    yield span
