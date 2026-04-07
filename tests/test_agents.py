"""Agent tests focused on the LangGraph runtime integration points."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.models.enums import ExtractionStatus, PageType


class DummyAsyncContext:
    def __init__(self, value):
        self.value = value

    async def __aenter__(self):
        return self.value

    async def __aexit__(self, exc_type, exc, tb):
        return False


class LoopResultStub:
    def __init__(self, final_text: str = "", tool_calls_made: int = 0, payload: dict | None = None):
        self.final_text = final_text
        self.tool_calls_made = tool_calls_made
        self.messages = []
        self._payload = payload or {}

    def parse_json(self) -> dict:
        return self._payload


@pytest.mark.asyncio
@patch("src.agents.classification.run_agent_loop", new_callable=AsyncMock)
@patch("src.agents.classification.agent_tools")
@patch("src.agents.classification.build_llm")
async def test_classification_agent_returns_result(mock_build_llm, mock_agent_tools, mock_run_agent_loop, settings):
    from src.agents.classification import ClassificationAgent

    mock_build_llm.return_value = MagicMock()
    mock_agent_tools.return_value = DummyAsyncContext([])
    mock_run_agent_loop.return_value = LoopResultStub(
        final_text='{"page_type":"hosting_page","confidence":"high","reasoning":"Has video player."}',
        tool_calls_made=1,
    )

    agent = ClassificationAgent(settings)
    result = await agent.run(url="https://x.com")

    assert result.url == "https://x.com"
    assert result.page_type == PageType.HOSTING


@pytest.mark.asyncio
@patch("src.agents.landing_page.run_agent_loop", new_callable=AsyncMock)
@patch("src.agents.landing_page.agent_tools")
@patch("src.agents.landing_page.build_llm")
async def test_landing_page_agent_success(mock_build_llm, mock_agent_tools, mock_run_agent_loop, settings):
    from src.agents.landing_page import LandingPageAgent

    mock_build_llm.return_value = MagicMock()
    mock_agent_tools.return_value = DummyAsyncContext([])
    mock_run_agent_loop.return_value = LoopResultStub(
        tool_calls_made=2,
        payload={"hosting_pages": [{"url": "https://hosting.example.com/video/1"}]},
    )

    agent = LandingPageAgent(settings)
    result = await agent.run(url="https://example-streaming.com")

    assert result.page_type == PageType.LANDING
    assert result.status == ExtractionStatus.SUCCESS
    assert result.metadata["hosting_pages"][0]["url"] == "https://hosting.example.com/video/1"


@pytest.mark.asyncio
@patch("src.agents.hosting_page.run_agent_loop", new_callable=AsyncMock)
@patch("src.agents.hosting_page.agent_tools")
@patch("src.agents.hosting_page.build_llm")
async def test_hosting_page_agent_success(mock_build_llm, mock_agent_tools, mock_run_agent_loop, settings):
    from src.agents.hosting_page import HostingPageAgent

    mock_build_llm.return_value = MagicMock()
    mock_agent_tools.return_value = DummyAsyncContext([])
    mock_run_agent_loop.return_value = LoopResultStub(
        tool_calls_made=3,
        payload={
            "streaming_urls": [{"url": "https://cdn.example.com/stream.m3u8", "type": "hls"}],
            "servers": [],
            "decision": "safe_exit",
        },
    )

    agent = HostingPageAgent(settings)
    result = await agent.run(url="https://hosting.example.com/video/1")

    assert result.page_type == PageType.HOSTING
    assert result.status == ExtractionStatus.SUCCESS
    assert len(result.streams) == 1


@pytest.mark.asyncio
@patch("src.agents.hosting_page.run_agent_loop", new_callable=AsyncMock)
@patch("src.agents.hosting_page.agent_tools")
@patch("src.agents.hosting_page.build_llm")
async def test_hosting_page_agent_partial_when_embed_needed(mock_build_llm, mock_agent_tools, mock_run_agent_loop, settings):
    from src.agents.hosting_page import HostingPageAgent

    mock_build_llm.return_value = MagicMock()
    mock_agent_tools.return_value = DummyAsyncContext([])
    mock_run_agent_loop.return_value = LoopResultStub(
        tool_calls_made=4,
        payload={
            "streaming_urls": [],
            "servers": [{"embedded_url": "https://embed.example.com/player"}],
            "decision": "needs_embed_agent",
        },
    )

    agent = HostingPageAgent(settings)
    result = await agent.run(url="https://hosting.example.com/video/1")

    assert result.status == ExtractionStatus.PARTIAL
    assert result.embedded_urls == ["https://embed.example.com/player"]


@pytest.mark.asyncio
@patch("src.agents.embedded_page.run_agent_loop", new_callable=AsyncMock)
@patch("src.agents.embedded_page.agent_tools")
@patch("src.agents.embedded_page.build_llm")
async def test_embedded_page_agent_success(mock_build_llm, mock_agent_tools, mock_run_agent_loop, settings):
    from src.agents.embedded_page import EmbeddedPageAgent

    mock_build_llm.return_value = MagicMock()
    mock_agent_tools.return_value = DummyAsyncContext([])
    mock_run_agent_loop.return_value = LoopResultStub(
        tool_calls_made=2,
        payload={
            "all_stream_urls": [{"url": "https://cdn.example.com/stream.m3u8", "type": "hls"}],
            "servers": [],
            "successful_servers": 1,
        },
    )

    agent = EmbeddedPageAgent(settings)
    result = await agent.run(url="https://embed.example.com/player")

    assert result.page_type == PageType.EMBEDDED
    assert result.status == ExtractionStatus.SUCCESS
    assert len(result.streams) == 1
