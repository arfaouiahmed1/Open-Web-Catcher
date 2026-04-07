"""MCP client — loads tools for a specific agent profile from the MCP server.

Each agent profile maps to an SSE endpoint on the MCP server:
    classification → /mcp/classification/sse  (inspect, navigate)
    landing        → /mcp/landing/sse         (inspect, navigate, interact, screenshot)
    hosting        → /mcp/hosting/sse         (inspect, interact, harvest, screenshot, navigate)
    embedded       → /mcp/embedded/sse        (inspect, interact, harvest, screenshot, navigate)

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

from contextlib import asynccontextmanager
from typing import AsyncGenerator

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient

from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)

VALID_PROFILES = {"classification", "landing", "hosting", "embedded"}
REQUIRED_TOOLS_BY_PROFILE = {
    "classification": {"inspect", "navigate"},
    "landing": {"inspect", "navigate", "interact", "screenshot"},
    "hosting": {"inspect", "navigate", "interact", "harvest", "screenshot"},
    "embedded": {"inspect", "navigate", "interact", "harvest", "screenshot"},
}


@asynccontextmanager
async def agent_tools(
    profile: str,
    settings: Settings,
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

    async with MultiServerMCPClient(
        {profile: {"url": url, "transport": "sse"}}
    ) as client:
        tools = client.get_tools()
        tool_names = [t.name for t in tools]
        missing_tools = sorted(REQUIRED_TOOLS_BY_PROFILE[profile] - set(tool_names))
        if missing_tools:
            raise RuntimeError(
                f"MCP profile '{profile}' is missing required tools: {', '.join(missing_tools)}"
            )
        logger.info("MCP profile '%s' loaded %d tools: %s", profile, len(tools), tool_names)
        yield tools
