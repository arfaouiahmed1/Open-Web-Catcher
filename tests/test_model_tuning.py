"""Tests for provider-aware LLM tuning."""

from __future__ import annotations

from unittest.mock import patch

from src.utils.config import Settings


def test_build_llm_applies_openai_provider_and_model_tuning():
    from src.agents.base import build_llm

    settings = Settings(
        llm_provider="openai",
        openai_api_key="test-key",
        agent_model="gpt-5",
        llm_tuning={
            "provider_defaults": {
                "openai": {
                    "temperature": 0.2,
                    "top_p": 0.85,
                }
            },
            "model_overrides": {
                "openai::gpt-5": {
                    "max_tokens": 2048,
                    "reasoning_effort": "high",
                }
            },
        },
    )

    with patch("langchain_openai.ChatOpenAI", return_value="openai-llm") as mock_chat:
        llm = build_llm(settings)

    assert llm == "openai-llm"
    _, kwargs = mock_chat.call_args
    assert kwargs["model"] == "gpt-5"
    assert kwargs["temperature"] == 0.2
    assert kwargs["top_p"] == 0.85
    assert kwargs["max_tokens"] == 2048
    assert kwargs["reasoning_effort"] == "high"


def test_build_llm_applies_google_model_override():
    from src.agents.base import build_llm

    settings = Settings(
        llm_provider="google",
        google_api_key="test-key",
        agent_model="gemini-2.5-flash",
        llm_tuning={
            "provider_defaults": {
                "google": {
                    "temperature": 0.1,
                    "top_p": 0.9,
                }
            },
            "model_overrides": {
                "google::gemini-2.5-flash": {
                    "top_k": 32,
                    "max_output_tokens": 4096,
                }
            },
        },
    )

    with patch("src.agents.base.ChatGoogleGenerativeAI", return_value="google-llm") as mock_chat:
        llm = build_llm(settings)

    assert llm == "google-llm"
    _, kwargs = mock_chat.call_args
    assert kwargs["model"] == "gemini-2.5-flash"
    assert kwargs["temperature"] == 0.1
    assert kwargs["top_p"] == 0.9
    assert kwargs["top_k"] == 32
    assert kwargs["max_output_tokens"] == 4096
