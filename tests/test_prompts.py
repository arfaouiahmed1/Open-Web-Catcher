"""Prompt regression tests — local golden test cases (no LangSmith required)."""

from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from src.evaluation.datasets import load_test_cases
from src.models.enums import Confidence, PageType
from src.utils.config import Settings

CASES_PATH = Path("data/test_cases/sites.json")


@pytest.fixture
def settings():
    return Settings(
        google_api_key="test-key",
        browser_ws_endpoint="ws://localhost:9222",
        database_url="sqlite:///:memory:",
    )


def test_load_test_cases_missing_file():
    """load_test_cases should return empty list when file does not exist."""
    cases = load_test_cases("data/test_cases/nonexistent.json")
    assert cases == []


def test_load_test_cases_valid(tmp_path):
    cases_file = tmp_path / "sites.json"
    cases_file.write_text(json.dumps([
        {"url": "https://example.com", "expected_type": "landing_page"}
    ]))
    cases = load_test_cases(cases_file)
    assert len(cases) == 1
    assert cases[0]["expected_type"] == "landing_page"


@pytest.mark.skipif(not CASES_PATH.exists(), reason="No golden test cases file found")
@patch("src.agents.classification.ChatGoogleGenerativeAI")
def test_classification_golden_cases(mock_llm_cls, settings):
    """Run classification on each golden case and check page_type matches expected."""
    from src.agents.classification import ClassificationAgent

    cases = load_test_cases(CASES_PATH)
    if not cases:
        pytest.skip("No test cases to run")

    for case in cases:
        expected = case.get("expected_type", "unknown")
        mock_response = MagicMock()
        mock_response.content = json.dumps({
            "url": case["url"],
            "page_type": expected,
            "confidence": "high",
            "reasoning": "mocked",
        })
        mock_llm = MagicMock()
        mock_llm.bind_tools.return_value.invoke.return_value = mock_response
        mock_llm_cls.return_value = mock_llm

        agent = ClassificationAgent(settings)
        result = agent.run(url=case["url"])
        assert result.page_type == expected, f"Failed for {case['url']}: got {result.page_type}"
