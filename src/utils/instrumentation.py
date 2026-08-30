"""Internal observability and pricing helpers."""

from __future__ import annotations

import json
import os
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from src.utils.config import Settings
from src.utils.provider_models import resolve_model_context_window

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


def resolve_model_pricing(settings: Settings, model_name: str, provider: str = "") -> dict[str, Any] | None:
    """Resolve catalog pricing for a model using exact matching only.

    Resolution order: exact composite (``provider::model``) / bare key, then
    punctuation-canonical equality, then the exact suffix of a routed name
    (``gemini/gemini-2.5-flash`` -> ``gemini-2.5-flash``), then the canonical
    alias table. Prefix/fuzzy matching is deliberately absent: it silently
    bound ``gemini-2.5-flash-lite`` to flash rates (~4x overprice). Returns
    ``None`` when nothing matches exactly; callers treat ``None`` as unpriced.
    """
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

    if not match and model_key and "/" in model_key:
        # Exact native-name lookup for routed LiteLLM names — not prefix matching.
        routed_suffix = model_key.split("/", 1)[1].strip()
        if routed_suffix:
            composite_suffix = f"{provider_key}::{routed_suffix}" if provider_key else ""
            match = pricing.get(composite_suffix, {}) or pricing.get(routed_suffix, {})

    if not match and model_key:
        alias_targets = [model_key]
        if "/" in model_key:
            alias_targets.append(model_key.split("/", 1)[1].strip())
        for target in alias_targets:
            alias_key = _MODEL_PRICING_ALIASES.get(target, "")
            if not alias_key:
                continue
            composite_alias = f"{provider_key}::{alias_key}" if provider_key else ""
            match = (pricing.get(composite_alias, {}) if composite_alias else {}) or pricing.get(alias_key, {})
            if match:
                break

    if not match:
        return None

    context_window = int(match.get("context_window", 0) or 0)
    if context_window <= 0:
        context_window = int(resolve_model_context_window(model_name, provider) or 0)

    return {
        "provider": str(match.get("provider") or provider_key or "").strip(),
        "input_per_million": float(match.get("input_per_million", 0.0) or 0.0),
        "output_per_million": float(match.get("output_per_million", 0.0) or 0.0),
        "cached_input_per_million": float(match.get("cached_input_per_million", 0.0) or 0.0),
        "cache_write_per_million": float(match.get("cache_write_per_million", 0.0) or 0.0),
        "context_window": context_window,
    }


def estimate_usage_cost(
    input_tokens: int,
    output_tokens: int,
    *,
    cached_input_tokens: int = 0,
    cache_write_input_tokens: int = 0,
    thinking_tokens: int = 0,
    input_per_million: float = 0.0,
    output_per_million: float = 0.0,
    cached_input_per_million: float = 0.0,
    cache_write_per_million: float = 0.0,
    cache_write_multiplier: float = 1.0,
    cached_is_subset_of_input: bool = True,
    thinking_billed_as_output: bool = True,
) -> dict[str, float]:
    """Price one usage payload according to the row's cache semantics.

    SUBSET (Gemini/OpenAI): ``input`` already contains cached/write tokens, so
    the billable uncached input is what remains after removing both.
    DISJOINT (Anthropic): ``input`` excludes cache read/write, so it is billed
    whole while reads price at the cached rate and writes at
    ``cached_rate * multiplier`` (explicit ``cache_write_per_million`` wins).
    Thinking tokens bill at the output rate only when the row says so — OpenAI
    and Anthropic already include reasoning in ``output``, Gemini does not.
    """
    input_tokens = max(int(input_tokens), 0)
    output_tokens = max(int(output_tokens), 0)
    cached_input_tokens = max(int(cached_input_tokens), 0)
    cache_write_input_tokens = max(int(cache_write_input_tokens), 0)
    thinking_tokens = max(int(thinking_tokens), 0)

    input_rate = max(input_per_million, 0.0)
    output_rate = max(output_per_million, 0.0)
    cached_rate = max(cached_input_per_million, 0.0)
    write_rate = (
        max(cache_write_per_million, 0.0)
        if cache_write_per_million > 0.0
        else cached_rate * max(cache_write_multiplier, 0.0)
    )

    if cached_is_subset_of_input:
        billable_input_tokens = max(input_tokens - cached_input_tokens - cache_write_input_tokens, 0)
    else:
        billable_input_tokens = input_tokens

    input_cost = (billable_input_tokens / 1_000_000.0) * input_rate
    cached_input_cost = (cached_input_tokens / 1_000_000.0) * cached_rate
    cache_write_cost = (cache_write_input_tokens / 1_000_000.0) * write_rate
    output_cost = (output_tokens / 1_000_000.0) * output_rate
    thinking_cost = (thinking_tokens / 1_000_000.0) * output_rate if thinking_billed_as_output else 0.0

    return {
        "estimated_input_cost_usd": round(input_cost, 8),
        "estimated_cached_input_cost_usd": round(cached_input_cost, 8),
        "estimated_cache_write_cost_usd": round(cache_write_cost, 8),
        "estimated_output_cost_usd": round(output_cost, 8),
        "estimated_thinking_cost_usd": round(thinking_cost, 8),
        "estimated_total_cost_usd": round(
            input_cost + cached_input_cost + cache_write_cost + output_cost + thinking_cost, 8
        ),
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
