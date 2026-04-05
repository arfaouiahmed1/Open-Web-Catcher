"""InteractTool: click / play / type / select / coordinates + anti-bot evasion."""

from __future__ import annotations

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
        action: Literal["click", "play", "type", "select", "coordinates"] = "click",
        selector: str = "",
        value: str = "",
        x: float | None = None,
        y: float | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"action": action}
        if selector:
            params["selector"] = selector
        if value:
            params["value"] = value
        if x is not None:
            params["x"] = x
        if y is not None:
            params["y"] = y
        return self.bridge.call("interact", params)

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        raise NotImplementedError("Use sync _run")
