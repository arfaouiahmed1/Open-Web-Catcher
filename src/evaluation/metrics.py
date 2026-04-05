"""MetricsCollector: tokens, timing, success rates, failure modes."""

from __future__ import annotations

import time
from collections import defaultdict
from typing import Any

from langchain_core.callbacks import BaseCallbackHandler

from src.utils.logging import get_logger

logger = get_logger(__name__)


class MetricsCallbackHandler(BaseCallbackHandler):
    """LangChain callback that collects token usage and timing per run."""

    def __init__(self) -> None:
        super().__init__()
        self.tokens_in: int = 0
        self.tokens_out: int = 0
        self.tool_calls: int = 0
        self.tool_durations: list[float] = []
        self._tool_start: float | None = None

    def on_llm_end(self, response: Any, **kwargs: Any) -> None:
        usage = getattr(response, "llm_output", {}) or {}
        token_usage = usage.get("token_usage", {})
        self.tokens_in += token_usage.get("prompt_tokens", 0)
        self.tokens_out += token_usage.get("completion_tokens", 0)

    def on_tool_start(self, *args: Any, **kwargs: Any) -> None:
        self._tool_start = time.perf_counter()
        self.tool_calls += 1

    def on_tool_end(self, *args: Any, **kwargs: Any) -> None:
        if self._tool_start is not None:
            self.tool_durations.append(time.perf_counter() - self._tool_start)
            self._tool_start = None


class MetricsCollector:
    """Aggregate metrics across multiple runs."""

    def __init__(self) -> None:
        self._runs: list[dict[str, Any]] = []

    def record(self, run_id: str, metrics: dict[str, Any]) -> None:
        self._runs.append({"run_id": run_id, **metrics})
        logger.debug("Metrics recorded for run %s", run_id)

    def summary(self) -> dict[str, Any]:
        if not self._runs:
            return {}
        total = len(self._runs)
        successes = sum(1 for r in self._runs if r.get("success"))
        return {
            "total_runs": total,
            "success_rate": successes / total,
            "avg_tokens_in": sum(r.get("tokens_in", 0) for r in self._runs) / total,
            "avg_tokens_out": sum(r.get("tokens_out", 0) for r in self._runs) / total,
            "avg_tool_calls": sum(r.get("tool_calls", 0) for r in self._runs) / total,
            "failure_modes": self._count_failure_modes(),
        }

    def _count_failure_modes(self) -> dict[str, int]:
        counts: dict[str, int] = defaultdict(int)
        for r in self._runs:
            fm = r.get("failure_mode", "")
            if fm:
                counts[fm] += 1
        return dict(counts)

    def to_list(self) -> list[dict[str, Any]]:
        return list(self._runs)
