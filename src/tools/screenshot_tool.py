"""ScreenshotTool: quick screenshot capture + Cloudinary upload."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from langchain_core.tools import BaseTool
from pydantic import Field

from src.tools.bridge import JSToolBridge


class ScreenshotTool(BaseTool):
    name: str = "screenshot"
    description: str = (
        "Take a screenshot of the current page (full page or viewport) and upload it to Cloudinary. "
        "Returns the public Cloudinary URL for use as image context in subsequent LLM calls."
    )
    bridge: JSToolBridge = Field(exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        mode: Literal["full", "viewport", "player", "element"] = "viewport",
        selector: str = "",
        **kwargs: Any,
    ) -> dict[str, Any]:
        resolved_mode = "element" if mode == "player" else mode
        params: dict[str, Any] = {"mode": resolved_mode}
        if selector:
            params["selector"] = selector
        return self.bridge.call("screenshot", params)

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._run, *args, **kwargs)
