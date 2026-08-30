"""JSToolBridge: runs JS tools through a generic Node CLI and parses JSON output."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Any

from src.utils.logging import get_logger

logger = get_logger(__name__)

PROJECT_TOOLS_ROOT = Path(__file__).parent.parent.parent / "tools"


def _resolve_tools_root(engine: str | None = None) -> Path:
    # Playwright-only since ADR-003: the puppeteer tool stack was removed.
    resolved_engine = str(engine or os.getenv("BROWSER_ENGINE") or "playwright").strip().lower()
    if resolved_engine != "playwright":
        resolved_engine = "playwright"
    return PROJECT_TOOLS_ROOT / resolved_engine


class JSToolBridge:
    """Calls the generic Node tool runner with a public tool name and JSON payload."""

    def __init__(
        self, browser_ws_endpoint: str, timeout: int = 30, engine: str | None = None
    ) -> None:
        self.browser_ws_endpoint = browser_ws_endpoint
        self.timeout = timeout
        self.engine = str(engine or os.getenv("BROWSER_ENGINE") or "playwright").strip().lower()

    def call(self, tool_name: str, params: dict[str, Any]) -> dict[str, Any]:
        """Execute a JS tool and return its parsed JSON output.

        Args:
            tool_name: Public tool name exposed by the JS registry / MCP server.
            params: Tool-specific parameters merged with browserWSEndpoint.

        Returns:
            Parsed JSON dict from the tool's stdout.

        Raises:
            RuntimeError: If the subprocess fails or output is not valid JSON.
        """
        tools_root = _resolve_tools_root(self.engine)
        runner_script = tools_root / "run-tool.js"
        if not runner_script.exists():
            raise FileNotFoundError(f"JS tool runner not found: {runner_script}")

        payload = {"browserWSEndpoint": self.browser_ws_endpoint, **params}
        payload_json = json.dumps(payload)

        start = time.perf_counter()
        try:
            result = subprocess.run(
                ["node", str(runner_script), tool_name, payload_json],
                capture_output=True,
                text=True,
                timeout=self.timeout,
                cwd=str(tools_root),
            )
        except subprocess.TimeoutExpired as e:
            raise RuntimeError(f"JS tool '{tool_name}' timed out after {self.timeout}s") from e

        duration = time.perf_counter() - start
        logger.debug("JS tool '%s' completed in %.2fs", tool_name, duration)

        if result.returncode != 0:
            raise RuntimeError(
                f"JS tool '{tool_name}' exited {result.returncode}: {result.stderr.strip()}"
            )

        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as e:
            raise RuntimeError(
                f"JS tool '{tool_name}' returned non-JSON output: {result.stdout[:200]}"
            ) from e
