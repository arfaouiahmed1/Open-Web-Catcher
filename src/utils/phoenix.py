"""Helpers for Phoenix tracing, pricing, datasets, and manual span enrichment."""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

from src.utils.config import Settings

_PLACEHOLDER_VALUES = {
    "",
    "your_api_key_here",
    "changeme",
    "replace-me",
}
_CLOUD_HOSTS = {
    "app.phoenix.arize.com",
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


def resolve_phoenix_tracing(settings: Settings) -> bool:
    parsed = _parse_bool(os.getenv("PHOENIX_TRACING"))
    if parsed is not None:
        return parsed
    return bool(settings.phoenix_tracing)


def resolve_phoenix_api_key(settings: Settings) -> str:
    return _clean_value(os.getenv("PHOENIX_API_KEY")) or _clean_value(settings.phoenix_api_key)


def resolve_phoenix_project_name(settings: Settings) -> str:
    value = (os.getenv("PHOENIX_PROJECT_NAME") or settings.phoenix_project_name or "").strip()
    return value or "open-web-catcher"


def resolve_phoenix_collector_endpoint(settings: Settings) -> str:
    endpoint = _clean_value(os.getenv("PHOENIX_COLLECTOR_ENDPOINT")) or settings.phoenix_collector_endpoint
    return endpoint.rstrip("/")


def resolve_phoenix_ui_url(settings: Settings) -> str:
    ui_url = _clean_value(os.getenv("PHOENIX_UI_URL")) or settings.phoenix_ui_url
    if ui_url:
        return ui_url.rstrip("/")

    endpoint = resolve_phoenix_collector_endpoint(settings)
    parsed = urlparse(endpoint)
    if not parsed.scheme or not parsed.netloc:
        return ""

    return f"{parsed.scheme}://{parsed.netloc}"


def resolve_phoenix_base_url(settings: Settings) -> str:
    base_url = _clean_value(os.getenv("PHOENIX_BASE_URL")) or _clean_value(settings.phoenix_base_url)
    if base_url:
        return base_url.rstrip("/")

    ui_url = resolve_phoenix_ui_url(settings)
    if ui_url:
        return ui_url

    return resolve_phoenix_collector_endpoint(settings)


def resolve_phoenix_default_dataset_name(settings: Settings) -> str:
    value = _clean_value(os.getenv("PHOENIX_DEFAULT_DATASET_NAME")) or settings.phoenix_default_dataset_name
    return value or "open-web-catcher-runs"


def resolve_phoenix_dataset_dir(settings: Settings) -> Path:
    value = _clean_value(os.getenv("PHOENIX_DATASET_DIR")) or settings.phoenix_dataset_dir
    return Path(value or "data/datasets")


def resolve_phoenix_model_pricing(settings: Settings) -> dict[str, dict[str, Any]]:
    raw = _clean_value(os.getenv("PHOENIX_MODEL_PRICING_JSON")) or settings.phoenix_model_pricing_json
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


def resolve_model_pricing(
    settings: Settings,
    model_name: str,
    provider: str = "",
) -> dict[str, Any]:
    pricing = resolve_phoenix_model_pricing(settings)
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


def is_self_hosted_phoenix(settings: Settings) -> bool:
    endpoint = resolve_phoenix_collector_endpoint(settings)
    hostname = (urlparse(endpoint).hostname or "").lower()
    if not hostname:
        return False
    return hostname not in _CLOUD_HOSTS


@contextmanager
def using_phoenix_attributes(
    *,
    session_id: str = "",
    user_id: str = "",
    metadata: dict[str, Any] | None = None,
    tags: list[str] | None = None,
) -> Iterator[None]:
    try:
        from openinference.instrumentation import using_attributes
    except Exception:
        yield
        return

    kwargs: dict[str, Any] = {}
    if session_id:
        kwargs["session_id"] = session_id
    if user_id:
        kwargs["user_id"] = user_id
    if metadata:
        kwargs["metadata"] = metadata
    if tags:
        kwargs["tags"] = tags

    if not kwargs:
        yield
        return

    with using_attributes(**kwargs):
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
def phoenix_span(
    name: str,
    *,
    kind: str = "CHAIN",
    input_value: Any | None = None,
    attributes: dict[str, Any] | None = None,
) -> Iterator[Any]:
    try:
        from opentelemetry import trace as otel_trace
        from opentelemetry.trace import Status, StatusCode
    except Exception:
        yield _NoopSpan()
        return

    tracer = otel_trace.get_tracer("open-web-catcher.phoenix")
    with tracer.start_as_current_span(name) as span:
        try:
            span.set_attribute("openinference.span.kind", kind.upper())
            if input_value is not None:
                set_span_input(span, input_value)
            set_span_attributes(span, attributes)
            yield span
            span.set_status(Status(StatusCode.OK))
        except Exception as exc:
            span.set_attribute("error.type", type(exc).__name__)
            span.set_attribute("error.message", str(exc))
            span.set_status(Status(StatusCode.ERROR, str(exc)))
            raise
