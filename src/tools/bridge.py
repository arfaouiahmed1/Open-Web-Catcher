"""JSToolBridge: runs Node.js tools as subprocesses and parses their JSON output."""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path
from typing import Any

from src.utils.logging import get_logger

logger = get_logger(__name__)

TOOLS_DIR = Path(__file__).parent.parent.parent / "tools_js"


class JSToolBridge:
    """Calls a Node.js tool script, passing params as a JSON CLI argument.

    Each JS tool expects:
        node <tool>.js '<json_payload>'

    And writes a JSON object to stdout.
    """

    def __init__(self, browser_ws_endpoint: str, timeout: int = 30) -> None:
        self.browser_ws_endpoint = browser_ws_endpoint
        self.timeout = timeout

    def call(self, tool_name: str, params: dict[str, Any]) -> dict[str, Any]:
        """Execute a JS tool and return its parsed JSON output.

        Args:
            tool_name: Script name without extension (e.g. "inspect").
            params: Tool-specific parameters merged with browserWSEndpoint.

        Returns:
            Parsed JSON dict from the tool's stdout.

        Raises:
            RuntimeError: If the subprocess fails or output is not valid JSON.
        """
        script = TOOLS_DIR / f"{tool_name}.js"
        if not script.exists():
            raise FileNotFoundError(f"JS tool not found: {script}")

        payload = {"browserWSEndpoint": self.browser_ws_endpoint, **params}
        payload_json = json.dumps(payload)

        start = time.perf_counter()
        try:
            result = subprocess.run(
                ["node", str(script), payload_json],
                capture_output=True,
                text=True,
                timeout=self.timeout,
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
