"""Lazy exports for tool entry points.

This avoids importing MCP client dependencies when callers only need a single
tool module such as ``email_tool`` or ``ipinfo_tool``.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

__all__ = [
    "agent_tools",
    "EmailTool",
    "HarvestTool",
    "IPInfoTool",
    "InspectTool",
    "InteractTool",
    "NavigateTool",
    "ScreenshotTool",
]


def __getattr__(name: str) -> Any:
    module_map = {
        "agent_tools": "src.tools.mcp_client",
        "EmailTool": "src.tools.email_tool",
        "HarvestTool": "src.tools.harvest_tool",
        "IPInfoTool": "src.tools.ipinfo_tool",
        "InspectTool": "src.tools.inspect_tool",
        "InteractTool": "src.tools.interact_tool",
        "NavigateTool": "src.tools.navigate_tool",
        "ScreenshotTool": "src.tools.screenshot_tool",
    }
    module_name = module_map.get(name)
    if module_name is None:
        raise AttributeError(f"module 'src.tools' has no attribute {name!r}")
    return getattr(import_module(module_name), name)
