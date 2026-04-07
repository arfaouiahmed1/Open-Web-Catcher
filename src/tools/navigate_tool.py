"""NavigateTool: URL navigation + redirect handling."""

from __future__ import annotations

import asyncio
from typing import Any

from langchain_core.tools import BaseTool
from pydantic import Field

from src.tools.bridge import JSToolBridge


class NavigateTool(BaseTool):
    name: str = "navigate"
    description: str = (
        "Navigate the browser to a URL. Handles redirects and waits for the page to load. "
        "Returns the final URL (after redirects), page title, and HTTP status."
    )
    bridge: JSToolBridge = Field(exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        url: str,
        wait_until: str = "networkidle2",
        timeout_ms: int = 30000,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return self.bridge.call("navigate", {
            "url": url,
            "wait_until": wait_until,
            "timeout_ms": timeout_ms,
        })

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._run, *args, **kwargs)
