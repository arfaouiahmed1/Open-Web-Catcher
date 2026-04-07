"""Tests for MCP profile tool validation."""

from __future__ import annotations

from unittest.mock import patch

import pytest


class DummyMCPClient:
    def __init__(self, tools):
        self._tools = tools

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    def get_tools(self):
        return self._tools


class DummyTool:
    def __init__(self, name: str):
        self.name = name


@pytest.mark.asyncio
async def test_agent_tools_raises_when_profile_is_missing_required_tools(settings):
    from src.tools.mcp_client import agent_tools

    with patch("src.tools.mcp_client.MultiServerMCPClient", return_value=DummyMCPClient([DummyTool("inspect")])):
        with pytest.raises(RuntimeError, match="missing required tools"):
            async with agent_tools("hosting", settings):
                pass


@pytest.mark.asyncio
async def test_agent_tools_yields_when_required_tools_exist(settings):
    from src.tools.mcp_client import agent_tools

    tools = [
        DummyTool("inspect"),
        DummyTool("navigate"),
        DummyTool("interact"),
        DummyTool("harvest"),
        DummyTool("screenshot"),
    ]
    with patch("src.tools.mcp_client.MultiServerMCPClient", return_value=DummyMCPClient(tools)):
        async with agent_tools("hosting", settings) as loaded_tools:
            assert [tool.name for tool in loaded_tools] == [tool.name for tool in tools]
