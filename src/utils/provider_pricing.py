"""Provider pricing sync helpers.

This module fetches model pricing from provider-owned sources and converts it
to the local per-million-token schema used by the observability layer.
"""

from __future__ import annotations

import re
from typing import Any

import httpx

from src.models.schemas import PricingConfig
from src.utils.config import Settings


class ProviderPricingSyncError(RuntimeError):
    """Raised when provider pricing sync fails."""


_OPENROUTER_MODELS_URL_SUFFIX = "/models"
_OPENAI_PRICING_URLS = (
    "https://openai.com/api/pricing/",
    "https://developers.openai.com/api/pricing",
    "https://platform.openai.com/docs/pricing",
)
_ANTHROPIC_PRICING_URLS = (
    "https://docs.anthropic.com/en/docs/about-claude/pricing",
    "https://www.anthropic.com/pricing",
)
_GOOGLE_PRICING_URLS = (
    "https://ai.google.dev/gemini-api/docs/pricing",
    "https://ai.google.dev/pricing",
)

_REQUEST_HEADERS = {
    "Accept": "text/html,application/json;q=0.9,*/*;q=0.8",
    "User-Agent": "open-web-catcher/0.2 (+https://github.com/)",
}


def _normalize_provider(value: str) -> str:
    normalized = (value or "").strip().lower()
    if normalized in {"google_genai", "google", "gemini"}:
        return "google"
    return normalized


def _to_per_million(value: Any) -> float:
    """Convert provider per-token pricing into per-million-token pricing."""
    try:
        per_token = float(value)
    except (TypeError, ValueError):
        return 0.0
    return round(max(per_token, 0.0) * 1_000_000.0, 8)


def _clean_text(payload: str) -> str:
    text = str(payload or "")
    # Keep table/newline structure while stripping HTML tags.
    text = re.sub(r"<\s*br\s*/?\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*p\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"</\s*tr\s*>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = text.replace("&nbsp;", " ")
    text = text.replace("&amp;", "&")
    text = text.replace("&lt;", "<")
    text = text.replace("&gt;", ">")
    text = re.sub(r"[ \t]+", " ", text)
    return text


def _fetch_text(url: str, *, timeout_seconds: int, headers: dict[str, str] | None = None) -> str:
    try:
        response = httpx.get(
            url,
            headers={**_REQUEST_HEADERS, **(headers or {})},
            timeout=max(1, int(timeout_seconds)),
            follow_redirects=True,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ProviderPricingSyncError(f"Pricing sync request failed for '{url}': {exc}") from exc
    return response.text


def _fetch_first_available_text(
    urls: tuple[str, ...],
    *,
    timeout_seconds: int,
    headers: dict[str, str] | None = None,
) -> str:
    last_error: Exception | None = None
    for url in urls:
        try:
            text = _fetch_text(url, timeout_seconds=timeout_seconds, headers=headers)
        except ProviderPricingSyncError as exc:
            last_error = exc
            continue
        if text.strip():
            return text
    if last_error is not None:
        raise last_error
    raise ProviderPricingSyncError("Pricing sync failed: no provider source URL returned usable content.")


def _dedupe_configs(configs: list[PricingConfig], *, max_models: int) -> list[PricingConfig]:
    unique: dict[tuple[str, str], PricingConfig] = {}
    for row in configs:
        key = (row.provider.strip().lower(), row.model_name.strip().lower())
        if not key[1]:
            continue
        if key in unique:
            continue
        unique[key] = row
        if max_models > 0 and len(unique) >= max_models:
            break
    values = list(unique.values())
    values.sort(key=lambda item: item.model_name.lower())
    return values


def _fetch_openrouter_pricing(
    settings: Settings,
    *,
    timeout_seconds: int,
    max_models: int,
) -> list[PricingConfig]:
    api_key = (settings.openrouter_api_key or "").strip()
    if not api_key:
        raise ProviderPricingSyncError("OPENROUTER_API_KEY is missing; cannot sync provider pricing.")

    url = f"{settings.openrouter_base_url.rstrip('/')}{_OPENROUTER_MODELS_URL_SUFFIX}"
    try:
        response = httpx.get(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
            },
            timeout=max(1, int(timeout_seconds)),
            follow_redirects=True,
        )
        response.raise_for_status()
        payload = response.json()
    except httpx.HTTPError as exc:
        raise ProviderPricingSyncError(f"OpenRouter pricing sync failed: {exc}") from exc
    except ValueError as exc:
        raise ProviderPricingSyncError("OpenRouter pricing sync returned invalid JSON payload.") from exc

    rows = payload.get("data", []) if isinstance(payload, dict) else []
    if not isinstance(rows, list):
        raise ProviderPricingSyncError("OpenRouter pricing payload format was not recognized.")

    results: list[PricingConfig] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        model_id = str(row.get("id") or "").strip()
        if not model_id:
            continue

        pricing = row.get("pricing", {})
        if not isinstance(pricing, dict):
            continue

        input_per_million = _to_per_million(pricing.get("prompt"))
        output_per_million = _to_per_million(pricing.get("completion"))
        cached_input_per_million = _to_per_million(pricing.get("input_cache_read"))
        cache_write_per_million = _to_per_million(pricing.get("input_cache_write"))
        if input_per_million == 0.0 and output_per_million == 0.0:
            continue

        try:
            context_window = int(row.get("context_length") or 0)
        except (TypeError, ValueError):
            context_window = 0

        results.append(
            PricingConfig(
                provider="openrouter",
                model_name=model_id,
                input_per_million=input_per_million,
                output_per_million=output_per_million,
                cached_input_per_million=cached_input_per_million,
                cache_write_per_million=cache_write_per_million,
                context_window=context_window,
                active=True,
                notes="Synced from OpenRouter /models API",
            )
        )

        if "/" in model_id:
            vendor, native_model = model_id.split("/", 1)
            vendor = vendor.lstrip("~").strip()
            native_provider = _normalize_provider(vendor)
            if native_provider in {"anthropic", "openai", "google"} and native_model:
                results.append(
                    PricingConfig(
                        provider=native_provider,
                        model_name=native_model,
                        input_per_million=input_per_million,
                        output_per_million=output_per_million,
                        cached_input_per_million=cached_input_per_million,
                        cache_write_per_million=cache_write_per_million,
                        context_window=context_window,
                        active=True,
                        notes="Mirrored from OpenRouter /models API",
                    )
                )

    primary = [r for r in results if r.provider == "openrouter"]
    mirrors = [r for r in results if r.provider != "openrouter"]
    deduped_primary = _dedupe_configs(primary, max_models=max_models)
    kept_ids = {r.model_name for r in deduped_primary}
    surviving_mirrors = [
        r for r in mirrors if any(r.model_name == mid.split("/", 1)[-1] for mid in kept_ids)
    ]
    deduped_mirrors = _dedupe_configs(surviving_mirrors, max_models=0)
    return deduped_primary + deduped_mirrors


def _parse_openai_pricing(text: str, *, max_models: int) -> list[PricingConfig]:
    cleaned = _clean_text(text)
    pattern = re.compile(
        r"\b(?P<model>(?:gpt[a-z0-9.\-]*|o[0-9][a-z0-9.\-]*|text-embedding[a-z0-9.\-]*|whisper[a-z0-9.\-]*|tts[a-z0-9.\-]*|dall-e[a-z0-9.\-]*))"
        r"\s*\$(?P<input>[0-9]+(?:\.[0-9]+)?)"
        r"(?:\s*\$(?:[0-9]+(?:\.[0-9]+)?|-))?"
        r"\s*\$(?P<output>[0-9]+(?:\.[0-9]+)?)",
        flags=re.IGNORECASE,
    )
    results: list[PricingConfig] = []
    for match in pattern.finditer(cleaned):
        model_name = str(match.group("model") or "").strip().lower()
        if not model_name:
            continue
        input_per_million = float(match.group("input") or 0.0)
        output_per_million = float(match.group("output") or 0.0)
        results.append(
            PricingConfig(
                provider="openai",
                model_name=model_name,
                input_per_million=round(max(input_per_million, 0.0), 8),
                output_per_million=round(max(output_per_million, 0.0), 8),
                active=True,
                notes="Synced from OpenAI pricing documentation",
            )
        )
    return _dedupe_configs(results, max_models=max_models)


def _slugify_anthropic_model_name(display_name: str) -> str:
    slug = display_name.strip().lower()
    slug = re.sub(r"\(.*?\)", "", slug)
    slug = re.sub(r"[^a-z0-9.\-\s]", "", slug)
    slug = re.sub(r"\s+", " ", slug).strip()
    if slug.startswith("claude "):
        slug = slug.replace("claude ", "claude-", 1)
    slug = slug.replace(" ", "-").replace(".", "-")
    slug = re.sub(r"-{2,}", "-", slug).strip("-")
    return slug


def _parse_anthropic_pricing(text: str, *, max_models: int) -> list[PricingConfig]:
    cleaned = _clean_text(text)
    # Match each Claude row and extract all MTok prices from the row.
    row_pattern = re.compile(
        r"(?P<name>Claude [A-Za-z0-9.\-\s()]+?)\s*\$(?P<first>[0-9]+(?:\.[0-9]+)?)\s*/\s*MTok"
        r"(?P<rest>.*?)(?=(?:Claude [A-Za-z0-9.\-\s()]+?\s*\$[0-9]+(?:\.[0-9]+)?\s*/\s*MTok)|$)",
        flags=re.IGNORECASE | re.DOTALL,
    )
    price_pattern = re.compile(r"\$([0-9]+(?:\.[0-9]+)?)\s*/\s*MTok", flags=re.IGNORECASE)

    results: list[PricingConfig] = []
    for match in row_pattern.finditer(cleaned):
        display_name = str(match.group("name") or "").strip()
        if not display_name:
            continue
        row_text = f"{display_name} ${match.group('first')} / MTok {match.group('rest')}"
        prices = [float(item) for item in price_pattern.findall(row_text)]
        if not prices:
            continue
        input_per_million = prices[0]
        output_per_million = prices[-1]
        model_name = _slugify_anthropic_model_name(display_name)
        if not model_name:
            continue
        results.append(
            PricingConfig(
                provider="anthropic",
                model_name=model_name,
                input_per_million=round(max(input_per_million, 0.0), 8),
                output_per_million=round(max(output_per_million, 0.0), 8),
                active=True,
                notes="Synced from Anthropic pricing documentation",
            )
        )
    return _dedupe_configs(results, max_models=max_models)


def _extract_first_dollar_amount(text: str, label: str) -> float:
    pattern = re.compile(rf"{re.escape(label)}[^$]*\$(\d+(?:\.\d+)?)", flags=re.IGNORECASE)
    match = pattern.search(text)
    if not match:
        return 0.0
    return float(match.group(1) or 0.0)


def _parse_google_pricing(text: str, *, max_models: int) -> list[PricingConfig]:
    cleaned = _clean_text(text)
    primary_pattern = re.compile(
        r"`(?P<model>gemini-[a-z0-9.\-]+)`(?P<body>.*?)(?=(?:`gemini-[a-z0-9.\-]+`|##\s+Gemma|$))",
        flags=re.IGNORECASE | re.DOTALL,
    )
    fallback_pattern = re.compile(
        r"(?P<model>gemini-[a-z0-9.\-]+)(?P<body>.*?)(?=(?:gemini-[a-z0-9.\-]+|##\s+Gemma|$))",
        flags=re.IGNORECASE | re.DOTALL,
    )

    results: list[PricingConfig] = []
    matches = list(primary_pattern.finditer(cleaned))
    if not matches:
        matches = list(fallback_pattern.finditer(cleaned))

    for match in matches:
        model_name = str(match.group("model") or "").strip().lower()
        body = str(match.group("body") or "")
        if not model_name:
            continue

        standard = re.search(
            r"###\s*Standard(?P<section>.*?)(?:###\s*Batch|##\s+Gemini|##\s+Gemma|$)",
            body,
            flags=re.IGNORECASE | re.DOTALL,
        )
        target = standard.group("section") if standard else body

        input_per_million = _extract_first_dollar_amount(target, "Input price")
        output_per_million = _extract_first_dollar_amount(target, "Output price")
        if input_per_million == 0.0 and output_per_million == 0.0:
            continue

        results.append(
            PricingConfig(
                provider="google",
                model_name=model_name,
                input_per_million=round(max(input_per_million, 0.0), 8),
                output_per_million=round(max(output_per_million, 0.0), 8),
                active=True,
                notes="Synced from Gemini API pricing documentation",
            )
        )
    return _dedupe_configs(results, max_models=max_models)


def _fetch_openai_pricing(
    *,
    timeout_seconds: int,
    max_models: int,
) -> list[PricingConfig]:
    text = _fetch_first_available_text(_OPENAI_PRICING_URLS, timeout_seconds=timeout_seconds)
    rows = _parse_openai_pricing(text, max_models=max_models)
    if not rows:
        raise ProviderPricingSyncError("OpenAI pricing sync succeeded but no model pricing rows were parsed.")
    return rows


def _fetch_anthropic_pricing(
    *,
    timeout_seconds: int,
    max_models: int,
) -> list[PricingConfig]:
    text = _fetch_first_available_text(_ANTHROPIC_PRICING_URLS, timeout_seconds=timeout_seconds)
    rows = _parse_anthropic_pricing(text, max_models=max_models)
    if not rows:
        raise ProviderPricingSyncError("Anthropic pricing sync succeeded but no model pricing rows were parsed.")
    return rows


def _fetch_google_pricing(
    *,
    timeout_seconds: int,
    max_models: int,
) -> list[PricingConfig]:
    text = _fetch_first_available_text(_GOOGLE_PRICING_URLS, timeout_seconds=timeout_seconds)
    rows = _parse_google_pricing(text, max_models=max_models)
    if not rows:
        raise ProviderPricingSyncError("Gemini pricing sync succeeded but no model pricing rows were parsed.")
    return rows


def fetch_provider_pricing(
    settings: Settings,
    *,
    provider: str,
    timeout_seconds: int = 15,
    max_models: int = 300,
) -> list[PricingConfig]:
    """Fetch provider pricing as PricingConfig rows.

    Sources:
    - OpenRouter: `/models` API response.
    - OpenAI: provider pricing documentation.
    - Anthropic: provider pricing documentation.
    - Google Gemini: provider pricing documentation.
    - Google Vertex AI: same pricing as Gemini.
    """
    normalized = _normalize_provider(provider)
    effective_max_models = max(1, int(max_models))
    effective_timeout = max(1, int(timeout_seconds))

    if normalized == "openrouter":
        return _fetch_openrouter_pricing(
            settings,
            timeout_seconds=effective_timeout,
            max_models=effective_max_models,
        )
    if normalized == "openai":
        return _fetch_openai_pricing(
            timeout_seconds=effective_timeout,
            max_models=effective_max_models,
        )
    if normalized == "anthropic":
        return _fetch_anthropic_pricing(
            timeout_seconds=effective_timeout,
            max_models=effective_max_models,
        )
    if normalized in {"google", "google_vertex", "google-vertex"}:
        return _fetch_google_pricing(
            timeout_seconds=effective_timeout,
            max_models=effective_max_models,
        )
    if normalized == "nvidia":
        raise NotImplementedError(
            "Provider pricing sync for NVIDIA NIM is not yet supported. Pricing must be configured manually."
        )

    raise NotImplementedError(
        "Provider pricing sync supports: google, google-vertex, openai, anthropic, openrouter "
        f"(got '{normalized or 'unknown'}')."
    )
