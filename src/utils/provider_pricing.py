"""Provider pricing sync helpers.

This module fetches model pricing from provider APIs when available and converts
it to the local per-million-token schema used by the observability layer.
"""

from __future__ import annotations

from typing import Any

import httpx

from src.models.schemas import PricingConfig
from src.utils.config import Settings


class ProviderPricingSyncError(RuntimeError):
    """Raised when provider pricing sync fails."""


def _to_per_million(value: Any) -> float:
    """Convert provider per-token pricing into per-million-token pricing."""
    try:
        per_token = float(value)
    except (TypeError, ValueError):
        return 0.0
    return round(max(per_token, 0.0) * 1_000_000.0, 8)


def _fetch_openrouter_pricing(
    settings: Settings,
    *,
    timeout_seconds: int,
    max_models: int,
) -> list[PricingConfig]:
    api_key = (settings.openrouter_api_key or "").strip()
    if not api_key:
        raise ProviderPricingSyncError("OPENROUTER_API_KEY is missing; cannot sync provider pricing.")

    url = f"{settings.openrouter_base_url.rstrip('/')}/models"
    try:
        response = httpx.get(
            url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Accept": "application/json",
            },
            timeout=max(1, int(timeout_seconds)),
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
        model_name = str(row.get("id") or "").strip()
        if not model_name:
            continue

        pricing = row.get("pricing", {})
        if not isinstance(pricing, dict):
            continue

        input_per_million = _to_per_million(pricing.get("prompt"))
        output_per_million = _to_per_million(pricing.get("completion"))

        if input_per_million == 0.0 and output_per_million == 0.0:
            continue

        results.append(
            PricingConfig(
                provider="openrouter",
                model_name=model_name,
                input_per_million=input_per_million,
                output_per_million=output_per_million,
                active=True,
                notes="Synced from OpenRouter /models API",
            )
        )
        if max_models > 0 and len(results) >= max_models:
            break

    results.sort(key=lambda item: item.model_name.lower())
    return results


def fetch_provider_pricing(
    settings: Settings,
    *,
    provider: str,
    timeout_seconds: int = 15,
    max_models: int = 300,
) -> list[PricingConfig]:
    """Fetch provider pricing as PricingConfig rows.

    Pricing APIs are provider-specific. OpenRouter exposes model pricing via API;
    other providers may not expose stable pricing APIs in this runtime context.
    """
    normalized = (provider or "").strip().lower()
    if normalized == "openrouter":
        return _fetch_openrouter_pricing(
            settings,
            timeout_seconds=timeout_seconds,
            max_models=max_models,
        )

    raise NotImplementedError(
        f"Provider pricing sync is currently supported for 'openrouter' only (got '{normalized or 'unknown'}')."
    )
