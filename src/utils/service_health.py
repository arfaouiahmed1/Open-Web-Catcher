"""Dependency health helpers for the API surface."""

from __future__ import annotations

from typing import Any, Iterable
from urllib.parse import urlparse

import httpx


def cdp_http_url_from_ws_endpoint(ws_endpoint: str) -> str:
    """Convert a DevTools websocket endpoint into the base HTTP CDP URL."""
    parsed = urlparse(ws_endpoint)
    if parsed.scheme not in {"ws", "wss", "http", "https"}:
        return "http://localhost:9222"

    http_scheme = "https" if parsed.scheme in {"wss", "https"} else "http"
    netloc = parsed.netloc or parsed.path
    return f"{http_scheme}://{netloc}"


def _cdp_probe_headers(base_url: str) -> dict[str, str]:
    """Use a loopback Host header when CDP is reached through the sidecar proxy.

    Chromium rejects non-local ``Host`` headers for the DevTools HTTP endpoint.
    The Playwright sidecar deliberately keeps Chrome on 127.0.0.1 and forwards
    compose traffic through port 9224, so a peer request otherwise returns 500.
    """
    hostname = (urlparse(base_url).hostname or "").lower()
    if hostname not in {"localhost", "127.0.0.1", "::1"}:
        return {"Host": "127.0.0.1"}
    return {}


def probe_browser(ws_endpoint: str) -> dict:
    """Return browser reachability and metadata without raising."""
    base_url = cdp_http_url_from_ws_endpoint(ws_endpoint)
    probe_url = f"{base_url}/json/version"

    try:
        response = httpx.get(
            probe_url,
            headers=_cdp_probe_headers(base_url),
            timeout=3.0,
        )
        response.raise_for_status()
        payload = response.json()
        return {
            "healthy": True,
            "configured_ws_endpoint": ws_endpoint,
            "probe_url": probe_url,
            "reported_ws_endpoint": payload.get("webSocketDebuggerUrl", ""),
            "browser": payload.get("Browser", ""),
        }
    except Exception as exc:
        return {
            "healthy": False,
            "configured_ws_endpoint": ws_endpoint,
            "probe_url": probe_url,
            "error": str(exc),
        }


def probe_mcp(base_url: str) -> dict:
    """Return MCP server reachability and metadata without raising."""
    probe_url = f"{base_url.rstrip('/')}/health"
    try:
        response = httpx.get(probe_url, timeout=3.0)
        response.raise_for_status()
        payload = response.json()
        payload["healthy"] = True
        payload["probe_url"] = probe_url
        return payload
    except Exception as exc:
        return {
            "healthy": False,
            "probe_url": probe_url,
            "error": str(exc),
        }


def build_tool_profile_statuses(
    mcp_status: dict[str, Any],
    required_profiles: Iterable[str],
) -> list[dict[str, Any]]:
    """Summarize MCP profile availability for launcher/runtime preflight."""
    profiles_reported = isinstance(mcp_status.get("profiles"), list)
    advertised = {
        str(profile).strip().lower()
        for profile in (mcp_status.get("profiles") or [])
        if str(profile).strip()
    }
    mcp_healthy = bool(mcp_status.get("healthy"))
    rows: list[dict[str, Any]] = []
    for profile in required_profiles:
        normalized = str(profile).strip().lower()
        available = True if not profiles_reported else normalized in advertised
        rows.append(
            {
                "profile": normalized,
                "available": available,
                "healthy": mcp_healthy and available,
                "status": "ready" if (mcp_healthy and available) else "missing",
            }
        )
    return rows


def build_runtime_preflight(
    browser_status: dict[str, Any],
    mcp_status: dict[str, Any],
    *,
    required_profiles: Iterable[str] = (),
    require_browser: bool = True,
) -> dict[str, Any]:
    """Build a launcher-friendly runtime readiness summary."""
    profile_statuses = build_tool_profile_statuses(mcp_status, required_profiles)
    blocking_reasons: list[dict[str, Any]] = []

    if not mcp_status.get("healthy"):
        blocking_reasons.append(
            {
                "kind": "mcp_unhealthy",
                "message": "MCP server is unavailable.",
                "endpoint": mcp_status.get("probe_url") or "",
                "error": mcp_status.get("error") or "",
            }
        )

    if require_browser and not browser_status.get("healthy"):
        blocking_reasons.append(
            {
                "kind": "browser_unhealthy",
                "message": "Browser endpoint is unavailable.",
                "endpoint": browser_status.get("probe_url")
                or browser_status.get("configured_ws_endpoint")
                or "",
                "error": browser_status.get("error") or "",
            }
        )

    for profile in profile_statuses:
        if profile["healthy"]:
            continue
        blocking_reasons.append(
            {
                "kind": "tool_profile_unavailable",
                "message": f"MCP profile '{profile['profile']}' is unavailable.",
                "profile": profile["profile"],
                "endpoint": mcp_status.get("probe_url") or "",
                "error": mcp_status.get("error") or "",
            }
        )

    launch_ready = not blocking_reasons
    return {
        "launch_ready": launch_ready,
        "status": "ready" if launch_ready else "blocked",
        "browser_required": require_browser,
        "profiles": profile_statuses,
        "blocking_reasons": blocking_reasons,
    }
