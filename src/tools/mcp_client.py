"""MCP client — loads tools for a specific agent profile from the MCP server.

Each agent profile maps to a Streamable HTTP endpoint on the MCP server:
    classification → /mcp/classification
    landing        → /mcp/landing
    hosting        → /mcp/hosting
    embedded       → /mcp/embedded

The MCP server runs with MCP_BROWSER_MODE=isolated; each browser scope gets
its own temporary browser instance keyed by (runId, profile, browserScopeId).
That browser is reused across tool calls for the lifetime of the agent session
and shut down automatically.

The MCP server enforces which tools are visible per profile according to the
authoritative browser-tool-manifest.json.

Usage (inside an async context):
    async with agent_tools("hosting", settings, target_url=url) as tool_session:
        result = await run_agent_loop(llm, tool_session.tools, ...)
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from langchain_core.tools import BaseTool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langchain_mcp_adapters.tools import load_mcp_tools

from src.utils.config import Settings
from src.utils.logging import get_logger

if TYPE_CHECKING:
    from src.utils.observability import RunObserver

logger = get_logger(__name__)

VALID_PROFILES = {"classification", "landing", "hosting", "embedded"}


def load_tool_manifest() -> dict[str, Any]:
    """Load the authoritative browser-tool manifest JSON."""
    base_dir = Path(__file__).resolve().parents[2]
    manifest_path = base_dir / "tools" / "shared" / "browser-tool-manifest.json"
    try:
        with open(manifest_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as exc:
        logger.warning("Could not load tool manifest from %s: %s", manifest_path, exc)
        return {"tools": []}


def get_profile_tools(profile: str, manifest: dict[str, Any] | None = None) -> set[str]:
    """Get required tool names for a profile from the manifest."""
    m = manifest if manifest is not None else load_tool_manifest()
    return {
        str(t["name"])
        for t in m.get("tools", [])
        if profile in t.get("profiles", [])
    }


REQUIRED_TOOLS_BY_PROFILE: dict[str, set[str]] = {
    profile: get_profile_tools(profile)
    for profile in ("classification", "landing", "hosting", "embedded")
}


@dataclass
class AgentToolSession:
    """Active tool session yielded by agent_tools context manager."""

    profile: str
    tools: list[BaseTool]
    manifest: dict[str, Any]
    session_id: str

    def __iter__(self):
        """Allow unpacking/iterating directly over tools for backward compat."""
        return iter(self.tools)

    def __len__(self) -> int:
        return len(self.tools)

    def __getitem__(self, idx: int) -> BaseTool:
        return self.tools[idx]


def derive_browser_scope_id(profile: str, target_url: str | None = None) -> str:
    """Derive a stable browser scope ID from profile and target URL."""
    url_candidate = str(target_url or "").strip()
    if not url_candidate:
        return f"{profile}:default"
    digest = hashlib.sha256(url_candidate.encode("utf-8")).hexdigest()[:16]
    return f"{profile}:{digest}"


@asynccontextmanager
async def agent_tools(
    profile: str,
    settings: Settings,
    observer: RunObserver | None = None,
    target_url: str | None = None,
    browser_scope_id: str | None = None,
) -> AsyncGenerator[AgentToolSession, None]:
    """Async context manager that yields an AgentToolSession for the given profile.

    Connects to the MCP server via Streamable HTTP (fallback to SSE if needed),
    verifies the tool set against browser-tool-manifest.json, and keeps the
    connection open for the duration of the agent loop. Disconnects on exit.

    Args:
        profile: One of classification | landing | hosting | embedded
        settings: Application settings
        observer: Optional run observer for telemetry events
        target_url: Optional workflow target URL for host jar binding
        browser_scope_id: Optional explicit scope ID; derived if not provided

    Yields:
        AgentToolSession instance (iterable as a list of BaseTool)
    """
    if profile not in VALID_PROFILES:
        raise ValueError(f"Unknown profile '{profile}'. Valid: {VALID_PROFILES}")

    scope_id = browser_scope_id or derive_browser_scope_id(profile, target_url)
    run_id = str(getattr(observer, "run_id", "") or "")

    # Build standard transport headers
    headers: dict[str, Any] = {
        "X-OWC-Run-Id": run_id,
        "X-OWC-Browser-Scope-Id": scope_id,
        "X-OWC-Target-Url": str(target_url or ""),
    }
    raw_token = getattr(settings, "mcp_bearer_token", "") or os.getenv("MCP_BEARER_TOKEN", "")
    bearer_token = str(raw_token).strip()
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"

    base_url = settings.mcp_server_url.rstrip("/")
    streamable_url = f"{base_url}/mcp/{profile}"

    logger.info(
        "Connecting to MCP profile '%s' at %s (scope: %s)", profile, streamable_url, scope_id
    )
    if observer is not None:
        observer.emit(
            "tool_session_connecting",
            f"Connecting MCP tool profile '{profile}'",
            details={"profile": profile, "url": streamable_url, "browser_scope_id": scope_id},
        )

    manifest = load_tool_manifest()
    expected_mcp_tools = {
        str(t["name"])
        for t in manifest.get("tools", [])
        if profile in t.get("profiles", []) and t.get("kind") == "mcp"
    }

    client = None
    session_manager = None
    session = None

    # Connect via Streamable HTTP; fall back to SSE if transport rejected by adapter
    try:
        connection: dict[str, Any] = {
            "url": streamable_url,
            "transport": "streamable_http",
            "headers": headers,
        }
        client = MultiServerMCPClient({profile: connection})
    except (ValueError, TypeError) as exc:
        logger.warning(
            "Streamable HTTP transport initialization failed (%s); falling back to SSE", exc
        )
        query_parts = []
        if run_id:
            query_parts.append(f"runId={quote(run_id, safe='')}")
        if target_url:
            query_parts.append(f"targetUrl={quote(target_url, safe='')}")
        query_str = f"?{'&'.join(query_parts)}" if query_parts else ""
        sse_url = f"{base_url}/mcp/{profile}/sse{query_str}"
        client = MultiServerMCPClient(
            {profile: {"url": sse_url, "transport": "sse", "headers": headers}}
        )
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
                tools = await asyncio.wait_for(client.get_tools(), timeout=tool_load_timeout)
        except TimeoutError:
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

        # Verify server list against manifest profile
        tool_names = {t.name for t in tools}
        missing_tools = sorted(expected_mcp_tools - tool_names)
        if missing_tools:
            logger.warning(
                "MCP profile '%s' server missing tools from manifest: %s",
                profile,
                missing_tools,
            )

        # Plan task 18: register backend agentic memory_search tool on all profiles
        if bool(getattr(settings, "memory_enabled", True)):
            try:
                from src.memory.agentic_tool import build_memory_search_tool
                tools = [*tools, build_memory_search_tool()]
            except Exception as exc:
                logger.warning("Could not append memory_search tool: %s", exc)

        # Plan step 5: register backend plan tool on landing, hosting, embedded profiles
        if profile in {"landing", "hosting", "embedded"}:
            try:
                from src.agents.runtime.tools_plan import build_plan_tool
                tools = [*tools, build_plan_tool()]
            except Exception as exc:
                logger.debug("Plan tool not appended (will be available after step 5): %s", exc)

        sid = (
            getattr(session, "session_id", None)
            or getattr(session_manager, "session_id", None)
            or scope_id
        )
        tool_session = AgentToolSession(
            profile=profile,
            tools=tools,
            manifest=manifest,
            session_id=str(sid),
        )

        all_names = [t.name for t in tools]
        logger.info(
            "MCP profile '%s' session ready with %d tools: %s", profile, len(tools), all_names
        )
        if observer is not None:
            observer.emit(
                "tool_session_ready",
                f"MCP profile '{profile}' loaded {len(all_names)} tools",
                details={"profile": profile, "tool_names": all_names, "tool_count": len(all_names)},
            )
        yield tool_session

    finally:
        if session_manager is not None:
            try:
                await session_manager.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001
                pass
        else:
            try:
                for s in getattr(client, "_sessions", {}).values():
                    try:
                        await s.__aexit__(None, None, None)
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
