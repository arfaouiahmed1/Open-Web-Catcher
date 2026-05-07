"""Pipeline routing tests for the LangGraph orchestrator."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import ClassificationResult, ExtractionResult, MatchInfo, StreamURL


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


def test_route_after_classification_unknown_stops_page_agent_routing():
    from src.agents.orchestrator import route_after_classification

    route = route_after_classification(
        {
            "url": "https://example.com",
            "run_id": "run",
            "classification": _make_classification(PageType.UNKNOWN),
            "matches": [],
            "extraction_results": [],
            "pending_hosting_urls": [],
            "pending_embedded_urls": [],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        }
    )

    assert route == "analyze_providers"


def test_route_after_hosting_prioritizes_embedded_on_failed_hosting():
    from src.agents.orchestrator import route_after_hosting

    failed_hosting = ExtractionResult(
        url="https://hosting.example.com/watch/1",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.FAILED,
        agent_type=AgentType.HOSTING_PAGE,
    )
    route = route_after_hosting(
        {
            "url": "https://example.com",
            "run_id": "run",
            "classification": _make_classification(PageType.LANDING),
            "matches": [],
            "extraction_results": [failed_hosting],
            "pending_hosting_urls": ["https://hosting.example.com/watch/2"],
            "pending_embedded_urls": ["https://embed.example.com/player/1"],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        }
    )

    assert route == "embedded_page"


def test_route_after_hosting_keeps_hosting_when_latest_is_successful():
    from src.agents.orchestrator import route_after_hosting

    successful_hosting = ExtractionResult(
        url="https://hosting.example.com/watch/1",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        streams=[StreamURL(url="https://cdn.example.com/master.m3u8", protocol="hls")],
    )
    route = route_after_hosting(
        {
            "url": "https://example.com",
            "run_id": "run",
            "classification": _make_classification(PageType.LANDING),
            "matches": [],
            "extraction_results": [successful_hosting],
            "pending_hosting_urls": ["https://hosting.example.com/watch/2"],
            "pending_embedded_urls": ["https://embed.example.com/player/1"],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        }
    )

    assert route == "hosting_page"


@pytest.mark.asyncio
@patch("src.agents.landing_page.LandingPageAgent.run", new_callable=AsyncMock)
async def test_landing_node_routes_same_site_watch_page_to_hosting_only(mock_landing_run, settings):
    from src.agents.orchestrator import landing_page_node

    mock_landing_run.return_value = ExtractionResult(
        url="https://example.com",
        page_type=PageType.LANDING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.LANDING_PAGE,
        metadata={
            "hosting_pages": [
                {
                    "url": "https://example.com/watch/match-1",
                    "title": "Match 1",
                    "route": "embed_agent",
                    "iframes": ["https://embed.example.com/player/1"],
                    "entry_point": "https://example.com",
                }
            ]
        },
    )

    state = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.LANDING),
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
    }

    result = await landing_page_node(state, settings=settings, observer=None, memory=None)

    assert result["pending_hosting_urls"] == ["https://example.com/watch/match-1"]
    assert result["pending_embedded_urls"] == []
    assert result["matches"][0].route == "stream_extractor"


@pytest.mark.asyncio
@patch("src.agents.landing_page.LandingPageAgent.run", new_callable=AsyncMock)
async def test_landing_node_routes_direct_embed_url_to_embedded_only(mock_landing_run, settings):
    from src.agents.orchestrator import landing_page_node

    mock_landing_run.return_value = ExtractionResult(
        url="https://example.com",
        page_type=PageType.LANDING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.LANDING_PAGE,
        metadata={
            "hosting_pages": [
                {
                    "url": "https://streamtape.example/e/abc123",
                    "title": "Direct player",
                    "route": "embed_agent",
                    "entry_point": "https://example.com",
                }
            ]
        },
    )

    state = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.LANDING),
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
    }

    result = await landing_page_node(state, settings=settings, observer=None, memory=None)

    assert result["pending_hosting_urls"] == []
    assert result["pending_embedded_urls"] == ["https://streamtape.example/e/abc123"]
    assert result["matches"][0].route == "embed_agent"


@pytest.mark.asyncio
@patch("src.agents.landing_page.LandingPageAgent.run", new_callable=AsyncMock)
async def test_landing_node_does_not_fallback_to_root_hosting_when_no_matches(mock_landing_run, settings):
    from src.agents.orchestrator import landing_page_node

    mock_landing_run.return_value = ExtractionResult(
        url="https://example.com",
        page_type=PageType.LANDING,
        status=ExtractionStatus.FAILED,
        agent_type=AgentType.LANDING_PAGE,
        metadata={"hosting_pages": []},
    )

    state = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.LANDING),
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
    }

    result = await landing_page_node(state, settings=settings, observer=None, memory=None)

    assert result["matches"] == []
    assert result["pending_hosting_urls"] == []
    assert result["pending_embedded_urls"] == []


def test_landing_no_matches_is_partial_pipeline_result():
    from src.agents.orchestrator import _build_pipeline_result

    result = _build_pipeline_result(
        {
            "url": "https://example.com",
            "run_id": "test-run",
            "classification": _make_classification(PageType.LANDING),
            "matches": [],
            "extraction_results": [],
            "pending_hosting_urls": [],
            "pending_embedded_urls": [],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        }
    )

    assert result.final_status == ExtractionStatus.PARTIAL


@pytest.mark.asyncio
@patch("src.agents.hosting_page.HostingPageAgent.run", new_callable=AsyncMock)
async def test_hosting_node_sends_orchestrator_handoff(mock_hosting_run, settings):
    from src.agents.orchestrator import hosting_page_node

    mock_hosting_run.return_value = ExtractionResult(
        url="https://hosting.example.com/watch/1",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.FAILED,
        agent_type=AgentType.HOSTING_PAGE,
        metadata={"decision": "needs_embed_agent"},
    )

    state = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.LANDING),
        "matches": [
            MatchInfo(
                url="https://hosting.example.com/watch/1",
                title="Match A",
                route="embed_agent",
                iframes=["https://embed.example.com/player/1"],
            )
        ],
        "extraction_results": [],
        "pending_hosting_urls": ["https://hosting.example.com/watch/1"],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
    }

    await hosting_page_node(state, settings=settings, observer=None, memory=None)

    handoff = mock_hosting_run.await_args.kwargs.get("orchestrator_handoff", "")
    assert "ORCHESTRATOR HANDOFF" in handoff
    assert "target hosting candidate: https://hosting.example.com/watch/1" in handoff
    assert "recovery url: https://hosting.example.com/watch/1" in handoff
    assert "navigation policy: same-content okay" in handoff
    assert "required evidence:" in handoff


@pytest.mark.asyncio
@patch("src.agents.hosting_page.HostingPageAgent.run", new_callable=AsyncMock)
async def test_hosting_node_does_not_fabricate_embedded_target_when_missing_url(mock_hosting_run, settings):
    from src.agents.orchestrator import hosting_page_node

    mock_hosting_run.return_value = ExtractionResult(
        url="https://hosting.example.com/watch/1",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.PARTIAL,
        agent_type=AgentType.HOSTING_PAGE,
        metadata={"decision": "needs_embed_agent", "servers": []},
    )

    state = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.LANDING),
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": ["https://hosting.example.com/watch/1"],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
    }

    result = await hosting_page_node(state, settings=settings, observer=None, memory=None)

    assert result["pending_embedded_urls"] == []
    assert result["extraction_results"][0].url == "https://hosting.example.com/watch/1"
    assert result["extraction_results"][0].metadata["decision"] == "needs_embed_agent"


@pytest.mark.asyncio
@patch("src.agents.orchestrator.IPInfoTool._arun", new_callable=AsyncMock)
async def test_analyze_providers_node_skips_lookup_when_no_streams(mock_ipinfo, settings):
    from src.agents.orchestrator import analyze_providers_node

    state = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.UNKNOWN),
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
    }

    result = await analyze_providers_node(state, settings=settings)

    assert result == {"provider_analysis": []}
    mock_ipinfo.assert_not_awaited()


@pytest.mark.asyncio
@patch("src.agents.orchestrator.EmailTool._arun", new_callable=AsyncMock)
async def test_generate_takedown_emails_node_skips_generation_when_no_streams(mock_email):
    from src.agents.orchestrator import generate_takedown_emails_node

    state = {
        "url": "https://example.com",
        "run_id": "test-run",
        "classification": _make_classification(PageType.UNKNOWN),
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
    }

    result = await generate_takedown_emails_node(state)

    assert result == {"takedown_emails": []}
    mock_email.assert_not_awaited()
