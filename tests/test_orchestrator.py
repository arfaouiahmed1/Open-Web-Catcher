"""Pipeline routing tests for the LangGraph orchestrator."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from src.models.enums import Confidence, ExtractionStatus, PageType
from src.models.schemas import ClassificationResult, ExtractionResult


def _make_classification(page_type: PageType) -> ClassificationResult:
    return ClassificationResult(
        url="https://example.com",
        page_type=page_type,
        confidence=Confidence.HIGH,
        reasoning="Test",
    )


def _make_extraction(page_type: PageType, status: ExtractionStatus = ExtractionStatus.SUCCESS) -> ExtractionResult:
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


@pytest.mark.asyncio
@patch("src.agents.orchestrator.generate_takedown_emails_node", new_callable=AsyncMock)
@patch("src.agents.orchestrator.analyze_providers_node", new_callable=AsyncMock)
@patch("src.agents.orchestrator.hosting_page_node", new_callable=AsyncMock)
@patch("src.agents.orchestrator.classify_node", new_callable=AsyncMock)
async def test_routing_to_hosting_page(mock_classify, mock_hosting, mock_analyze, mock_email, settings):
    from src.agents.orchestrator import build_graph

    mock_classify.return_value = {
        "classification": _make_classification(PageType.HOSTING),
        "error": "",
    }
    mock_hosting.return_value = {
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "extraction_results": [_make_extraction(PageType.HOSTING)],
    }
    mock_analyze.return_value = {"provider_analysis": []}
    mock_email.return_value = {"takedown_emails": []}

    graph = build_graph(settings)
    result = await graph.ainvoke({
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": None,
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
    })

    assert mock_hosting.await_count == 1
    assert result["classification"].page_type == PageType.HOSTING


@pytest.mark.asyncio
@patch("src.agents.orchestrator.generate_takedown_emails_node", new_callable=AsyncMock)
@patch("src.agents.orchestrator.analyze_providers_node", new_callable=AsyncMock)
@patch("src.agents.orchestrator.hosting_page_node", new_callable=AsyncMock)
@patch("src.agents.orchestrator.landing_page_node", new_callable=AsyncMock)
@patch("src.agents.orchestrator.classify_node", new_callable=AsyncMock)
async def test_routing_to_landing_page(mock_classify, mock_landing, mock_hosting, mock_analyze, mock_email, settings):
    from src.agents.orchestrator import build_graph

    mock_classify.return_value = {
        "classification": _make_classification(PageType.LANDING),
        "error": "",
    }
    mock_landing.return_value = {
        "matches": [],
        "pending_hosting_urls": [],
        "extraction_results": [_make_extraction(PageType.LANDING)],
    }
    mock_hosting.return_value = {
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "extraction_results": [_make_extraction(PageType.HOSTING)],
    }
    mock_analyze.return_value = {"provider_analysis": []}
    mock_email.return_value = {"takedown_emails": []}

    graph = build_graph(settings)
    await graph.ainvoke({
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": None,
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
    })

    assert mock_landing.await_count == 1
    assert mock_hosting.await_count == 0
