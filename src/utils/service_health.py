"""Dependency health helpers for the API surface."""

from __future__ import annotations

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


def probe_browser(ws_endpoint: str) -> dict:
    """Return browser reachability and metadata without raising."""
    base_url = cdp_http_url_from_ws_endpoint(ws_endpoint)
    probe_url = f"{base_url}/json/version"

    try:
        response = httpx.get(probe_url, timeout=3.0)
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
