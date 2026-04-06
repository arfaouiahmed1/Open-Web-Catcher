"""Runtime observability helpers for agent events, metrics, and tracing status."""

from __future__ import annotations

from collections import OrderedDict
from datetime import datetime
from threading import Lock
from typing import Any

from pydantic import BaseModel, Field

from src.models.enums import AgentType
from src.models.schemas import ModelUsage, RunMetrics
from src.utils.config import Settings
from src.utils.phoenix import (
    estimate_usage_cost,
    is_self_hosted_phoenix,
    resolve_model_pricing,
    resolve_phoenix_api_key,
    resolve_phoenix_base_url,
    resolve_phoenix_collector_endpoint,
    resolve_phoenix_default_dataset_name,
    resolve_phoenix_model_pricing,
    resolve_phoenix_project_name,
    resolve_phoenix_tracing,
    resolve_phoenix_ui_url,
)


class RuntimeEvent(BaseModel):
    seq: int
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    actor: str
    kind: str
    message: str
    status: str = "info"
    details: dict[str, Any] = Field(default_factory=dict)


class TracingStatus(BaseModel):
    provider: str
    enabled: bool
    api_key_configured: bool
    project: str
    endpoint: str
    ui_url: str
    base_url: str
    deployment: str
    tracing_env: str
    default_dataset_name: str
    pricing_models: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class RunTrace(BaseModel):
    run_id: str
    root_actor: str
    started_at: datetime
    finished_at: datetime | None = None
    events: list[RuntimeEvent] = Field(default_factory=list)
    metrics: RunMetrics | None = None
    tracing: TracingStatus
    completed: bool = False


class _RunState:
    def __init__(self, run_id: str, root_actor: str, tracing: TracingStatus) -> None:
        self.run_id = run_id
        self.root_actor = root_actor
        self.tracing = tracing
        self.started_at = datetime.utcnow()
        self.finished_at: datetime | None = None
        self.events: list[RuntimeEvent] = []
        self.metrics = RunMetrics(run_id=run_id, url="")
        self.completed = False
        self._next_seq = 1
        self._lock = Lock()

    def _get_model_usage(self, model_name: str, provider: str) -> ModelUsage:
        normalized_model = (model_name or "unknown").strip() or "unknown"
        normalized_provider = (provider or "").strip()

        for entry in self.metrics.model_usage:
            if entry.model_name == normalized_model and entry.provider == normalized_provider:
                return entry

        entry = ModelUsage(model_name=normalized_model, provider=normalized_provider)
        self.metrics.model_usage.append(entry)
        return entry

    def snapshot(self) -> RunTrace:
        with self._lock:
            return RunTrace(
                run_id=self.run_id,
                root_actor=self.root_actor,
                started_at=self.started_at,
                finished_at=self.finished_at,
                events=list(self.events),
                metrics=self.metrics.model_copy(deep=True),
                tracing=self.tracing,
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

    def record_message(self, message_type: str, count: int = 1) -> None:
        normalized = (message_type or "").strip().lower()
        with self._state._lock:
            self._state.metrics.total_messages += count
            if normalized == "system":
                self._state.metrics.system_messages += count
            elif normalized == "human":
                self._state.metrics.human_messages += count
            elif normalized == "ai":
                self._state.metrics.ai_messages += count
            elif normalized == "tool":
                self._state.metrics.tool_messages += count

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

    def add_llm_usage(
        self,
        usage: Any,
        *,
        model_name: str = "",
        provider: str = "",
        pricing: dict[str, Any] | None = None,
    ) -> None:
        usage_dict = usage if isinstance(usage, dict) else getattr(usage, "__dict__", {})
        input_tokens = int(
            usage_dict.get("input_tokens")
            or usage_dict.get("prompt_tokens")
            or usage_dict.get("input_token_count")
            or usage_dict.get("prompt_token_count")
            or 0
        )
        output_tokens = int(
            usage_dict.get("output_tokens")
            or usage_dict.get("completion_tokens")
            or usage_dict.get("candidates_token_count")
            or usage_dict.get("output_token_count")
            or 0
        )
        pricing = pricing or {}
        resolved_provider = str(pricing.get("provider") or provider or "").strip()
        costs = estimate_usage_cost(
            input_tokens,
            output_tokens,
            input_per_million=float(pricing.get("input_per_million", 0.0) or 0.0),
            output_per_million=float(pricing.get("output_per_million", 0.0) or 0.0),
        )

        with self._state._lock:
            metrics = self._state.metrics
            metrics.total_llm_calls += 1
            metrics.total_tokens_in += input_tokens
            metrics.total_tokens_out += output_tokens
            metrics.estimated_input_cost_usd = round(
                metrics.estimated_input_cost_usd + costs["estimated_input_cost_usd"],
                8,
            )
            metrics.estimated_output_cost_usd = round(
                metrics.estimated_output_cost_usd + costs["estimated_output_cost_usd"],
                8,
            )
            metrics.estimated_total_cost_usd = round(
                metrics.estimated_total_cost_usd + costs["estimated_total_cost_usd"],
                8,
            )

            model_usage = self._state._get_model_usage(model_name or "unknown", resolved_provider)
            model_usage.llm_calls += 1
            model_usage.input_tokens += input_tokens
            model_usage.output_tokens += output_tokens
            model_usage.estimated_input_cost_usd = round(
                model_usage.estimated_input_cost_usd + costs["estimated_input_cost_usd"],
                8,
            )
            model_usage.estimated_output_cost_usd = round(
                model_usage.estimated_output_cost_usd + costs["estimated_output_cost_usd"],
                8,
            )
            model_usage.estimated_total_cost_usd = round(
                model_usage.estimated_total_cost_usd + costs["estimated_total_cost_usd"],
                8,
            )

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

    def create(self, run_id: str, root_actor: str, tracing: TracingStatus) -> RunObserver:
        with self._lock:
            state = _RunState(run_id=run_id, root_actor=root_actor, tracing=tracing)
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


def get_tracing_status(settings: Settings) -> TracingStatus:
    enabled = resolve_phoenix_tracing(settings)
    tracing_env = "true" if enabled else "false"
    api_key = resolve_phoenix_api_key(settings)
    endpoint = resolve_phoenix_collector_endpoint(settings)
    ui_url = resolve_phoenix_ui_url(settings)
    base_url = resolve_phoenix_base_url(settings)
    project = resolve_phoenix_project_name(settings)
    deployment = "self-hosted" if is_self_hosted_phoenix(settings) else "cloud"
    pricing_config = resolve_phoenix_model_pricing(settings)
    warnings: list[str] = []
    if enabled and deployment == "cloud" and not api_key:
        warnings.append("Tracing is enabled for Phoenix Cloud but PHOENIX_API_KEY is missing.")
    if enabled and not project:
        warnings.append("Tracing is enabled but no Phoenix project is configured.")
    if enabled and not ui_url:
        warnings.append("Tracing is enabled but no Phoenix UI URL could be derived.")
    if enabled and not pricing_config:
        warnings.append(
            "No local model pricing config is set. Token metrics will work, but cost estimates stay at 0 unless Phoenix UI pricing or PHOENIX_MODEL_PRICING_JSON is configured."
        )
    return TracingStatus(
        provider="phoenix",
        enabled=enabled,
        api_key_configured=bool(api_key),
        project=project,
        endpoint=endpoint,
        ui_url=ui_url,
        base_url=base_url,
        deployment=deployment,
        tracing_env=tracing_env,
        default_dataset_name=resolve_phoenix_default_dataset_name(settings),
        pricing_models=sorted(pricing_config.keys()),
        warnings=warnings,
    )


def get_model_pricing_for_settings(
    settings: Settings,
    model_name: str,
    provider: str = "",
) -> dict[str, Any]:
    return resolve_model_pricing(settings, model_name=model_name, provider=provider)


run_registry = RunRegistry()
