"""Pipeline routing tests."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from src.models.enums import Confidence, ExtractionStatus, PageType
from src.models.schemas import ClassificationResult, ExtractionResult
from src.utils.config import Settings


@pytest.fixture
def settings():
    return Settings(
        google_api_key="test-key",
        browser_ws_endpoint="ws://localhost:9222",
        database_url="sqlite:///:memory:",
    )


def _make_classification(page_type: PageType) -> ClassificationResult:
    return ClassificationResult(
        url="https://example.com",
        page_type=page_type,
        confidence=Confidence.HIGH,
        reasoning="Test",
    )


def _make_extraction(page_type: PageType, status: ExtractionStatus = ExtractionStatus.SUCCESS):
    from src.models.enums import AgentType
    mapping = {
        PageType.LANDING: AgentType.LANDING_PAGE,
        PageType.HOSTING: AgentType.HOSTING_PAGE,
        PageType.EMBEDDED: AgentType.EMBEDDED_PAGE,
    }
    return ExtractionResult(
        url="https://example.com",
        page_type=page_type,
        status=status,
        agent_type=mapping[page_type],
    )


@patch("src.agents.orchestrator.classify_node")
@patch("src.agents.orchestrator.hosting_page_node")
def test_routing_to_hosting_page(mock_hosting, mock_classify, settings):
    """ClassificationResult with HOSTING type should route to hosting_page_node."""
    from src.agents.orchestrator import build_graph

    mock_classify.return_value = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.HOSTING),
        "extraction": None,
        "error": "",
    }
    mock_hosting.return_value = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.HOSTING),
        "extraction": _make_extraction(PageType.HOSTING),
        "error": "",
    }

    graph = build_graph(settings)
    result = graph.invoke({
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": None,
        "extraction": None,
        "error": "",
    })

    assert mock_hosting.called


@patch("src.agents.orchestrator.classify_node")
@patch("src.agents.orchestrator.landing_page_node")
def test_routing_to_landing_page(mock_landing, mock_classify, settings):
    mock_classify.return_value = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.LANDING),
        "extraction": None,
        "error": "",
    }
    mock_landing.return_value = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.LANDING),
        "extraction": _make_extraction(PageType.LANDING),
        "error": "",
    }

    graph = build_graph(settings)
    graph.invoke({
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": None,
        "extraction": None,
        "error": "",
    })

    assert mock_landing.called
