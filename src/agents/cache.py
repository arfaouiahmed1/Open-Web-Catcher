"""Cache helpers extracted from the agent loop.

ToolResultCache — in-process tool-result deduplication cache.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from typing import Any

from src.utils.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Helpers shared by both cache classes
# ---------------------------------------------------------------------------

def _to_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _parse_duration_seconds(value: Any) -> int:
    text = str(value or "").strip().lower()
    if not text:
        return 0
    if text.isdigit():
        return int(text)
    match = re.fullmatch(r"([0-9]+)\s*([smhd])", text)
    if not match:
        return 0
    amount = int(match.group(1))
    unit = match.group(2)
    return amount * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]


def _parse_expire_epoch(expire_time: str) -> float | None:
    text = str(expire_time or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        return datetime.fromisoformat(text).astimezone(UTC).timestamp()
    except ValueError:
        return None


# ---------------------------------------------------------------------------

_CACHE_ELIGIBLE_TOOLS = frozenset({
    "inspect",
    "screenshot",
    "get_page_context",
    "query_elements",
    "get_element_detail",
    "get_frame_tree",
    "get_media_state",
})
_STATE_MUTATING_TOOLS = frozenset({
    "navigate",
    "interact",
})


def _tool_cache_key(tool_name: str, tool_args: dict[str, Any], generation: int) -> str:
    payload = json.dumps(tool_args or {}, sort_keys=True, default=str)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"{generation}:{tool_name}:{digest}"


def _is_state_mutating_tool(tool_name: str) -> bool:
    return tool_name in _STATE_MUTATING_TOOLS


class ToolResultCache:
    """Per-agent-run tool result deduplication cache.

    A result is promoted to "cached" only after `min_identical_observations`
    consecutive identical executions. This guards against non-deterministic
    tools being served stale data.
    """

    def __init__(self, min_identical_observations: int = 2) -> None:
        self._min_obs = max(min_identical_observations, 2)
        self._store: dict[str, dict[str, Any]] = {}
        self._generation = 0
        self.hits = 0
        self.misses = 0
        self.bypasses = 0
        self.writes = 0
        self.invalidations = 0
        self.last_invalidation_reason = ""

    def is_eligible(self, tool_name: str) -> bool:
        return tool_name in _CACHE_ELIGIBLE_TOOLS

    @property
    def generation(self) -> int:
        return self._generation

    def invalidate(self, reason: str = "state_changed") -> None:
        self._generation += 1
        self.invalidations += 1
        self.last_invalidation_reason = str(reason or "state_changed")

    def get(self, tool_name: str, tool_args: dict[str, Any]) -> tuple[str | None, str]:
        """Return ``(cached_result, status)`` for the current page-state generation."""
        key = _tool_cache_key(tool_name, tool_args, self._generation)
        entry = self._store.get(key)
        if entry is None:
            self.misses += 1
            return None, "miss"
        if not entry.get("cached_result"):
            self.bypasses += 1
            return None, "unstable"
        if int(entry.get("stable_observations", 0)) < self._min_obs:
            self.bypasses += 1
            return None, "below_threshold"
        self.hits += 1
        return str(entry["cached_result"]), "hit"

    def update(self, tool_name: str, tool_args: dict[str, Any], result: str) -> None:
        """Record a live execution result; promote to cache when stable."""
        key = _tool_cache_key(tool_name, tool_args, self._generation)
        entry = self._store.get(key)
        if entry is None:
            self._store[key] = {
                "last_output": result,
                "stable_observations": 1,
                "cached_result": "",
                "generation": self._generation,
            }
        else:
            if result == entry.get("last_output"):
                entry["stable_observations"] = int(entry.get("stable_observations", 0)) + 1
            else:
                entry["last_output"] = result
                entry["stable_observations"] = 1
                entry["cached_result"] = ""

            entry = self._store[key]
            if int(entry.get("stable_observations", 0)) >= self._min_obs:
                if entry.get("cached_result") != result:
                    self.writes += 1
                entry["cached_result"] = result
                entry["last_output"] = result
