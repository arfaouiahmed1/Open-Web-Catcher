from src.utils.config import Settings
from src.utils.provider_models import (
    get_provider_model_catalog,
    is_google_genai_model_id,
    normalize_agent_model_config,
)


def test_saved_catalog_is_used_before_static_fallback_when_key_missing() -> None:
    settings = Settings()
    settings.google_api_key = ""
    settings.provider_model_catalog_cache = {
        "google": {
            "models": [
                {
                    "id": "gemma-4-31b-it",
                    "label": "Gemma 4 31B IT",
                    "default_parameters": {"temperature": 0.7},
                }
            ]
        }
    }

    payload = get_provider_model_catalog(settings, provider="google", max_models=20)

    assert payload["source"] == "saved_catalog"
    assert payload["defaults_source"] == "saved_catalog"
    assert payload["models"][0]["id"] == "gemma-4-31b-it"
    assert payload["models"][0]["default_parameters"]["temperature"] == 0.7


def test_static_fallback_is_used_when_no_saved_catalog_and_key_missing() -> None:
    settings = Settings()
    settings.google_api_key = ""
    settings.provider_model_catalog_cache = {}

    payload = get_provider_model_catalog(settings, provider="google", max_models=20)

    assert payload["source"] == "fallback_catalog"
    assert payload["defaults_source"] == "fallback_catalog"
    assert payload["models"]


def test_google_runtime_model_ids_include_gemma_and_gemini() -> None:
    assert is_google_genai_model_id("gemini-2.5-flash")
    assert is_google_genai_model_id("gemma-4-31b-it")
    assert is_google_genai_model_id("google/gemini-2.5-pro")
    assert is_google_genai_model_id("google/gemma-3-27b-it")
    assert not is_google_genai_model_id("gpt-5")


def test_agent_model_config_normalizes_legacy_non_google_provider() -> None:
    settings = Settings()
    settings.llm_provider = "google"
    settings.agent_model = "gemma-4-31b-it"
    settings.orchestrator_model = "gemini-2.5-pro"
    raw = {
        "classification": {"provider": "openai", "model": "gemma-4-31b-it"},
        "orchestrator": {"provider": "gemini", "model": "gemini-2.5-pro"},
    }

    normalized = normalize_agent_model_config(settings, raw)

    assert normalized["classification"]["provider"] == "google"
    assert normalized["orchestrator"]["provider"] == "google"
