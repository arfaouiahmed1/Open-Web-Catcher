"""Provider model catalog helpers."""

from __future__ import annotations

from src.utils.config import Settings
from src.utils.provider_models import get_provider_model_catalog, resolve_model_context_window


def test_resolve_model_context_window_covers_gemini_defaults():
    assert resolve_model_context_window("gemini-2.5-flash", "google") == 1_048_576
    assert resolve_model_context_window("google/gemini-2.5-flash", "openrouter") == 1_048_576


def test_resolve_model_context_window_covers_openrouter_prefixed_models():
    assert resolve_model_context_window("openai/gpt-5", "openrouter") == 1_047_576
    assert resolve_model_context_window("anthropic/claude-sonnet-4", "openrouter") == 200_000


def test_get_provider_model_catalog_reports_unavailable_without_hardcoded_fallback_models():
    payload = get_provider_model_catalog(Settings(), provider="openai")

    assert payload["provider"] == "openai"
    assert payload["available"] is False
    assert payload["source"] == "unavailable"
    assert payload["models"] == []
    assert "OPENAI_API_KEY" in payload["error"]
