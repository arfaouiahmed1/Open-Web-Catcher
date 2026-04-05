"""Runtime observability helpers for agent events, metrics, and LangSmith status."""

from __future__ import annotations

import os
from collections import OrderedDict
from datetime import datetime
from threading import Lock
from typing import Any

from pydantic import BaseModel, Field

from src.models.enums import AgentType
from src.models.schemas import RunMetrics
from src.utils.config import Settings
from src.utils.langsmith import (
    is_self_hosted_langsmith,
    resolve_langsmith_api_key,
    resolve_langsmith_endpoint,
    resolve_langsmith_project,
    resolve_langsmith_tracing,
    resolve_langsmith_ui_url,
)


class RuntimeEvent(BaseModel):
    seq: int
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    actor: str
    kind: str
    message: str
    status: str = "info"
    details: dict[str, Any] = Field(default_factory=dict)


class LangSmithStatus(BaseModel):
    enabled: bool
    api_key_configured: bool
    project: str
    endpoint: str
    ui_url: str
    deployment: str
    tracing_env: str
    warnings: list[str] = Field(default_factory=list)


class RunTrace(BaseModel):
    run_id: str
    root_actor: str
    started_at: datetime
    finished_at: datetime | None = None
    events: list[RuntimeEvent] = Field(default_factory=list)
    metrics: RunMetrics | None = None
    langsmith: LangSmithStatus
    completed: bool = False


class _RunState:
    def __init__(self, run_id: str, root_actor: str, langsmith: LangSmithStatus) -> None:
        self.run_id = run_id
        self.root_actor = root_actor
        self.langsmith = langsmith
        self.started_at = datetime.utcnow()
        self.finished_at: datetime | None = None
        self.events: list[RuntimeEvent] = []
        self.metrics = RunMetrics(run_id=run_id, url="")
        self.completed = False
        self._next_seq = 1
        self._lock = Lock()

    def snapshot(self) -> RunTrace:
        with self._lock:
            return RunTrace(
                run_id=self.run_id,
                root_actor=self.root_actor,
                started_at=self.started_at,
                finished_at=self.finished_at,
                events=list(self.events),
                metrics=self.metrics.model_copy(deep=True),
                langsmith=self.langsmith,
                completed=self.completed,
            )


class RunObserver:
    def __init__(self, state: _RunState, actor: str) -> None:
        self._state = state
        self.actor = actor

    @property
    def run_id(self) -> str:
        return self._state.run_id

    def child(self, actor: str, agent_type: AgentType | None = None) -> "RunObserver":
        child = RunObserver(self._state, actor)
        if agent_type is not None:
            child.mark_agent(agent_type)
        return child

    def set_url(self, url: str) -> None:
        with self._state._lock:
            self._state.metrics.url = url

    def mark_agent(self, agent_type: AgentType) -> None:
        with self._state._lock:
            agents = self._state.metrics.agents_invoked
            if agent_type not in agents:
                agents.append(agent_type)

    def emit(
        self,
        kind: str,
        message: str,
        *,
        status: str = "info",
        details: dict[str, Any] | None = None,
    ) -> RuntimeEvent:
        with self._state._lock:
            event = RuntimeEvent(
                seq=self._state._next_seq,
                actor=self.actor,
                kind=kind,
                message=message,
                status=status,
                details=details or {},
            )
            self._state._next_seq += 1
            self._state.events.append(event)
            return event

    def add_llm_usage(self, usage: Any) -> None:
        if not usage:
            return
        usage_dict = usage if isinstance(usage, dict) else getattr(usage, "__dict__", {})
        input_tokens = (
            usage_dict.get("input_tokens")
            or usage_dict.get("prompt_tokens")
            or usage_dict.get("input_token_count")
            or usage_dict.get("prompt_token_count")
            or 0
        )
        output_tokens = (
            usage_dict.get("output_tokens")
            or usage_dict.get("completion_tokens")
            or usage_dict.get("candidates_token_count")
            or usage_dict.get("output_token_count")
            or 0
        )
        with self._state._lock:
            self._state.metrics.total_tokens_in += int(input_tokens)
            self._state.metrics.total_tokens_out += int(output_tokens)

    def increment_tool_calls(self, count: int = 1) -> None:
        with self._state._lock:
            self._state.metrics.total_tool_calls += count

    def finish(
        self,
        *,
        success: bool,
        failure_mode: str = "",
    ) -> None:
        with self._state._lock:
            self._state.finished_at = datetime.utcnow()
            self._state.completed = True
            self._state.metrics.finished_at = self._state.finished_at
            self._state.metrics.total_duration_seconds = (
                self._state.finished_at - self._state.started_at
            ).total_seconds()
            self._state.metrics.success = success
            self._state.metrics.failure_mode = failure_mode

    def trace(self) -> RunTrace:
        return self._state.snapshot()

    def events_since(self, seq: int) -> list[RuntimeEvent]:
        with self._state._lock:
            return [event for event in self._state.events if event.seq > seq]


class RunRegistry:
    def __init__(self, max_runs: int = 100) -> None:
        self._max_runs = max_runs
        self._runs: OrderedDict[str, _RunState] = OrderedDict()
        self._lock = Lock()

    def create(self, run_id: str, root_actor: str, langsmith: LangSmithStatus) -> RunObserver:
        with self._lock:
            state = _RunState(run_id=run_id, root_actor=root_actor, langsmith=langsmith)
            self._runs[run_id] = state
            self._runs.move_to_end(run_id)
            while len(self._runs) > self._max_runs:
                self._runs.popitem(last=False)
            return RunObserver(state, root_actor)

    def get(self, run_id: str) -> RunTrace | None:
        with self._lock:
            state = self._runs.get(run_id)
        return state.snapshot() if state else None

    def list_recent(self, limit: int = 20) -> list[RunTrace]:
        with self._lock:
            states = list(self._runs.values())[-limit:]
        return [state.snapshot() for state in reversed(states)]


def get_langsmith_status(settings: Settings) -> LangSmithStatus:
    enabled = resolve_langsmith_tracing(settings)
    tracing_env = "true" if enabled else "false"
    api_key = resolve_langsmith_api_key(settings)
    endpoint = resolve_langsmith_endpoint(settings)
    ui_url = resolve_langsmith_ui_url(settings)
    project = resolve_langsmith_project(settings)
    deployment = "self-hosted" if is_self_hosted_langsmith(settings) else "cloud"
    warnings: list[str] = []
    if enabled and not api_key:
        warnings.append("Tracing is enabled but LANGSMITH_API_KEY / LANGCHAIN_API_KEY is missing.")
    if enabled and not project:
        warnings.append("Tracing is enabled but no LangSmith project is configured.")
    if enabled and not ui_url:
        warnings.append("Tracing is enabled but no LangSmith UI URL could be derived.")
    return LangSmithStatus(
        enabled=enabled,
        api_key_configured=bool(api_key),
        project=project,
        endpoint=endpoint,
        ui_url=ui_url,
        deployment=deployment,
        tracing_env=tracing_env,
        warnings=warnings,
    )


run_registry = RunRegistry()
