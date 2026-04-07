"""Unit tests for the tool wrappers and async fallbacks."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from src.tools.bridge import JSToolBridge
from src.tools.email_tool import EmailTool
from src.tools.harvest_tool import HarvestTool
from src.tools.inspect_tool import InspectTool
from src.tools.interact_tool import InteractTool
from src.tools.ipinfo_tool import IPInfoTool
from src.tools.navigate_tool import NavigateTool
from src.tools.screenshot_tool import ScreenshotTool


@pytest.fixture
def bridge():
    b = MagicMock(spec=JSToolBridge)
    b.call.return_value = {"success": True}
    return b


def test_inspect_tool_calls_bridge(bridge):
    tool = InspectTool(bridge=bridge)
    tool._run()
    bridge.call.assert_called_once_with("inspect", {})


def test_interact_tool_click(bridge):
    tool = InteractTool(bridge=bridge)
    tool._run(action="click", selector=".play-btn")
    bridge.call.assert_called_once_with(
        "interact",
        {"mode": "click", "wait_ms": 3000, "selector": ".play-btn"},
    )


def test_harvest_tool_maps_duration_ms(bridge):
    bridge.call.return_value = {"streams": [], "total": 0}
    tool = HarvestTool(bridge=bridge)
    result = tool._run(wait_seconds=3)
    bridge.call.assert_called_once_with(
        "harvest",
        {"duration_ms": 3000, "player_iframe_url": ""},
    )
    assert result["total"] == 0


def test_navigate_tool_uses_snake_case_params(bridge):
    bridge.call.return_value = {"success": True, "finalUrl": "https://example.com", "title": "Test"}
    tool = NavigateTool(bridge=bridge)
    result = tool._run(url="https://example.com")
    bridge.call.assert_called_once_with(
        "navigate",
        {"url": "https://example.com", "wait_until": "networkidle2", "timeout_ms": 30000},
    )
    assert result["finalUrl"] == "https://example.com"


def test_screenshot_tool_maps_player_mode_to_element(bridge):
    bridge.call.return_value = {"screenshot_url": "https://cloudinary.com/img.png", "mode": "element"}
    tool = ScreenshotTool(bridge=bridge)
    result = tool._run(mode="player")
    bridge.call.assert_called_once_with("screenshot", {"mode": "element"})
    assert "screenshot_url" in result


@pytest.mark.asyncio
async def test_ipinfo_tool_supports_async_calls():
    tool = IPInfoTool(ipinfo_token="")
    with patch("src.utils.ipinfo.lookup_multiple") as mock_lookup:
        mock_lookup.return_value = []
        result = await tool._arun(stream_urls=["https://cdn.example.com/stream.m3u8"])
    assert result == "[]"


@pytest.mark.asyncio
async def test_email_tool_supports_async_calls():
    tool = EmailTool()
    with patch("src.agents.email_generator.generate_takedown_emails") as mock_generate:
        mock_generate.return_value = []
        result = await tool._arun(
            infringing_url="https://example.com",
            provider_analysis=[],
            extraction_results=[],
        )
    assert result == "[]"
