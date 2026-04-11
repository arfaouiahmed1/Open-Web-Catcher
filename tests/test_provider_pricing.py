from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from src.utils.config import Settings
from src.utils.provider_pricing import ProviderPricingSyncError, fetch_provider_pricing


@pytest.fixture
def settings() -> Settings:
    return Settings(
        openrouter_api_key="test-openrouter-key",
        openrouter_base_url="https://openrouter.ai/api/v1",
    )


def test_fetch_openrouter_pricing_parses_per_million(settings: Settings):
    payload = {
        "data": [
            {
                "id": "openai/gpt-4o-mini",
                "pricing": {
                    "prompt": "0.00000015",
                    "completion": "0.0000006",
                },
            },
            {
                "id": "google/gemini-2.5-flash",
                "pricing": {
                    "prompt": "0.00000010",
                    "completion": "0.00000040",
                },
            },
        ]
    }

    response = MagicMock()
    response.json.return_value = payload
    response.raise_for_status.return_value = None

    with patch("src.utils.provider_pricing.httpx.get", return_value=response) as mock_get:
        rows = fetch_provider_pricing(settings, provider="openrouter", timeout_seconds=10, max_models=10)

    assert len(rows) == 2
    assert rows[0].provider == "openrouter"
    # 0.00000015 per token -> 0.15 per million
    assert rows[0].input_per_million >= 0.0
    assert any(item.model_name == "openai/gpt-4o-mini" for item in rows)
    model = next(item for item in rows if item.model_name == "openai/gpt-4o-mini")
    assert model.input_per_million == pytest.approx(0.15)
    assert model.output_per_million == pytest.approx(0.6)
    assert mock_get.called


def test_fetch_openai_pricing_from_docs_page(settings: Settings):
    sample = """
    Standard
    Model Input Cached input Output
    gpt-4o-mini $0.15 $0.075 $0.60
    gpt-4o $2.50 $1.25 $10.00
    """
    response = MagicMock()
    response.text = sample
    response.raise_for_status.return_value = None

    with patch("src.utils.provider_pricing.httpx.get", return_value=response):
        rows = fetch_provider_pricing(settings, provider="openai", timeout_seconds=10, max_models=10)

    assert any(item.model_name == "gpt-4o-mini" for item in rows)
    model = next(item for item in rows if item.model_name == "gpt-4o-mini")
    assert model.input_per_million == pytest.approx(0.15)
    assert model.output_per_million == pytest.approx(0.60)


def test_fetch_anthropic_pricing_from_docs_page(settings: Settings):
    sample = """
    Claude Sonnet 4.6  $3 / MTok  $3.75 / MTok  $6 / MTok  $0.30 / MTok  $15 / MTok
    Claude Haiku 3.5   $0.80 / MTok  $1 / MTok  $1.6 / MTok  $0.08 / MTok  $4 / MTok
    """
    response = MagicMock()
    response.text = sample
    response.raise_for_status.return_value = None

    with patch("src.utils.provider_pricing.httpx.get", return_value=response):
        rows = fetch_provider_pricing(settings, provider="anthropic", timeout_seconds=10, max_models=10)

    assert any(item.model_name == "claude-sonnet-4-6" for item in rows)
    sonnet = next(item for item in rows if item.model_name == "claude-sonnet-4-6")
    assert sonnet.input_per_million == pytest.approx(3.0)
    assert sonnet.output_per_million == pytest.approx(15.0)


def test_fetch_google_pricing_from_docs_page(settings: Settings):
    sample = """
    `gemini-2.5-flash`
    ### Standard
    Free Tier Paid Tier, per 1M tokens in USD
    Input price Free of charge $0.30
    Output price (including thinking tokens) Free of charge $2.50
    ### Batch
    """
    response = MagicMock()
    response.text = sample
    response.raise_for_status.return_value = None

    with patch("src.utils.provider_pricing.httpx.get", return_value=response):
        rows = fetch_provider_pricing(settings, provider="google", timeout_seconds=10, max_models=10)

    assert any(item.model_name == "gemini-2.5-flash" for item in rows)
    model = next(item for item in rows if item.model_name == "gemini-2.5-flash")
    assert model.input_per_million == pytest.approx(0.30)
    assert model.output_per_million == pytest.approx(2.50)


def test_fetch_provider_pricing_unsupported_provider(settings: Settings):
    with pytest.raises(NotImplementedError):
        fetch_provider_pricing(settings, provider="mistral")


def test_fetch_openrouter_requires_api_key():
    settings = Settings(openrouter_api_key="")
    with pytest.raises(ProviderPricingSyncError):
        fetch_provider_pricing(settings, provider="openrouter")
