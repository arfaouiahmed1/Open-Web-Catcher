"""Unit tests for each tool wrapper (bridge is mocked)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from src.tools.bridge import JSToolBridge
from src.tools.harvest_tool import HarvestTool
from src.tools.inspect_tool import InspectTool
from src.tools.interact_tool import InteractTool
from src.tools.navigate_tool import NavigateTool
from src.tools.screenshot_tool import ScreenshotTool


@pytest.fixture
def bridge():
    b = MagicMock(spec=JSToolBridge)
    b.call.return_value = {"success": True}
    return b


def test_inspect_tool_calls_bridge(bridge):
    tool = InspectTool(bridge=bridge)
    tool._run(selector="body", include_screenshot=False)
    bridge.call.assert_called_once_with("inspect", {"selector": "body", "includeScreenshot": False})


def test_interact_tool_click(bridge):
    tool = InteractTool(bridge=bridge)
    tool._run(action="click", selector=".play-btn")
    bridge.call.assert_called_once_with("interact", {"action": "click", "selector": ".play-btn"})


def test_interact_tool_coordinates(bridge):
    tool = InteractTool(bridge=bridge)
    tool._run(action="coordinates", x=100.0, y=200.0)
    call_args = bridge.call.call_args[0]
    assert call_args[1]["action"] == "coordinates"
    assert call_args[1]["x"] == 100.0
    assert call_args[1]["y"] == 200.0


def test_harvest_tool(bridge):
    bridge.call.return_value = {"streams": [], "total": 0}
    tool = HarvestTool(bridge=bridge)
    result = tool._run(wait_seconds=3, include_iframes=True)
    bridge.call.assert_called_once_with("harvest", {"waitSeconds": 3, "includeIframes": True})
    assert result["total"] == 0


def test_navigate_tool(bridge):
    bridge.call.return_value = {"success": True, "finalUrl": "https://example.com", "title": "Test"}
    tool = NavigateTool(bridge=bridge)
    result = tool._run(url="https://example.com")
    bridge.call.assert_called_once()
    assert result["finalUrl"] == "https://example.com"


def test_screenshot_tool_viewport(bridge):
    bridge.call.return_value = {"screenshotUrl": "https://cloudinary.com/img.png", "mode": "viewport"}
    tool = ScreenshotTool(bridge=bridge)
    result = tool._run(mode="viewport")
    bridge.call.assert_called_once_with("screenshot", {"mode": "viewport"})
    assert "screenshotUrl" in result
