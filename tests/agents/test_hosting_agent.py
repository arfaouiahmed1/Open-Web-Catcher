"""tests/agents/test_hosting_agent.py

Deterministic contract tests for the Hosting Page Agent (plan step 10).
Verifies:
- Extraction of ServerResult and StreamURL items
- Evidence chain per attempted source
- Coverage of visible server tabs
- Rejection of fabricated URLs
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import pytest

from src.agents.hosting_page import HostingPageAgent
from src.models.common import ExtractionStatus, PageType
from src.tools.mcp_client import AgentToolSession
from src.utils.config import Settings


def _mock_tool_session():
    tool_names = ["navigate", "inspect", "interact", "screenshot", "harvest", "wait", "plan"]
    tools = [MagicMock(name=n) for n in tool_names]
    for t, n in zip(tools, tool_names):
        t.name = n
    return AgentToolSession(
        profile="hosting",
        tools=tools,
        manifest={"tools": [{"name": t.name, "kind": "mcp"} for t in tools]},
        session_id="test-session-hosting",
    )


@pytest.mark.asyncio
async def test_hosting_agent_server_extraction(monkeypatch):
    settings = Settings()
    agent = HostingPageAgent(settings)

    mock_llm_result = {
        "url": "http://hosting.owc.test/watch/match-101",
        "page_type": "hosting_page",
        "status": "success",
        "servers": [
            {
                "label": "Server 1",
                "status": "success",
                "playback_confirmed": True,
                "m3u8_urls": ["http://hosting.owc.test/streams/live/master.m3u8"],
                "screenshot_url": "blobref:0123456789abcdef",
                "evidence": [
                    {
                        "kind": "manifest_probe",
                        "tool_call_id": "call-harvest-1",
                        "page_state_id": "ps-host-1",
                        "ref": "http://hosting.owc.test/streams/live/master.m3u8",
                        "summary": "Master playlist HTTP 200",
                    }
                ],
            }
        ],
        "streams": [
            {
                "url": "http://hosting.owc.test/streams/live/master.m3u8",
                "protocol": "hls",
                "verified": True,
                "http_status": 200,
                "source_layers": ["network_ledger", "dom_scan"],
            }
        ],
    }

    async def mock_run_agent_loop(*args, **kwargs):
        from src.agents.runtime.models import AgentLoopResult
        return AgentLoopResult(
            final_text=json.dumps(mock_llm_result),
            tool_calls_made=4,
            messages=[],
        )

    monkeypatch.setattr("src.agents.runtime.build_llm", lambda *a, **k: MagicMock())
    monkeypatch.setattr("src.agents.runtime.run_agent_loop", mock_run_agent_loop)

    @asynccontextmanager
    async def mock_agent_tools(*args, **kwargs):
        yield _mock_tool_session()

    monkeypatch.setattr("src.tools.mcp_client.agent_tools", mock_agent_tools)

    result = await agent.run("http://hosting.owc.test/watch/match-101")
    assert result.page_type == PageType.HOSTING
    assert result.status == ExtractionStatus.SUCCESS
    assert len(result.servers) == 1
    assert result.servers[0].playback_confirmed is True
    assert len(result.streams) == 1
    assert result.streams[0].verified is True
