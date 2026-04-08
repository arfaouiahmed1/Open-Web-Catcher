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


def test_fetch_provider_pricing_unsupported_provider(settings: Settings):
    with pytest.raises(NotImplementedError):
        fetch_provider_pricing(settings, provider="google")


def test_fetch_openrouter_requires_api_key():
    settings = Settings(openrouter_api_key="")
    with pytest.raises(ProviderPricingSyncError):
        fetch_provider_pricing(settings, provider="openrouter")
