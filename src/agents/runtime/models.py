"""Data models and policy state for the agent runtime.

Defines:
- AgentGraphState: LangGraph state structure
- AgentLoopResult: Aggregated result of an agent run
- AgentRuntimePolicy: Encodes role state machines and tool execution budgets
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from typing import Annotated, Any, Literal, TypedDict

from langchain_core.messages import BaseMessage
from langgraph.graph.message import add_messages

logger = logging.getLogger(__name__)


@dataclass
class AgentRuntimePolicy:
    """Encodes role state machines and execution budgets per agent profile."""

    role: Literal["classification", "landing", "hosting", "embedded"]
    max_tool_calls: int = 20
    continuation_threshold: float = 0.80
    max_continuations: int = 4
    repeated_tool_call_limit: int = 3
    one_mutating_tool_per_turn: bool = True
    allowed_tool_names: list[str] = field(default_factory=list)
    state_machine: list[str] = field(default_factory=list)

    @classmethod
    def for_role(
        cls,
        role: Literal["classification", "landing", "hosting", "embedded"],
        *,
        max_tool_calls: int = 20,
    ) -> AgentRuntimePolicy:
        """Construct standard policy for a given agent role."""
        machines = {
            "classification": [
                "navigate",
                "inspect",
                "interact_once",
                "inspect",
                "finish",
            ],
            "landing": [
                "inspect",
                "build_frontier",
                "explore",
                "reconcile",
                "finish_or_continue",
            ],
            "hosting": [
                "inspect",
                "build_frontier",
                "clear_blocker",
                "interact_play",
                "harvest",
                "record_proof",
                "next_or_handoff",
            ],
            "embedded": [
                "inspect",
                "build_frontier",
                "clear_blocker",
                "interact_play",
                "harvest",
                "record_proof",
                "next_or_finish",
            ],
        }
        return cls(
            role=role,
            max_tool_calls=max_tool_calls,
            state_machine=machines.get(role, []),
        )


class AgentGraphState(TypedDict):
    """LangGraph execution state passed through the agent loop."""

    messages: Annotated[list[BaseMessage], add_messages]
    tool_calls_made: int
    max_tool_calls: int
    budget_exhausted: bool
    stop_reason: str
    last_tool_batch_signature: str
    repeated_tool_batch_count: int
    no_progress_turn_count: int
    context_compaction_pending: bool
    context_usage_pct: float
    last_context_tokens: int
    continuation_index: int
    continuation_capsules: list[dict[str, Any]]
    last_low_specificity_query_signature: str
    repeated_low_specificity_query_count: int


class AgentLoopResult:
    """Aggregated output from run_agent_loop."""

    def __init__(
        self,
        final_text: str,
        tool_calls_made: int,
        messages: list[BaseMessage],
        *,
        bootstrap_tool_calls: int = 0,
        llm_tool_calls_made: int | None = None,
        stop_reason: str = "completed",
        budget_exhausted: bool = False,
        continuation_count: int = 0,
        continuation_capsules: list[dict[str, Any]] | None = None,
    ) -> None:
        self.final_text = final_text
        self.tool_calls_made = tool_calls_made
        self.bootstrap_tool_calls = bootstrap_tool_calls
        self.llm_tool_calls_made = (
            tool_calls_made - bootstrap_tool_calls
            if llm_tool_calls_made is None
            else llm_tool_calls_made
        )
        self.messages = messages
        self.stop_reason = stop_reason
        self.budget_exhausted = budget_exhausted
        self.parse_error = ""
        self.continuation_count = max(0, int(continuation_count or 0))
        self.continuation_capsules = list(continuation_capsules or [])

    def parse_json(self) -> dict[str, Any]:
        """Parse a JSON object from output text, including fenced JSON."""
        parsed, error = parse_json_object(self.final_text)
        self.parse_error = error
        if error:
            logger.warning("Could not parse agent output as JSON: %s", error)
        return parsed


def parse_json_object(text: str) -> tuple[dict[str, Any], str]:
    """Best-effort extraction of the first JSON object from LLM text."""
    raw = str(text or "").strip()
    if not raw:
        return {}, "empty_output"

    candidates = [raw]
    fenced = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", raw, flags=re.IGNORECASE | re.DOTALL)
    candidates.extend(item.strip() for item in fenced if item.strip())

    balanced = _extract_first_balanced_json_object(raw)
    if balanced:
        candidates.append(balanced)

    last_error = ""
    seen: set[str] = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        payload, error = _try_load_json_object_candidate(candidate)
        if error:
            last_error = error
            continue
        if isinstance(payload, dict):
            return payload, ""
        last_error = f"json_root_not_object:{type(payload).__name__}"
    return {}, last_error or "no_json_object_found"


def _try_load_json_object_candidate(candidate: str) -> tuple[Any, str]:
    """Load JSON, with a fallback for raw control characters in model output."""
    try:
        return json.loads(candidate), ""
    except json.JSONDecodeError as exc:
        first_error = f"json_decode_error:{exc.msg}"

    sanitized = re.sub(r"[\x00-\x1f]", "", candidate)
    if sanitized == candidate:
        return None, first_error
    try:
        return json.loads(sanitized), ""
    except json.JSONDecodeError as exc:
        return None, f"{first_error}; sanitized_json_decode_error:{exc.msg}"


def _extract_first_balanced_json_object(text: str) -> str:
    """Return the first balanced top-level JSON object substring, if present."""
    start = text.find("{")
    while start != -1:
        depth = 0
        in_string = False
        escape = False
        for index in range(start, len(text)):
            char = text[index]
            if in_string:
                if escape:
                    escape = False
                elif char == "\\":
                    escape = True
                elif char == '"':
                    in_string = False
                continue
            if char == '"':
                in_string = True
            elif char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
                if depth == 0:
                    return text[start : index + 1]
        start = text.find("{", start + 1)
    return ""
