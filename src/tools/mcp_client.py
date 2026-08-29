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
from urllib.parse import quote, urlsplit

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
        "navigate",
        "inspect",
        "interact",
        "screenshot",
        "memory_lookup",
        "memory_update",
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
        "navigate",
        "inspect_landing",
        "interact",
        "screenshot",
        "memory_lookup",
        "memory_update",
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
        "navigate",
        "inspect_hosting",
        "interact",
        "screenshot",
        "memory_lookup",
        "memory_update",
        "harvest",
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
        "navigate",
        "inspect_embedded",
        "interact",
        "screenshot",
        "memory_lookup",
        "memory_update",
        "harvest",
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


def _disabled_tools_for_profile(settings: Settings, profile: str) -> set[str]:
    browser = str(getattr(settings, "browser_engine", "") or "playwright").strip().lower()
    by_browser = getattr(settings, "disabled_tools_by_browser_profile", {}) or {}
    if isinstance(by_browser, dict):
        browser_profiles = by_browser.get(browser, {})
        if isinstance(browser_profiles, dict):
            tools = browser_profiles.get(profile, [])
            if isinstance(tools, list):
                return {str(tool).strip() for tool in tools if str(tool).strip()}

    legacy = getattr(settings, "disabled_tools_by_profile", {}) or {}
    if isinstance(legacy, dict):
        tools = legacy.get(profile, [])
        if isinstance(tools, list):
            return {str(tool).strip() for tool in tools if str(tool).strip()}
    return set()


def _target_query_params(target_url: str | None) -> str:
    """Build URL-safe targetHost/targetUrl query params for the SSE URL.

    Returns "" when no usable target is known so legacy profile-only
    sessions stay byte-identical to the pre-target wire format.
    """
    candidate = str(target_url or "").strip()
    if not candidate:
        return ""
    try:
        parsed = urlsplit(candidate)
    except ValueError:
        return ""
    host = (parsed.hostname or "").strip().lower()
    if not host:
        return ""
    params = f"targetHost={quote(host, safe='')}"
    if parsed.scheme and parsed.netloc:
        params += f"&targetUrl={quote(candidate, safe='')}"
    return params


@asynccontextmanager
async def agent_tools(
    profile: str,
    settings: Settings,
    observer: "RunObserver | None" = None,
    target_url: str | None = None,
) -> AsyncGenerator[list[BaseTool], None]:
    """Async context manager that yields LangChain tools for the given profile.

    Connects to the MCP server, gets the tool list (already filtered to the
    profile by the server), and keeps the connection open for the duration
    of the agent loop. Disconnects cleanly on exit.

    Args:
        profile: One of classification | landing | hosting | embedded
        settings: Application settings (provides mcp_server_url)
        observer: Optional run observer for telemetry events
        target_url: Optional workflow target URL. When set, its normalized
            host (and the URL itself) travel as SSE query params so the
            server can key the persistent browser jar by
            (profile, target-host). Omit it to get the stable profile-only jar.

    Yields:
        List of LangChain BaseTool objects ready for bind_tools()

    Example:
        async with agent_tools("hosting", settings, target_url=url) as tools:
            result = await run_agent_loop(llm, tools, system_prompt, message)
    """
    if profile not in VALID_PROFILES:
        raise ValueError(f"Unknown profile '{profile}'. Valid: {VALID_PROFILES}")

    query_parts: list[str] = []
    if observer is not None and getattr(observer, "run_id", ""):
        query_parts.append(f"runId={quote(str(observer.run_id), safe='')}")
    target_query = _target_query_params(target_url)
    if target_query:
        query_parts.append(target_query)
    run_query = f"?{'&'.join(query_parts)}" if query_parts else ""
    url = f"{settings.mcp_server_url}/mcp/{profile}/sse{run_query}"
    logger.info("Connecting to MCP profile '%s' at %s", profile, url)
    if observer is not None:
        observer.emit(
            "tool_session_connecting",
            f"Connecting MCP tool profile '{profile}'",
            details={"profile": profile, "url": url},
        )

    # NOTE:
    # MultiServerMCPClient.get_tools() intentionally creates a new MCP session
    # for every tool invocation, which breaks browser continuity (e.g.
    # open_url -> get_page_context resetting to about:blank in isolated mode).
    # We instead pin one session for the whole agent_tools() context.
    client = MultiServerMCPClient({profile: {"url": url, "transport": "sse"}})
    session_manager = None
    session = None
    try:
        tool_load_timeout = max(1, int(settings.tool_timeout_seconds))
        try:
            if hasattr(client, "session"):
                session_manager = client.session(profile)
                session = await asyncio.wait_for(
                    session_manager.__aenter__(),
                    timeout=tool_load_timeout,
                )
                await asyncio.wait_for(session.initialize(), timeout=tool_load_timeout)
                tools = await asyncio.wait_for(
                    load_mcp_tools(session, server_name=profile),
                    timeout=tool_load_timeout,
                )
            else:
                # Compatibility path for tests or adapter shims that only expose
                # get_tools(). Real runtime should use the session path above.
                tools = await asyncio.wait_for(client.get_tools(), timeout=tool_load_timeout)
        except asyncio.TimeoutError:
            message = (
                f"Timed out loading MCP tools for profile '{profile}' after {tool_load_timeout}s"
            )
            if observer is not None:
                observer.emit(
                    "tool_session_failed",
                    message,
                    status="error",
                    details={"profile": profile, "timeout_seconds": tool_load_timeout},
                )
            raise RuntimeError(message) from None

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
        # Apply per-profile disabled tool list from settings
        disabled = _disabled_tools_for_profile(settings, profile)
        if disabled:
            tools = [t for t in tools if t.name not in disabled]
            logger.info(
                "MCP profile '%s' filtered out disabled tools: %s", profile, sorted(disabled)
            )

        tool_names = [t.name for t in tools]
        missing_after_filter = sorted(REQUIRED_TOOLS_BY_PROFILE[profile] - set(tool_names))
        if missing_after_filter:
            if observer is not None:
                observer.emit(
                    "tool_session_failed",
                    f"MCP profile '{profile}' disabled required tools",
                    status="error",
                    details={
                        "profile": profile,
                        "disabled_tools": sorted(disabled),
                        "missing_tools": missing_after_filter,
                    },
                )
            raise RuntimeError(
                f"MCP profile '{profile}' disabled required tools: {', '.join(missing_after_filter)}"
            )

        # Plan task 18 phase 2: register the backend agentic memory_search
        # tool on every profile. It talks straight to the pgvector site_hints
        # store (no MCP round-trip), replacing the old per-turn memory stuffing.
        if bool(getattr(settings, "memory_enabled", True)):
            from src.memory.agentic_tool import build_memory_search_tool

            tools = [*tools, build_memory_search_tool()]

        tool_names = [t.name for t in tools]

        logger.info("MCP profile '%s' loaded %d tools: %s", profile, len(tools), tool_names)
        if observer is not None:
            observer.emit(
                "tool_session_ready",
                f"MCP profile '{profile}' loaded {len(tool_names)} tools",
                details={
                    "profile": profile,
                    "tool_names": tool_names,
                    "tool_count": len(tool_names),
                },
            )
        yield tools
    finally:
        if session_manager is not None:
            try:
                await session_manager.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001
                pass
        else:
            # Best-effort cleanup for compatibility path that may have created
            # internal sessions.
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
