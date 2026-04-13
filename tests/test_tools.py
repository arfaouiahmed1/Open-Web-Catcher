"""Unit tests for tool wrappers, JS bridge invocation, and async fallbacks."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from src.tools.bridge import JSToolBridge
from src.tools.email_tool import EmailTool
from src.tools.ipinfo_tool import IPInfoTool
from src.tools.harvest_tool import HarvestTool
from src.tools.inspect_tool import InspectTool
from src.tools.interact_tool import InteractTool
from src.tools.navigate_tool import NavigateTool
from src.tools.screenshot_tool import ScreenshotTool


def _bridge_stub() -> JSToolBridge:
    return JSToolBridge(browser_ws_endpoint="ws://browser.example/devtools/browser/test", timeout=5)


def test_bridge_injects_browser_endpoint():
    bridge = JSToolBridge(browser_ws_endpoint="ws://browser.example/devtools/browser/test", timeout=5)
    with patch("src.tools.bridge.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stdout='{"ok": true}', stderr="")
        result = bridge.call("open_url", {"url": "https://example.com"})

    assert result == {"ok": True}
    command = mock_run.call_args.args[0]
    assert command[0] == "node"
    assert command[1].endswith("tools\\puppeteer\\run-tool.js") or command[1].endswith("tools/puppeteer/run-tool.js")
    assert command[2] == "open_url"
    payload_json = command[3]
    assert '"browserWSEndpoint": "ws://browser.example/devtools/browser/test"' in payload_json


def test_bridge_surfaces_tool_failure():
    bridge = JSToolBridge(browser_ws_endpoint="ws://browser.example/devtools/browser/test", timeout=5)
    with patch("src.tools.bridge.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=1, stdout="", stderr="boom")
        with pytest.raises(RuntimeError, match="open_url"):
            bridge.call("open_url", {"url": "https://example.com"})


def test_bridge_rejects_invalid_json():
    bridge = JSToolBridge(browser_ws_endpoint="ws://browser.example/devtools/browser/test", timeout=5)
    with patch("src.tools.bridge.subprocess.run") as mock_run:
        mock_run.return_value = MagicMock(returncode=0, stdout="not-json", stderr="")
        with pytest.raises(RuntimeError, match="non-JSON"):
            bridge.call("query_elements", {"kind": "link"})


def test_navigate_tool_passes_expected_payload():
    bridge = _bridge_stub()
    bridge.call = MagicMock(return_value={"ok": True})

    tool = NavigateTool(bridge=bridge)
    result = tool._run(url="https://example.com/watch", wait_until="domcontentloaded", timeout_ms=1234)

    assert result == {"ok": True}
    bridge.call.assert_called_once_with(
        "navigate",
        {"url": "https://example.com/watch", "wait_until": "domcontentloaded", "timeout_ms": 1234},
    )


def test_inspect_tool_uses_empty_payload_for_full_scan():
    bridge = _bridge_stub()
    bridge.call = MagicMock(return_value={"ok": True})

    tool = InspectTool(bridge=bridge)
    tool._run(selector=".ignored", include_screenshot=False)

    bridge.call.assert_called_once_with("inspect", {})


def test_interact_tool_builds_mode_specific_payload():
    bridge = _bridge_stub()
    bridge.call = MagicMock(return_value={"ok": True})

    tool = InteractTool(bridge=bridge)
    tool._run(action="type", selector="#search", value="Team A", wait_ms=750)

    bridge.call.assert_called_once_with(
        "interact",
        {"mode": "type", "wait_ms": 750, "selector": "#search", "value": "Team A"},
    )


def test_harvest_tool_converts_wait_seconds_to_duration_ms():
    bridge = _bridge_stub()
    bridge.call = MagicMock(return_value={"ok": True})

    tool = HarvestTool(bridge=bridge)
    tool._run(wait_seconds=7, player_iframe_url="https://embed.example.com/player")

    bridge.call.assert_called_once_with(
        "harvest",
        {"duration_ms": 7000, "player_iframe_url": "https://embed.example.com/player"},
    )


def test_screenshot_tool_maps_player_mode_to_element():
    bridge = _bridge_stub()
    bridge.call = MagicMock(return_value={"ok": True})

    tool = ScreenshotTool(bridge=bridge)
    tool._run(mode="player", selector="video")

    bridge.call.assert_called_once_with("screenshot", {"mode": "element", "selector": "video"})


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
