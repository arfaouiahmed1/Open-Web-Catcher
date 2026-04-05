"""HarvestTool: 6-layer CDP stream detection."""

from __future__ import annotations

from typing import Any

from langchain_core.tools import BaseTool
from pydantic import Field

from src.tools.bridge import JSToolBridge


class HarvestTool(BaseTool):
    name: str = "harvest"
    description: str = (
        "Run 6-layer CDP stream detection to find streaming URLs (HLS, DASH, MP4, etc.) "
        "on the current page. Layers: network intercept, XHR/fetch intercept, "
        "source element scan, iframe traversal, service worker intercept, memory scan. "
        "Returns a list of discovered stream URLs with protocol and quality metadata."
    )
    bridge: JSToolBridge = Field(exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        wait_seconds: int = 5,
        include_iframes: bool = True,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return self.bridge.call("harvest", {
            "waitSeconds": wait_seconds,
            "includeIframes": include_iframes,
        })

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError("Use sync _run")
