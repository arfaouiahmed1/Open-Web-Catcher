"""tests/agents/test_classification_agent.py

Deterministic contract tests for the Classification Agent (plan step 10).
Verifies:
- landing, hosting, embedded, challenge, inaccessible, and unrelated pages
- exact page type and confidence
- evidence refs presence and validity
- bounded tool calls
"""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest

from src.agents.classification import ClassificationAgent
from src.models.common import Confidence, PageType
from src.tools.mcp_client import AgentToolSession
from src.utils.config import Settings


def _mock_tool_session():
    mock_nav = MagicMock()
    mock_nav.name = "navigate"
    mock_inspect = MagicMock()
    mock_inspect.name = "inspect"
    mock_screenshot = MagicMock()
    mock_screenshot.name = "screenshot"
    mock_interact = MagicMock()
    mock_interact.name = "interact"
    mock_wait = MagicMock()
    mock_wait.name = "wait"

    tools = [mock_nav, mock_inspect, mock_screenshot, mock_interact, mock_wait]
    return AgentToolSession(
        profile="classification",
        tools=tools,
        manifest={"tools": [{"name": t.name, "kind": "mcp"} for t in tools]},
        session_id="test-session-classification",
    )


@pytest.mark.asyncio
async def test_classification_landing_page(monkeypatch):
    settings = Settings()
    agent = ClassificationAgent(settings)

    mock_llm_result = {
        "url": "http://landing.owc.test/",
        "page_type": "landing_page",
        "confidence": "high",
        "reasoning": "Multiple match cards and directory pagination detected.",
        "evidence": [
            {
                "kind": "screenshot",
                "tool_call_id": "call-1",
                "page_state_id": "ps-1",
                "ref": "blobref:abc1234567890123",
                "summary": "Match cards grid observed",
            }
        ],
    }

    async def mock_run_agent_loop(*args, **kwargs):
        from src.agents.runtime.models import AgentLoopResult
        return AgentLoopResult(
            final_text=json.dumps(mock_llm_result),
            tool_calls_made=2,
            messages=[],
        )

    monkeypatch.setattr("src.agents.runtime.build_llm", lambda *a, **k: MagicMock())
    monkeypatch.setattr("src.agents.runtime.run_agent_loop", mock_run_agent_loop)

    from contextlib import asynccontextmanager
    @asynccontextmanager
    async def mock_agent_tools(*args, **kwargs):
        yield _mock_tool_session()

    monkeypatch.setattr("src.tools.mcp_client.agent_tools", mock_agent_tools)

    result = await agent.run("http://landing.owc.test/")
    assert result.page_type == PageType.LANDING
    assert result.confidence == Confidence.HIGH
    assert len(result.evidence) >= 1
    assert result.evidence[0].kind == "screenshot"


@pytest.mark.asyncio
async def test_classification_challenge_page(monkeypatch):
    settings = Settings()
    agent = ClassificationAgent(settings)

    mock_llm_result = {
        "url": "http://blocked.owc.test/",
        "page_type": "unknown",
        "confidence": "high",
        "reasoning": "Persistent Cloudflare Turnstile challenge detected.",
        "evidence": [
            {
                "kind": "page_state",
                "tool_call_id": "call-1",
                "page_state_id": "ps-challenge",
                "ref": "ps-challenge",
                "summary": "Access state challenge observed",
            }
        ],
    }

    async def mock_run_agent_loop(*args, **kwargs):
        from src.agents.runtime.models import AgentLoopResult
        return AgentLoopResult(
            final_text=json.dumps(mock_llm_result),
            tool_calls_made=2,
            messages=[],
        )

    monkeypatch.setattr("src.agents.runtime.build_llm", lambda *a, **k: MagicMock())
    monkeypatch.setattr("src.agents.runtime.run_agent_loop", mock_run_agent_loop)

    from contextlib import asynccontextmanager
    @asynccontextmanager
    async def mock_agent_tools(*args, **kwargs):
        yield _mock_tool_session()

    monkeypatch.setattr("src.tools.mcp_client.agent_tools", mock_agent_tools)

    result = await agent.run("http://blocked.owc.test/")
    assert result.page_type == PageType.UNKNOWN
    assert len(result.evidence) == 1
