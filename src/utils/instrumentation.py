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
    raw_candidates = [
        _clean_value(os.getenv("MODEL_PRICING_JSON")),
        settings.model_pricing_json,
    ]
    parsed_sources: list[dict[str, Any]] = []
    for raw in raw_candidates:
        if not raw:
            continue
        try:
            candidate = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if isinstance(candidate, dict):
            parsed_sources.append(candidate)

    if not parsed_sources:
        return {}

    parsed: dict[str, Any] = {}
    for candidate in parsed_sources:
        # Runtime-refreshed settings should override stale env defaults while
        # still inheriting any rows only present in the env payload.
        parsed.update(candidate)

    normalized: dict[str, dict[str, Any]] = {}
    for model_name, config in parsed.items():
        if not isinstance(model_name, str) or not isinstance(config, dict):
            continue

        provider = str(config.get("provider", "") or "").strip().lower()
        if provider in {"google_genai", "gemini"}:
            provider = "google"
        model_key = model_name.strip().lower()
        payload = {
            "provider": provider,
            "input_per_million": float(config.get("input_per_million", 0.0) or 0.0),
            "output_per_million": float(config.get("output_per_million", 0.0) or 0.0),
            "cached_input_per_million": float(config.get("cached_input_per_million", 0.0) or 0.0),
            "cache_write_per_million": float(config.get("cache_write_per_million", 0.0) or 0.0),
            "context_window": int(config.get("context_window", 0) or 0),
        }
        normalized[model_key] = payload
        if provider:
            normalized[f"{provider}::{model_key}"] = payload
    return normalized


_MODEL_PRICING_ALIASES: dict[str, str] = {
    "gemini-flash-lite-latest": "gemini-2.5-flash-lite",
    "gemini-flash-latest": "gemini-2.5-flash",
    "gemini-pro-latest": "gemini-2.5-pro",
    "gemini-3-flash-preview": "gemini-2.5-flash",
    "gemini-3-flash-preview-05-20": "gemini-2.5-flash",
    "gemini-3-pro-preview": "gemini-2.5-pro",
    "gemini-3-pro-preview-05-06": "gemini-2.5-pro",
    "gemini-2.5-flash-preview": "gemini-2.5-flash",
    "gemini-2.5-flash-preview-04-17": "gemini-2.5-flash",
    "gemini-2.5-pro-preview": "gemini-2.5-pro",
    "gemini-2.5-pro-preview-05-06": "gemini-2.5-pro",
    "gemini-2.0-flash-exp": "gemini-2.0-flash",
    "gemini-2.0-flash-thinking-exp": "gemini-2.0-flash",
    "gemini-exp-1206": "gemini-2.0-flash",
}


def _canonical_model_key(value: str) -> str:
    text = (value or "").strip().lower()
    if not text:
        return ""
    if "::" in text:
        provider_part, model_part = text.split("::", 1)
        model_text = model_part
        provider_text = provider_part
    else:
        provider_text = ""
        model_text = text
    compact = "".join(ch for ch in model_text if ch.isalnum() or ch == "/")
    return f"{provider_text}::{compact}" if provider_text else compact


def resolve_model_pricing(settings: Settings, model_name: str, provider: str = "") -> dict[str, Any]:
    pricing = resolve_model_pricing_config(settings)
    model_key = (model_name or "").strip().lower()
    provider_key = (provider or "").strip().lower()
    if provider_key in {"google_genai", "gemini"}:
        provider_key = "google"
    composite_key = f"{provider_key}::{model_key}" if provider_key else ""

    match = pricing.get(composite_key, {}) if composite_key else {}
    if not match:
        match = pricing.get(model_key, {})

    if not match and model_key:
        canonical_model = _canonical_model_key(model_key)
        canonical_composite = _canonical_model_key(composite_key) if composite_key else ""
        if canonical_composite:
            for key, value in pricing.items():
                if _canonical_model_key(key) == canonical_composite:
                    match = value
                    break
        if not match and canonical_model:
            for key, value in pricing.items():
                if _canonical_model_key(key) == canonical_model:
                    match = value
                    break

    if not match and model_key:
        candidates: list[str] = []
        if "/" in model_key:
            candidates.append(model_key.split("/", 1)[1].strip())
        sanitized = model_key.replace(".", "-").rstrip("-")
        candidates.append(sanitized)
        candidates.append(sanitized.split("-20", 1)[0] if "-20" in sanitized else sanitized)

        seen: set[str] = set()
        for candidate in candidates:
            key = (candidate or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            if provider_key:
                composite_candidate = f"{provider_key}::{key}"
                match = pricing.get(composite_candidate, {})
                if match:
                    break
            match = pricing.get(key, {})
            if match:
                break

        if not match:
            model_candidates = [item for item in seen if item]
            for key, value in pricing.items():
                if provider_key and not key.startswith(f"{provider_key}::"):
                    continue
                normalized_key = key.split("::", 1)[1] if "::" in key else key
                if any(model.startswith(normalized_key) or normalized_key.startswith(model) for model in model_candidates):
                    match = value
                    break

    if not match and model_key in _MODEL_PRICING_ALIASES:
        alias_key = _MODEL_PRICING_ALIASES[model_key]
        composite_alias = f"{provider_key}::{alias_key}" if provider_key else ""
        match = (pricing.get(composite_alias, {}) if composite_alias else {}) or pricing.get(alias_key, {})

    return {
        "provider": str(match.get("provider") or provider_key or "").strip(),
        "input_per_million": float(match.get("input_per_million", 0.0) or 0.0),
        "output_per_million": float(match.get("output_per_million", 0.0) or 0.0),
        "cached_input_per_million": float(match.get("cached_input_per_million", 0.0) or 0.0),
        "cache_write_per_million": float(match.get("cache_write_per_million", 0.0) or 0.0),
        "context_window": int(match.get("context_window", 0) or 0),
    }


def estimate_usage_cost(
    input_tokens: int,
    output_tokens: int,
    *,
    cached_input_tokens: int = 0,
    cache_write_input_tokens: int = 0,
    input_per_million: float = 0.0,
    output_per_million: float = 0.0,
    cached_input_per_million: float = 0.0,
    cache_write_per_million: float = 0.0,
) -> dict[str, float]:
    input_cost = (max(input_tokens, 0) / 1_000_000.0) * max(input_per_million, 0.0)
    cached_input_cost = (max(cached_input_tokens, 0) / 1_000_000.0) * max(cached_input_per_million, 0.0)
    cache_write_cost = (max(cache_write_input_tokens, 0) / 1_000_000.0) * max(cache_write_per_million, 0.0)
    output_cost = (max(output_tokens, 0) / 1_000_000.0) * max(output_per_million, 0.0)
    return {
        "estimated_input_cost_usd": round(input_cost, 8),
        "estimated_cached_input_cost_usd": round(cached_input_cost, 8),
        "estimated_cache_write_cost_usd": round(cache_write_cost, 8),
        "estimated_output_cost_usd": round(output_cost, 8),
        "estimated_total_cost_usd": round(input_cost + cached_input_cost + cache_write_cost + output_cost, 8),
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
