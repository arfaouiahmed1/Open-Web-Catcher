from src.utils.config import Settings
from src.utils.provider_models import (
    build_model_selection_details,
    collect_model_config_warnings,
    get_provider_model_catalog,
    is_google_genai_model_id,
    normalize_agent_model_config,
    resolve_google_model_runtime_profile,
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


def test_saved_catalog_rows_keep_live_default_and_capability_provenance() -> None:
    settings = Settings()
    settings.google_api_key = ""
    settings.provider_model_catalog_cache = {
        "google": {
            "models": [
                {
                    "id": "gemma-4-31b-it",
                    "label": "Gemma 4 31B IT",
                    "default_parameters": {"temperature": 0.7, "top_p": 0.95},
                    "default_parameter_provenance": {
                        "temperature": "Live from Google",
                        "top_p": "Live from Google",
                    },
                    "capabilities": {
                        "supports_generate_content": True,
                        "supports_explicit_cache": False,
                        "supports_thinking_controls": False,
                    },
                    "capability_provenance": {
                        "supports_generate_content": "Live from Google",
                        "supports_explicit_cache": "Live from Google",
                        "supports_thinking_controls": "Heuristic",
                    },
                }
            ]
        }
    }

    payload = get_provider_model_catalog(settings, provider="google", max_models=20)
    row = payload["models"][0]

    assert row["default_parameter_provenance"]["temperature"] == "Live from Google"
    assert row["capability_provenance"]["supports_thinking_controls"] == "Heuristic"
    assert row["compatibility"]["thinking_controls"] == "unsupported"


def test_runtime_profile_uses_saved_catalog_for_gemma_compatibility() -> None:
    settings = Settings()
    settings.google_api_key = ""
    settings.provider_model_catalog_cache = {
        "google": {
            "models": [
                {
                    "id": "gemma-4-31b-it",
                    "capabilities": {
                        "supports_generate_content": True,
                        "supports_explicit_cache": False,
                        "supports_thinking_controls": False,
                        "allowed_tuning_keys": [
                            "temperature",
                            "top_p",
                            "top_k",
                            "max_output_tokens",
                        ],
                    },
                    "compatibility": {
                        "thinking_controls": "unsupported",
                        "explicit_cache": "unsupported",
                        "allowed_tuning_keys": [
                            "temperature",
                            "top_p",
                            "top_k",
                            "max_output_tokens",
                        ],
                    },
                }
            ]
        }
    }

    profile = resolve_google_model_runtime_profile(settings, model_id="gemma-4-31b-it")

    assert profile["resolved_from_catalog"] is True
    assert profile["supports_thinking_controls"] is False
    assert "max_output_tokens" in profile["allowed_tuning_keys"]


def test_model_selection_details_and_warnings_report_runtime_adjustments() -> None:
    settings = Settings()
    settings.google_api_key = ""
    settings.agent_model = "gemma-4-31b-it"
    settings.orchestrator_model = "gemma-4-31b-it"
    settings.agent_model_config = {
        "classification": {"provider": "google", "model": "gemma-4-31b-it"},
        "orchestrator": {"provider": "google", "model": "gemma-4-31b-it"},
    }
    settings.thinking_enabled = True
    settings.gemini_explicit_cache_enabled = True
    settings.provider_model_catalog_cache = {
        "google": {
            "models": [
                {
                    "id": "gemma-4-31b-it",
                    "label": "Gemma 4 31B IT",
                    "capabilities": {
                        "supports_generate_content": True,
                        "supports_explicit_cache": False,
                        "supports_thinking_controls": False,
                        "allowed_tuning_keys": [
                            "temperature",
                            "top_p",
                            "top_k",
                            "max_output_tokens",
                        ],
                    },
                    "compatibility": {
                        "thinking_controls": "unsupported",
                        "explicit_cache": "unsupported",
                        "allowed_tuning_keys": [
                            "temperature",
                            "top_p",
                            "top_k",
                            "max_output_tokens",
                        ],
                    },
                    "capability_provenance": {
                        "supports_thinking_controls": "Heuristic",
                        "supports_explicit_cache": "Live from Google",
                    },
                }
            ]
        }
    }

    warnings = collect_model_config_warnings(settings)
    details = build_model_selection_details(settings)

    assert any(item["type"] == "thinking_disabled_for_model" for item in warnings)
    assert any(
        item["type"] == "explicit_cache_unavailable_for_model" for item in warnings
    )
    assert details["classification"]["catalog_status"] == "verified"
    assert details["classification"]["warnings"]
