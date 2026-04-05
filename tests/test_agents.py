"""Integration tests per agent (LLM and browser are mocked)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from src.models.enums import Confidence, ExtractionStatus, PageType
from src.models.schemas import ClassificationResult
from src.utils.config import Settings


@pytest.fixture
def settings():
    return Settings(
        google_api_key="test-key",
        browser_ws_endpoint="ws://localhost:9222",
        database_url="sqlite:///:memory:",
    )


@patch("src.agents.classification.ChatGoogleGenerativeAI")
def test_classification_agent_returns_result(mock_llm_cls, settings):
    from src.agents.classification import ClassificationAgent

    mock_response = MagicMock()
    mock_response.content = '{"url": "https://x.com", "page_type": "hosting_page", "confidence": "high", "reasoning": "Has video player."}'
    mock_llm = MagicMock()
    mock_llm.bind_tools.return_value.invoke.return_value = mock_response
    mock_llm_cls.return_value = mock_llm

    agent = ClassificationAgent(settings)
    result = agent.run(url="https://x.com")

    assert isinstance(result, ClassificationResult)
    assert result.url == "https://x.com"


@patch("src.agents.landing_page.AgentExecutor")
@patch("src.agents.landing_page.create_react_agent")
@patch("src.agents.landing_page.ChatGoogleGenerativeAI")
def test_landing_page_agent_success(mock_llm_cls, mock_create, mock_executor_cls, settings):
    from src.agents.landing_page import LandingPageAgent

    mock_executor = MagicMock()
    mock_executor.invoke.return_value = {"output": "https://hosting.example.com/video/1"}
    mock_executor_cls.return_value = mock_executor

    agent = LandingPageAgent(settings)
    result = agent.run(url="https://example-streaming.com")

    assert result.page_type == PageType.LANDING
    assert result.status == ExtractionStatus.SUCCESS


@patch("src.agents.hosting_page.AgentExecutor")
@patch("src.agents.hosting_page.create_react_agent")
@patch("src.agents.hosting_page.ChatGoogleGenerativeAI")
def test_hosting_page_agent_success(mock_llm_cls, mock_create, mock_executor_cls, settings):
    from src.agents.hosting_page import HostingPageAgent

    mock_executor = MagicMock()
    mock_executor.invoke.return_value = {
        "output": '["https://cdn.example.com/stream.m3u8"]',
        "streams": [{"url": "https://cdn.example.com/stream.m3u8", "protocol": "hls"}],
    }
    mock_executor_cls.return_value = mock_executor

    agent = HostingPageAgent(settings)
    result = agent.run(url="https://hosting.example.com/video/1")

    assert result.page_type == PageType.HOSTING
    assert result.status == ExtractionStatus.SUCCESS
    assert len(result.streams) == 1


@patch("src.agents.hosting_page.AgentExecutor")
@patch("src.agents.hosting_page.create_react_agent")
@patch("src.agents.hosting_page.ChatGoogleGenerativeAI")
def test_hosting_page_agent_failure(mock_llm_cls, mock_create, mock_executor_cls, settings):
    from src.agents.hosting_page import HostingPageAgent

    mock_executor = MagicMock()
    mock_executor.invoke.side_effect = RuntimeError("Browser disconnected")
    mock_executor_cls.return_value = mock_executor

    agent = HostingPageAgent(settings)
    result = agent.run(url="https://hosting.example.com/video/1")

    assert result.status == ExtractionStatus.FAILED
    assert "Browser disconnected" in result.error_message
