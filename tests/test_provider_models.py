"""Provider model catalog helpers."""

from __future__ import annotations

from unittest.mock import patch

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


def test_get_provider_model_catalog_includes_live_gemini_defaults_and_capabilities():
    settings = Settings(google_api_key="test-key")
    api_payload = {
        "models": [
            {
                "name": "models/gemini-2.5-flash",
                "displayName": "Gemini 2.5 Flash",
                "description": "Flash model",
                "inputTokenLimit": 1048576,
                "outputTokenLimit": 65536,
                "temperature": 1,
                "topP": 0.95,
                "topK": 64,
                "supportedGenerationMethods": [
                    "generateContent",
                    "countTokens",
                    "createCachedContent",
                    "batchGenerateContent",
                ],
            }
        ]
    }

    with patch("src.utils.provider_models._request_json", return_value=api_payload):
        payload = get_provider_model_catalog(settings, provider="google", max_models=5)

    assert payload["provider"] == "google"
    assert payload["available"] is True
    assert payload["source"] == "provider_api"
    model = payload["models"][0]
    assert model["id"] == "gemini-2.5-flash"
    assert model["default_parameters"] == {
        "temperature": 1,
        "top_p": 0.95,
        "top_k": 64,
        "max_output_tokens": 65536,
    }
    assert model["supported_generation_methods"] == [
        "generateContent",
        "countTokens",
        "createCachedContent",
        "batchGenerateContent",
    ]
    assert model["capabilities"]["supports_explicit_cache"] is True
    assert model["capabilities"]["supports_thinking_controls"] is True
    assert model["release_channel"] == "stable"
