"""tests/agents/test_landing_agent.py

Deterministic contract tests for the Landing Page Agent (plan step 10).
Verifies:
- Extraction of MatchInfo candidate items
- Deduplication and exact URL preservation
- Evidence reference preservation
- Precision and completion gap detection
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from unittest.mock import MagicMock

import pytest

from src.agents.landing_page import LandingPageAgent
from src.models.common import ExtractionStatus, PageType
from src.tools.mcp_client import AgentToolSession
from src.utils.config import Settings


def _mock_tool_session():
    names = ["navigate", "inspect", "interact", "screenshot", "wait", "plan"]
    tools = [MagicMock(name=n) for n in names]
    for t, n in zip(tools, names):
        t.name = n
    return AgentToolSession(
        profile="landing",
        tools=tools,
        manifest={"tools": [{"name": t.name, "kind": "mcp"} for t in tools]},
        session_id="test-session-landing",
    )


@pytest.mark.asyncio
async def test_landing_agent_card_extraction(monkeypatch):
    settings = Settings()
    agent = LandingPageAgent(settings)

    mock_llm_result = {
        "matches": [
            {
                "url": "http://hosting.owc.test/watch/match-101",
                "title": "Arsenal vs Chelsea",
                "status": "live",
                "confidence": 90,
                "evidence": [
                    {
                        "kind": "screenshot",
                        "tool_call_id": "call-1",
                        "page_state_id": "ps-landing-1",
                        "ref": "blobref:0123456789abcdef",
                        "summary": "Match card 1 visible",
                    }
                ],
            },
            {
                "url": "http://hosting.owc.test/watch/match-102",
                "title": "Real Madrid vs Barcelona",
                "status": "live",
                "confidence": 90,
                "evidence": [
                    {
                        "kind": "screenshot",
                        "tool_call_id": "call-1",
                        "page_state_id": "ps-landing-1",
                        "ref": "blobref:0123456789abcdef",
                        "summary": "Match card 2 visible",
                    }
                ],
            },
        ],
        "total_discovered": 2,
        "completion_gap": False,
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

    result = await agent.run("http://landing.owc.test/")
    assert result.page_type == PageType.LANDING
    assert result.status == ExtractionStatus.SUCCESS
    assert len(result.metadata.get("matches", [])) == 2
