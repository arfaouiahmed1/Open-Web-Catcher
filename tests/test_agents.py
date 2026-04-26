"""Agent tests focused on MCP profile usage and LangGraph runtime contracts."""

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


def _assert_agent_loop_contract(
    mock_agent_tools,
    mock_run_agent_loop,
    *,
    profile: str,
    run_name: str,
    initial_message_contains: str,
    max_tool_calls: int,
) -> None:
    assert mock_agent_tools.call_args.args[0] == profile

    kwargs = mock_run_agent_loop.await_args.kwargs
    assert kwargs["run_name"] == run_name
    assert initial_message_contains in kwargs["initial_message"]
    assert "BASE POLICY" in kwargs["system_prompt"]
    assert "AGENT CONTRACT" in kwargs["system_prompt"]
    assert "TASK BRIEF" in kwargs["system_prompt"]
    assert "WORKING STATE" in kwargs["system_prompt"]
    assert kwargs["max_tool_calls"] == max_tool_calls
    assert kwargs["budget_exhausted_message"]
    assert kwargs["tools"] == []
    assert kwargs["prompt_metadata"]["agent_id"]
    assert kwargs["prompt_metadata"]["prompt_hash"]
    assert callable(kwargs["turn_context_provider"])


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
    _assert_agent_loop_contract(
        mock_agent_tools,
        mock_run_agent_loop,
        profile="classification",
        run_name="classification_agent",
        initial_message_contains="Classify this page: https://x.com",
        max_tool_calls=settings.classification_max_tool_calls,
    )


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
    assert result.metadata["hosting_pages"][0]["route"] == "stream_extractor"
    _assert_agent_loop_contract(
        mock_agent_tools,
        mock_run_agent_loop,
        profile="landing",
        run_name="landing_page_agent",
        initial_message_contains="mainUrl: https://example-streaming.com",
        max_tool_calls=settings.landing_page_max_tool_calls,
    )


def test_landing_output_expands_pattern_matched_candidates_from_run_memory():
    from src.agents.landing_page import _augment_landing_output

    output_json = {
        "hosting_pages": [
            {
                "url": "https://example.com/watch/team-a-vs-team-b",
                "title": "Team A vs Team B",
                "confidence": 92,
            }
        ],
        "site_patterns": {},
    }
    run_memory = {
        "hosting_candidate_urls": [
            "https://example.com/watch/team-c-vs-team-d",
        ],
        "common": {
            "critical_links": [
                "https://example.com/watch/team-e-vs-team-f",
                "https://example.com/privacy",
            ]
        },
    }

    augmented, expanded = _augment_landing_output(
        output_json,
        source_url="https://example.com/live",
        run_memory=run_memory,
    )

    urls = [entry["url"] for entry in augmented["hosting_pages"]]
    assert "https://example.com/watch/team-a-vs-team-b" in urls
    assert "https://example.com/watch/team-c-vs-team-d" in urls
    assert "https://example.com/watch/team-e-vs-team-f" in urls
    assert "https://example.com/privacy" not in urls
    assert expanded >= 2


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
    _assert_agent_loop_contract(
        mock_agent_tools,
        mock_run_agent_loop,
        profile="hosting",
        run_name="hosting_page_agent",
        initial_message_contains="mainUrl: https://hosting.example.com/video/1",
        max_tool_calls=settings.hosting_page_max_tool_calls,
    )


@pytest.mark.asyncio
@patch("src.agents.hosting_page.remember_agent_run")
@patch("src.agents.hosting_page.build_memory_context", return_value="SITE MEMORY HINTS\n- repeated server labels: `Server 2`")
@patch("src.agents.hosting_page.run_agent_loop", new_callable=AsyncMock)
@patch("src.agents.hosting_page.agent_tools")
@patch("src.agents.hosting_page.build_llm")
async def test_hosting_page_agent_injects_site_memory_hints(
    mock_build_llm,
    mock_agent_tools,
    mock_run_agent_loop,
    mock_build_memory_context,
    mock_remember_agent_run,
    tmp_path,
):
    from src.agents.hosting_page import HostingPageAgent
    from src.utils.config import Settings

    settings = Settings(
        google_api_key="test-key",
        browser_ws_endpoint="ws://localhost:9222",
        database_url="sqlite:///:memory:",
        memory_enabled=True,
        memory_db_path=str(tmp_path / "site_memory.db"),
    )
    mock_build_llm.return_value = MagicMock()
    mock_agent_tools.return_value = DummyAsyncContext([])
    mock_run_agent_loop.return_value = LoopResultStub(
        tool_calls_made=1,
        payload={"streaming_urls": [], "servers": [], "decision": "no_stream_found"},
    )

    agent = HostingPageAgent(settings)
    await agent.run(url="https://hosting.example.com/video/1")

    system_prompt = mock_run_agent_loop.await_args.kwargs["system_prompt"]
    assert "SITE MEMORY HINTS" in system_prompt
    assert "Server 2" in system_prompt
    mock_build_memory_context.assert_called_once()
    mock_remember_agent_run.assert_called_once()


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
            "servers": [{"player_iframe_url": "https://embed.example.com/player"}],
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
    _assert_agent_loop_contract(
        mock_agent_tools,
        mock_run_agent_loop,
        profile="embedded",
        run_name="embedded_page_agent",
        initial_message_contains="Embedded_url: https://embed.example.com/player",
        max_tool_calls=settings.embedded_page_max_tool_calls,
    )


@pytest.mark.asyncio
@patch("src.agents.hosting_page.run_agent_loop", new_callable=AsyncMock)
@patch("src.agents.hosting_page.agent_tools")
@patch("src.agents.hosting_page.build_llm")
async def test_hosting_page_agent_normalizes_servers_and_handoff(
    mock_build_llm,
    mock_agent_tools,
    mock_run_agent_loop,
    settings,
):
    from src.agents.hosting_page import HostingPageAgent

    mock_build_llm.return_value = MagicMock()
    mock_agent_tools.return_value = DummyAsyncContext([])
    mock_run_agent_loop.return_value = LoopResultStub(
        tool_calls_made=3,
        payload={
            "servers": [
                {
                    "label": "Server 1",
                    "m3u8_urls": [
                        "https://cdn.example.com/live/master.m3u8",
                        "https://cdn.example.com/live/master.m3u8",
                    ],
                    "mp4_urls": ["https://cdn.example.com/live/fallback.mp4"],
                    "screenshot_url": "https://res.cloudinary.com/demo/image/upload/v1/host-server-1.png",
                    "embedded_url": "https://embed.example.com/player/abc",
                    "embedded_url_source": "dom_iframe",
                    "player_iframe_url": "https://embed.example.com/player/abc",
                    "status": "needs_embed_agent",
                    "player_state": "playing",
                    "visual_confirmation": "video playing",
                    "network_diagnostics": [{"url": "https://cdn.example.com/live/master.m3u8"}],
                    "iframe_diagnostics": [{"url": "https://embed.example.com/player/abc"}],
                }
            ],
            "decision": "needs_embed_agent",
        },
    )

    agent = HostingPageAgent(settings)
    result = await agent.run(
        url="https://hosting.example.com/video/1",
        orchestrator_handoff="focus on iframe handoff and keep server labels clean",
    )

    assert result.status == ExtractionStatus.SUCCESS
    assert result.embedded_urls == ["https://embed.example.com/player/abc"]
    assert result.screenshots == ["https://res.cloudinary.com/demo/image/upload/v1/host-server-1.png"]
    assert len(result.servers) == 1
    assert result.servers[0].label == "Server 1"
    assert result.servers[0].m3u8_urls == ["https://cdn.example.com/live/master.m3u8"]
    assert result.servers[0].mp4_urls == ["https://cdn.example.com/live/fallback.mp4"]
    assert result.servers[0].embedded_url_source == "dom_iframe"
    assert result.servers[0].player_iframe_url == "https://embed.example.com/player/abc"
    assert result.servers[0].player_state == "playing"
    assert result.servers[0].network_diagnostics == [{"url": "https://cdn.example.com/live/master.m3u8"}]
    assert result.servers[0].iframe_diagnostics == [{"url": "https://embed.example.com/player/abc"}]
    assert sorted(stream.url for stream in result.streams) == sorted(
        [
            "https://cdn.example.com/live/master.m3u8",
            "https://cdn.example.com/live/fallback.mp4",
        ]
    )

    initial_message = mock_run_agent_loop.await_args.kwargs["initial_message"]
    assert "ORCHESTRATOR HANDOFF" in initial_message


@pytest.mark.asyncio
@patch("src.agents.embedded_page.run_agent_loop", new_callable=AsyncMock)
@patch("src.agents.embedded_page.agent_tools")
@patch("src.agents.embedded_page.build_llm")
async def test_embedded_page_agent_normalizes_server_artifacts(
    mock_build_llm,
    mock_agent_tools,
    mock_run_agent_loop,
    settings,
):
    from src.agents.embedded_page import EmbeddedPageAgent

    mock_build_llm.return_value = MagicMock()
    mock_agent_tools.return_value = DummyAsyncContext([])
    mock_run_agent_loop.return_value = LoopResultStub(
        tool_calls_made=2,
        payload={
            "servers": [
                {
                    "label": "Embed Server A",
                    "m3u8_urls": ["https://embed-cdn.example.com/live/master.m3u8"],
                    "mpd_urls": ["https://embed-cdn.example.com/live/master.mpd"],
                    "mp4_urls": ["https://embed-cdn.example.com/live/fallback.mp4"],
                    "screenshot_url": "https://res.cloudinary.com/demo/image/upload/v1/embed-server-a.png",
                    "status": "success",
                    "embedded_url_source": "frame_switch",
                    "player_iframe_url": "https://embed.example.com/player",
                    "player_state": "playing",
                    "visual_confirmation": "video playing",
                    "network_diagnostics": [{"url": "https://embed-cdn.example.com/live/master.m3u8"}],
                    "iframe_diagnostics": [{"url": "https://embed.example.com/player"}],
                }
            ],
            "successful_servers": 1,
        },
    )

    agent = EmbeddedPageAgent(settings)
    result = await agent.run(url="https://embed.example.com/player")

    assert result.status == ExtractionStatus.SUCCESS
    assert len(result.servers) == 1
    assert result.servers[0].label == "Embed Server A"
    assert result.servers[0].embedded_url_source == "frame_switch"
    assert result.servers[0].player_iframe_url == "https://embed.example.com/player"
    assert result.servers[0].player_state == "playing"
    assert result.servers[0].network_diagnostics == [{"url": "https://embed-cdn.example.com/live/master.m3u8"}]
    assert result.servers[0].iframe_diagnostics == [{"url": "https://embed.example.com/player"}]
    assert result.screenshots == ["https://res.cloudinary.com/demo/image/upload/v1/embed-server-a.png"]
    assert sorted(stream.url for stream in result.streams) == sorted(
        [
            "https://embed-cdn.example.com/live/master.m3u8",
            "https://embed-cdn.example.com/live/master.mpd",
            "https://embed-cdn.example.com/live/fallback.mp4",
        ]
    )
    assert result.metadata["total_unique_streams"] == 3
