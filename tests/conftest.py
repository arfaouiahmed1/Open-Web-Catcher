"""Shared pytest fixtures: mock browser, mock tools, mock settings."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from src.models.enums import Confidence, ExtractionStatus, PageType
from src.models.schemas import ClassificationResult, ExtractionResult
from src.utils.config import Settings


@pytest.fixture
def settings() -> Settings:
    """Minimal settings for testing — no real API keys needed."""
    return Settings(
        google_api_key="test-key",
        browser_ws_endpoint="ws://localhost:9222",
        database_url="sqlite:///:memory:",
        memory_enabled=False,
        gemini_model="gemini-1.5-flash",
    )


@pytest.fixture
def mock_bridge():
    """JSToolBridge that returns canned responses without spawning Node.js."""
    with patch("src.tools.bridge.JSToolBridge.call") as mock:
        mock.return_value = {"success": True, "elements": [], "iframes": [], "title": "Test Page", "url": "https://example.com"}
        yield mock


@pytest.fixture
def sample_classification_result() -> ClassificationResult:
    return ClassificationResult(
        url="https://example-streaming.com/movie/123",
        page_type=PageType.HOSTING,
        confidence=Confidence.HIGH,
        reasoning="Page contains an embedded video player with HLS source.",
    )


@pytest.fixture
def sample_extraction_result() -> ExtractionResult:
    from src.models.schemas import StreamURL
    from src.models.enums import AgentType
    return ExtractionResult(
        url="https://example-streaming.com/movie/123",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        streams=[
            StreamURL(url="https://cdn.example.com/stream.m3u8", protocol="hls"),
        ],
    )
