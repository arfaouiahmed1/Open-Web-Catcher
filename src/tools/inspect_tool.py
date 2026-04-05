"""InspectTool: DOM scan + element extraction + screenshot."""

from __future__ import annotations

from typing import Any

from langchain_core.tools import BaseTool
from pydantic import Field

from src.tools.bridge import JSToolBridge


class InspectTool(BaseTool):
    name: str = "inspect"
    description: str = (
        "Scan the current page DOM. Returns visible elements (links, buttons, iframes, "
        "video tags), page title, and an optional screenshot URL. "
        "Use this to understand what is on the page before deciding what to do next."
    )
    bridge: JSToolBridge = Field(exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        selector: str = "body",
        include_screenshot: bool = True,
        **kwargs: Any,
    ) -> dict[str, Any]:
        return self.bridge.call("inspect", {
            "selector": selector,
            "includeScreenshot": include_screenshot,
        })

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError("Use sync _run")
