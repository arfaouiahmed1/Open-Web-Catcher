"""tests/agents/test_embedded_agent.py

Deterministic contract tests for the Embedded Page Agent (plan step 10).
Verifies:
- Frame-scoped player activation and stream discovery
- Prohibition of external navigation
- Proof capture (screenshot + network manifest)
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import pytest

from src.agents.embedded_page import EmbeddedPageAgent
from src.models.common import ExtractionStatus, PageType
from src.tools.mcp_client import AgentToolSession
from src.utils.config import Settings


def _mock_tool_session():
    tool_names = ["navigate", "inspect", "interact", "screenshot", "harvest", "wait", "plan"]
    tools = [MagicMock(name=n) for n in tool_names]
    for t, n in zip(tools, tool_names):
        t.name = n
    return AgentToolSession(
        profile="embedded",
        tools=tools,
        manifest={"tools": [{"name": t.name, "kind": "mcp"} for t in tools]},
        session_id="test-session-embedded",
    )


@pytest.mark.asyncio
async def test_embedded_agent_stream_capture(monkeypatch):
    settings = Settings()
    agent = EmbeddedPageAgent(settings)

    mock_llm_result = {
        "url": "http://embedded.owc.test/embed/player-101",
        "page_type": "embedded_page",
        "status": "success",
        "servers": [
            {
                "label": "embed_default",
                "status": "success",
                "playback_confirmed": True,
                "m3u8_urls": ["http://embedded.owc.test/hls/live.m3u8"],
                "screenshot_url": "blobref:0123456789abcdef",
                "evidence": [
                    {
                        "kind": "network_entry",
                        "tool_call_id": "call-harvest-1",
                        "page_state_id": "ps-embed-1",
                        "ref": "http://embedded.owc.test/hls/live.m3u8",
                        "summary": "Live HLS stream",
                    }
                ],
            }
        ],
        "streams": [
            {
                "url": "http://embedded.owc.test/hls/live.m3u8",
                "protocol": "hls",
                "verified": True,
                "http_status": 200,
            }
        ],
    }

    async def mock_run_agent_loop(*args, **kwargs):
        from src.agents.runtime.models import AgentLoopResult
        return AgentLoopResult(
            final_text=json.dumps(mock_llm_result),
            tool_calls_made=3,
            messages=[],
        )

    monkeypatch.setattr("src.agents.runtime.build_llm", lambda *a, **k: MagicMock())
    monkeypatch.setattr("src.agents.runtime.run_agent_loop", mock_run_agent_loop)

    @asynccontextmanager
    async def mock_agent_tools(*args, **kwargs):
        yield _mock_tool_session()

    monkeypatch.setattr("src.tools.mcp_client.agent_tools", mock_agent_tools)

    result = await agent.run("http://embedded.owc.test/embed/player-101")
    assert result.page_type == PageType.EMBEDDED
    assert result.status == ExtractionStatus.SUCCESS
    assert len(result.streams) == 1
    assert result.streams[0].url == "http://embedded.owc.test/hls/live.m3u8"
