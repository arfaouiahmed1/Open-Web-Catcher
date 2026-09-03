"""Backend LangChain plan tool for managing working-state task lists.

Implements the plan tool contract (plan step 5):
- Operations: write (replace), append (add), complete (mark done), clear (empty)
- Max 12 items, each max 200 chars
- State stored in ShortTermMemory or session store as:
    list[{"id": int, "text": str, "status": "pending"|"done"}]
- Available in landing, hosting, embedded profiles
"""

from __future__ import annotations

import json
from typing import Any, Literal

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

_PLAN_DESCRIPTION = (
    "Manage a short ordered task list (max 12 items, 200 chars each) in working state. "
    "Supports: 'write' (replace), 'append' (add items), 'complete' (mark done by id), "
    "and 'clear' (empty list). The plan survives compaction and is recited in prompt context."
)

MAX_PLAN_ITEMS = 12
MAX_ITEM_CHARS = 200


class PlanInput(BaseModel):
    """Input schema for the plan tool."""

    op: Literal["write", "append", "complete", "clear"] = Field(
        ...,
        description="Operation: 'write' (replace full list), 'append' (add items), "
        "'complete' (mark item done by id), 'clear' (empty list).",
    )
    items: list[str] | None = Field(
        default=None,
        description="Task strings for 'write' or 'append' (max 12 items, max 200 chars each).",
    )
    item_id: int | None = Field(
        default=None,
        description="0-indexed ID of the item to mark as 'done' for 'complete'.",
    )


def build_plan_tool(working_memory: Any | None = None) -> StructuredTool:
    """Build the backend LangChain StructuredTool for plan management."""
    # Module-level fallback store when working_memory is not supplied
    _local_store: list[dict[str, Any]] = []

    def _get_items() -> list[dict[str, Any]]:
        if working_memory is not None and hasattr(working_memory, "working_state_data"):
            return working_memory.working_state_data.setdefault("plan_items", [])
        if working_memory is not None and hasattr(working_memory, "_plan_items"):
            return working_memory._plan_items
        return _local_store

    def _set_items(items: list[dict[str, Any]]) -> None:
        nonlocal _local_store
        if working_memory is not None and hasattr(working_memory, "working_state_data"):
            working_memory.working_state_data["plan_items"] = items
        elif working_memory is not None and hasattr(working_memory, "_plan_items"):
            working_memory._plan_items = items
        else:
            _local_store = items

    def _execute(
        op: str, items: list[str] | None = None, item_id: int | None = None
    ) -> dict[str, Any]:
        current = _get_items()

        if op == "clear":
            _set_items([])
            return {"ok": True, "op": "clear", "plan_items": []}

        if op == "write":
            raw_items = list(items or [])
            new_items = []
            for i, text in enumerate(raw_items[:MAX_PLAN_ITEMS]):
                cleaned = str(text or "").strip()[:MAX_ITEM_CHARS]
                if cleaned:
                    new_items.append({"id": i, "text": cleaned, "status": "pending"})
            _set_items(new_items)
            return {"ok": True, "op": "write", "plan_items": new_items}

        if op == "append":
            raw_items = list(items or [])
            existing = list(current)
            start_id = len(existing)
            for text in raw_items:
                if len(existing) >= MAX_PLAN_ITEMS:
                    break
                cleaned = str(text or "").strip()[:MAX_ITEM_CHARS]
                if cleaned:
                    existing.append({"id": start_id, "text": cleaned, "status": "pending"})
                    start_id += 1
            _set_items(existing)
            return {"ok": True, "op": "append", "plan_items": existing}

        if op == "complete":
            if item_id is None:
                return {"ok": False, "error": "item_id is required for complete operation"}
            existing = list(current)
            found = False
            for item in existing:
                if item.get("id") == item_id:
                    item["status"] = "done"
                    found = True
                    break
            if not found:
                return {"ok": False, "error": f"Item with id {item_id} not found in plan"}
            _set_items(existing)
            return {"ok": True, "op": "complete", "plan_items": existing}

        return {"ok": False, "error": f"Unknown operation: {op}"}

    def _sync_func(
        op: str, items: list[str] | None = None, item_id: int | None = None
    ) -> str:
        res = _execute(op, items, item_id)
        return json.dumps(res, ensure_ascii=False)

    async def _async_coro(
        op: str, items: list[str] | None = None, item_id: int | None = None
    ) -> str:
        return _sync_func(op, items, item_id)

    return StructuredTool.from_function(
        func=_sync_func,
        coroutine=_async_coro,
        name="plan",
        description=_PLAN_DESCRIPTION,
        args_schema=PlanInput,
    )
