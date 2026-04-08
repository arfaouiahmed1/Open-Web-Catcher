"""MCP client — loads tools for a specific agent profile from the MCP server.

Each agent profile maps to an SSE endpoint on the MCP server:
    classification → /mcp/classification/sse
    landing        → /mcp/landing/sse
    hosting        → /mcp/hosting/sse
    embedded       → /mcp/embedded/sse

When the MCP server runs with MCP_BROWSER_MODE=isolated, each SSE session also
gets its own temporary browser instance. That browser is reused across tool
calls for the lifetime of the agent session and then shut down automatically.

The MCP server enforces which tools are visible per profile — the LLM only
sees tools registered for its profile, not the full tool set.

Usage (inside an async context):
    async with agent_tools("hosting", settings) as tools:
        result = await run_agent_loop(llm, tools, ...)
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, AsyncGenerator

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools

from src.utils.config import Settings
from src.utils.logging import get_logger

if TYPE_CHECKING:
    from src.utils.observability import RunObserver

logger = get_logger(__name__)

VALID_PROFILES = {"classification", "landing", "hosting", "embedded"}
REQUIRED_TOOLS_BY_PROFILE = {
    "classification": {
        "open_url",
        "get_page_context",
        "get_frame_tree",
        "query_elements",
        "get_element_detail",
        "scroll_page",
        "go_back",
        "wait_for_page_state",
    },
    "landing": {
        "get_page_context",
        "query_elements",
        "get_element_detail",
        "get_frame_tree",
        "open_url",
        "go_back",
        "scroll_page",
        "scroll_to_element",
        "wait_for_page_state",
        "click_element",
        "click_css",
        "click_text",
        "click_xpath",
        "click_checkbox",
        "click_radio",
        "type_into",
        "select_option",
        "play_media",
        "swipe_region",
        "click_coordinates",
    },
    "hosting": {
        "get_page_context",
        "query_elements",
        "get_element_detail",
        "get_frame_tree",
        "open_url",
        "go_back",
        "scroll_page",
        "scroll_to_element",
        "wait_for_page_state",
        "click_element",
        "click_css",
        "click_text",
        "click_xpath",
        "click_checkbox",
        "click_radio",
        "type_into",
        "select_option",
        "play_media",
        "swipe_region",
        "click_coordinates",
        "get_media_state",
        "capture_streams",
    },
    "embedded": {
        "get_page_context",
        "query_elements",
        "get_element_detail",
        "get_frame_tree",
        "open_url",
        "go_back",
        "scroll_page",
        "scroll_to_element",
        "wait_for_page_state",
        "click_element",
        "click_css",
        "click_text",
        "click_xpath",
        "click_checkbox",
        "click_radio",
        "type_into",
        "select_option",
        "play_media",
        "swipe_region",
        "click_coordinates",
        "get_media_state",
        "capture_streams",
    },
}


@asynccontextmanager
async def agent_tools(
    profile: str,
    settings: Settings,
    observer: "RunObserver | None" = None,
) -> AsyncGenerator[list[BaseTool], None]:
    """Async context manager that yields LangChain tools for the given profile.

    Connects to the MCP server, gets the tool list (already filtered to the
    profile by the server), and keeps the connection open for the duration
    of the agent loop. Disconnects cleanly on exit.

    Args:
        profile: One of classification | landing | hosting | embedded
        settings: Application settings (provides mcp_server_url)

    Yields:
        List of LangChain BaseTool objects ready for bind_tools()

    Example:
        async with agent_tools("hosting", settings) as tools:
            result = await run_agent_loop(llm, tools, system_prompt, message)
    """
    if profile not in VALID_PROFILES:
        raise ValueError(f"Unknown profile '{profile}'. Valid: {VALID_PROFILES}")

    url = f"{settings.mcp_server_url}/mcp/{profile}/sse"
    logger.info("Connecting to MCP profile '%s' at %s", profile, url)
    if observer is not None:
        observer.emit(
            "tool_session_connecting",
            f"Connecting MCP tool profile '{profile}'",
            details={"profile": profile, "url": url},
        )

    # langchain-mcp-adapters >= 0.1.0 removed context-manager support.
    # Initialize the client directly and call get_tools() instead.
    client = MultiServerMCPClient(
        {profile: {"url": url, "transport": "sse"}}
    )
    try:
        tool_load_timeout = max(1, int(settings.tool_timeout_seconds))
        try:
            tools = await asyncio.wait_for(client.get_tools(), timeout=tool_load_timeout)
        except asyncio.TimeoutError:
            logger.warning(
                "get_tools() timed out for profile '%s' after %ss; trying session fallback",
                profile,
                tool_load_timeout,
            )
            try:
                async with client.session(profile) as session:
                    tools = await asyncio.wait_for(
                        asyncio.to_thread(load_mcp_tools, session, server_name=profile),
                        timeout=tool_load_timeout,
                    )
            except Exception as exc:
                message = f"Timed out loading MCP tools for profile '{profile}' after {tool_load_timeout}s"
                if observer is not None:
                    observer.emit(
                        "tool_session_failed",
                        message,
                        status="error",
                        details={"profile": profile, "timeout_seconds": tool_load_timeout},
                    )
                raise RuntimeError(message) from exc

        tool_names = [t.name for t in tools]
        missing_tools = sorted(REQUIRED_TOOLS_BY_PROFILE[profile] - set(tool_names))
        if missing_tools:
            if observer is not None:
                observer.emit(
                    "tool_session_failed",
                    f"MCP profile '{profile}' missing required tools",
                    status="error",
                    details={"profile": profile, "missing_tools": missing_tools},
                )
            raise RuntimeError(
                f"MCP profile '{profile}' is missing required tools: {', '.join(missing_tools)}"
            )
        logger.info("MCP profile '%s' loaded %d tools: %s", profile, len(tools), tool_names)
        if observer is not None:
            observer.emit(
                "tool_session_ready",
                f"MCP profile '{profile}' loaded {len(tool_names)} tools",
                details={"profile": profile, "tool_names": tool_names, "tool_count": len(tool_names)},
            )
        yield tools
    finally:
        # Best-effort cleanup: close all SSE sessions to prevent connection leaks.
        try:
            for session in getattr(client, "_sessions", {}).values():
                try:
                    await session.__aexit__(None, None, None)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass
        if observer is not None:
            observer.emit(
                "tool_session_closed",
                f"Closed MCP profile '{profile}' session",
                details={"profile": profile},
            )
