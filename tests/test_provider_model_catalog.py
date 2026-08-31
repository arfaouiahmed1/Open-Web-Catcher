from src.api.provider_config import ui_config_payload
from src.utils import provider_models
from src.utils.config import Settings
from src.utils.provider_models import (
    SUPPORTED_PROVIDERS,
    build_model_selection_details,
    collect_model_config_warnings,
    get_provider_model_catalog,
    is_google_genai_model_id,
    normalize_agent_model_config,
    provider_base_url,
    provider_api_key,
    resolve_google_model_runtime_profile,
    resolve_model_context_window,
)
from src.llm.provider import normalize_model_name


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


def test_gemini_31_flash_lite_reports_context_window_from_fallbacks() -> None:
    settings = Settings()
    settings.google_api_key = ""
    settings.provider_model_catalog_cache = {}

    payload = get_provider_model_catalog(settings, provider="google", max_models=20)
    row = next(item for item in payload["models"] if item["id"] == "gemini-3.1-flash-lite")

    assert row["context_window"] == 1_048_576
    assert resolve_model_context_window("gemini-3.1-flash-lite", "google_genai") == 1_048_576
    assert resolve_model_context_window("google/gemini-3.1-flash-lite", "google") == 1_048_576
    assert resolve_model_context_window("gemini-3.1-flash-lite-preview", "google_genai") == 1_048_576


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

    assert normalized["classification"]["provider"] == "openai"
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


def test_litellm_directory_includes_opencode_and_local_gateways() -> None:
    assert {"opencode", "opencode-go", "litellm", "ollama", "custom-openai"}.issubset(
        SUPPORTED_PROVIDERS
    )


def test_dynamic_provider_credentials_and_endpoint_are_settings_owned() -> None:
    settings = Settings(
        provider_api_keys={"opencode": "[REDACTED]"},
        provider_base_urls={"custom-openai": "http://gateway.test/v1"},
    )

    assert provider_base_url(settings, "opencode") == "https://opencode.ai/zen/v1"
    assert provider_base_url(settings, "opencode-go") == "https://opencode.ai/zen/go/v1"
    assert provider_base_url(settings, "custom-openai") == "http://gateway.test/v1"
    assert provider_api_key(settings, "opencode") == "[REDACTED]"


def test_openai_compatible_catalog_uses_registry_endpoint(monkeypatch) -> None:
    calls: dict[str, object] = {}

    def fake_request(url, *, headers=None, timeout_seconds=None, provider=None, **kwargs):
        calls.update(url=url, headers=headers, provider=provider)
        return {"data": [{"id": "deepseek-v4-pro"}, {"id": "deepseek-v4-flash"}]}

    monkeypatch.setattr(provider_models, "_request_json", fake_request)
    settings = Settings(provider_api_keys={"opencode": "[REDACTED]"})

    payload = get_provider_model_catalog(settings, provider="opencode", max_models=20)

    assert payload["source"] == "provider_api"
    assert [row["id"] for row in payload["models"]] == ["deepseek-v4-flash", "deepseek-v4-pro"]
    assert calls["url"] == "https://opencode.ai/zen/v1/models"
    assert calls["provider"] == "opencode"


def test_dynamic_provider_status_is_exposed_without_exposing_credentials() -> None:
    settings = Settings(provider_api_keys={"opencode": "[REDACTED]"})

    payload = ui_config_payload(settings)

    assert payload["api_keys"]["opencode"] is True
    assert "provider_api_keys" not in payload
    assert "[REDACTED]" not in str(payload)


def test_openai_compatible_provider_uses_openai_litellm_route() -> None:
    assert normalize_model_name("opencode/gpt-5.6-luna", "opencode") == "openai/gpt-5.6-luna"
    assert normalize_model_name("claude-opus-4-6", "opencode") == "anthropic/claude-opus-4-6"
    assert normalize_model_name("gemini-3.7-flash", "opencode") == "gemini/gemini-3.7-flash"
    assert normalize_model_name("qwen2.5-coder", "custom-openai") == "openai/qwen2.5-coder"
