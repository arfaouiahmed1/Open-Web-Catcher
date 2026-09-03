"""Tool execution, budget accounting, caching, and envelope normalization.

Provides:
- ToolResultCache: Page-state-aware cache for read-only tools (inspect, screenshot)
- execute_tool_call: Execution handler with timeout, budget, and one-mutating-call policy
- normalize_tool_result: Parse v2 envelope, build EvidenceRef objects, preserve wire contracts
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any

from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool

from src.models.evidence import EvidenceRef
from src.utils.logging import get_logger

logger = get_logger(__name__)
READONLY_TOOLS = {
    "inspect",
    "screenshot",
    "wait",
    "harvest",
    "memory_search",
    "plan",
}
MUTATING_TOOLS = {
    "navigate",
    "interact",
}


class ToolResultCache:
    """Page-state-aware cache for read-only browser tools.

    Keys entries by (tool_name, args_hash, page_state_id).
    Invalidated whenever a mutating tool (navigate, interact) executes successfully.
    """

    def __init__(
        self, max_size: int = 64, min_identical_observations: int = 2, **kwargs: Any
    ) -> None:
        self.max_size = max_size
        self._min_obs = max(min_identical_observations, 2)
        self._cache: dict[str, str] = {}
        self._current_page_state_id: str = ""
        self._generation: int = 0
        self.invalidations: int = 0
        self.last_invalidation_reason: str = ""
    @property
    def generation(self) -> int:
        return self._generation

    def update_page_state(self, page_state_id: str) -> None:
        """Update current page state; invalidates cache if page state changed."""
        if page_state_id and page_state_id != self._current_page_state_id:
            self.invalidate(reason="page_state_changed")
            self._current_page_state_id = page_state_id

    def update(self, tool_name: str, args: dict[str, Any], result: str) -> None:
        """Alias for put() matching legacy ToolResultCache callers."""
        self.put(tool_name, args, result)

    def invalidate(self, reason: str = "") -> None:
        """Clear all cached entries."""
        self._cache.clear()
        self._generation += 1
        self.invalidations += 1
        self.last_invalidation_reason = reason

    def is_eligible(self, tool_name: str) -> bool:
        return tool_name in READONLY_TOOLS

    def _make_key(self, tool_name: str, args: dict[str, Any]) -> str:
        serialized_args = json.dumps(args, sort_keys=True, default=str)
        args_hash = hashlib.sha256(serialized_args.encode("utf-8")).hexdigest()[:12]
        return f"{tool_name}::{args_hash}::{self._current_page_state_id}"

    def get(self, tool_name: str, args: dict[str, Any]) -> tuple[str | None, str]:
        if not self.is_eligible(tool_name):
            return None, "ineligible"
        key = self._make_key(tool_name, args)
        if key in self._cache:
            return self._cache[key], "hit"
        return None, "miss"

    def put(self, tool_name: str, args: dict[str, Any], result: str) -> None:
        if not self.is_eligible(tool_name):
            return
        if len(self._cache) >= self.max_size:
            # Evict oldest entry
            first_key = next(iter(self._cache))
            del self._cache[first_key]
        key = self._make_key(tool_name, args)
        self._cache[key] = result


def serialize_tool_output(value: Any) -> str:
    """Convert tool return value to JSON string."""
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value, ensure_ascii=False)
        except Exception:
            return str(value)
    return str(value or "")


async def invoke_tool_with_timeout(
    tool: BaseTool,
    args: dict[str, Any],
    timeout_seconds: float = 30.0,
) -> tuple[str, bool]:
    """Invoke a LangChain tool with an explicit timeout.

    Returns (output_str, is_error).
    """
    try:
        if hasattr(tool, "ainvoke"):
            raw = await asyncio.wait_for(tool.ainvoke(args), timeout=timeout_seconds)
        else:
            coro = asyncio.to_thread(tool.invoke, args)
            raw = await asyncio.wait_for(coro, timeout=timeout_seconds)
        return serialize_tool_output(raw), False
    except TimeoutError:
        err = json.dumps({"error": f"Tool '{tool.name}' timed out after {timeout_seconds}s"})
        return err, True
    except Exception as exc:
        logger.warning("Tool '%s' raised an exception: %s", tool.name, exc)
        err = json.dumps({"error": str(exc)})
        return err, True


def normalize_envelope_evidence(
    raw_output: str,
    tool_call_id: str,
) -> list[EvidenceRef]:
    """Parse v2 envelope from raw output and extract EvidenceRef instances."""
    evidence_refs: list[EvidenceRef] = []
    try:
        data = json.loads(raw_output)
    except Exception:
        return evidence_refs

    if not isinstance(data, dict):
        return evidence_refs

    page_state = data.get("page_state") or {}
    page_state_id = str(page_state.get("id") or "")
    proof = data.get("proof") or {}

    before_ref = proof.get("before_screenshot_ref")
    if before_ref and str(before_ref).startswith("blobref:"):
        evidence_refs.append(
            EvidenceRef(
                kind="screenshot",
                tool_call_id=tool_call_id,
                page_state_id=page_state_id,
                ref=str(before_ref),
                summary="Before-action viewport screenshot",
            )
        )

    after_ref = proof.get("after_screenshot_ref")
    if after_ref and str(after_ref).startswith("blobref:"):
        evidence_refs.append(
            EvidenceRef(
                kind="screenshot",
                tool_call_id=tool_call_id,
                page_state_id=page_state_id,
                ref=str(after_ref),
                summary="After-action viewport screenshot",
            )
        )

    network_evidence = proof.get("network_evidence")
    if isinstance(network_evidence, list):
        for entry in network_evidence:
            if isinstance(entry, dict) and entry.get("url"):
                evidence_refs.append(
                    EvidenceRef(
                        kind="network_entry",
                        tool_call_id=tool_call_id,
                        page_state_id=page_state_id,
                        ref=str(entry["url"]),
                        summary=f"Stream network entry: {entry.get('protocol', 'unknown')}",
                    )
                )

    return evidence_refs


def build_rejected_tool_message(
    tool_call_id: str,
    tool_name: str,
    reason: str,
) -> ToolMessage:
    """Build a ToolMessage for a rejected tool call to maintain message symmetry."""
    return ToolMessage(
        content=json.dumps({"error": reason, "ok": False, "tool": tool_name}),
        tool_call_id=tool_call_id,
        name=tool_name,
    )
