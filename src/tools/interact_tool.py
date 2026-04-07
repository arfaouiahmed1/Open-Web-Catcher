"""InteractTool: click / play / type / select / coordinates + anti-bot evasion."""

from __future__ import annotations

import asyncio
from typing import Any, Literal

from langchain_core.tools import BaseTool
from pydantic import Field

from src.tools.bridge import JSToolBridge


class InteractTool(BaseTool):
    name: str = "interact"
    description: str = (
        "Interact with an element on the page. Actions: click, play, type, select, coordinates. "
        "Provide a CSS selector or (x, y) coordinates. Includes anti-bot evasion (human-like delays). "
        "Returns updated page state after the interaction."
    )
    bridge: JSToolBridge = Field(exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(
        self,
        action: Literal["click", "play", "type", "select", "coordinates", "check"] = "click",
        selector: str = "",
        xpath: str = "",
        text: str = "",
        value: str = "",
        option_text: str = "",
        x: float | None = None,
        y: float | None = None,
        wait_ms: int = 3000,
        **kwargs: Any,
    ) -> dict[str, Any]:
        mode = kwargs.pop("mode", action)
        params: dict[str, Any] = {"mode": mode, "wait_ms": wait_ms}
        if selector:
            params["selector"] = selector
        if xpath:
            params["xpath"] = xpath
        if text:
            params["text"] = text
        if value:
            params["value"] = value
        if option_text:
            params["option_text"] = option_text
        if x is not None:
            params["x"] = x
        if y is not None:
            params["y"] = y
        return self.bridge.call("interact", params)

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        return await asyncio.to_thread(self._run, *args, **kwargs)
