"""Browser lifecycle helpers: launch, connect, health check."""

from __future__ import annotations

import subprocess
import time
from typing import Any

import httpx

from src.utils.logging import get_logger

logger = get_logger(__name__)


def health_check(cdp_url: str = "http://localhost:9222", retries: int = 5, delay: float = 1.0) -> bool:
    """Return True if the browser's /json/version endpoint is reachable."""
    for attempt in range(1, retries + 1):
        try:
            resp = httpx.get(f"{cdp_url}/json/version", timeout=3.0)
            if resp.status_code == 200:
                logger.info("Browser health check passed (attempt %d)", attempt)
                return True
        except httpx.RequestError:
            pass
        if attempt < retries:
            time.sleep(delay)
    logger.error("Browser health check failed after %d attempts", retries)
    return False


def get_ws_endpoint(cdp_url: str = "http://localhost:9222") -> str:
    """Fetch the WebSocket debugger URL from the browser."""
    resp = httpx.get(f"{cdp_url}/json/version", timeout=5.0)
    resp.raise_for_status()
    return resp.json()["webSocketDebuggerUrl"]


def launch_chrome(port: int = 9222) -> subprocess.Popen:
    """Launch a local headless Chrome process. Returns the Popen handle."""
    cmd = [
        "google-chrome",
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        f"--remote-debugging-port={port}",
    ]
    logger.info("Launching headless Chrome on port %d", port)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5)  # give Chrome a moment to start
    return proc
