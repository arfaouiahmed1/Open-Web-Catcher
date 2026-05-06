"""Runtime observability helpers for events, metrics, and local pricing status."""

from __future__ import annotations

from collections import OrderedDict
from datetime import datetime
from threading import Lock
from typing import Any

from pydantic import BaseModel, Field

from src.models.enums import AgentType
from src.models.schemas import ModelUsage, RunMetrics
from src.utils.config import Settings
from src.utils.instrumentation import (
    estimate_usage_cost,
    resolve_default_dataset_name,
    resolve_model_pricing,
    resolve_model_pricing_config,
    resolve_observability_enabled,
    resolve_observability_project_name,
)


def _coerce_mapping(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if hasattr(value, "model_dump"):
        dumped = value.model_dump(mode="json")
        return dumped if isinstance(dumped, dict) else {}
    return getattr(value, "__dict__", {}) if hasattr(value, "__dict__") else {}


def _to_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _extract_cache_metrics(
    usage: Any,
    *,
    response_metadata: Any = None,
    additional_kwargs: Any = None,
) -> dict[str, Any]:
    usage_dict = _coerce_mapping(usage)
    response_dict = _coerce_mapping(response_metadata)
    kwargs_dict = _coerce_mapping(additional_kwargs)

    input_tokens = _to_int(
        usage_dict.get("input_tokens")
        or usage_dict.get("prompt_tokens")
        or usage_dict.get("input_token_count")
        or usage_dict.get("prompt_token_count")
    )
    output_tokens = _to_int(
        usage_dict.get("output_tokens")
        or usage_dict.get("completion_tokens")
        or usage_dict.get("candidates_token_count")
        or usage_dict.get("output_token_count")
    )

    openai_details = _coerce_mapping(usage_dict.get("input_token_details") or usage_dict.get("prompt_tokens_details"))
    cached_tokens = _to_int(openai_details.get("cached_tokens"))

    # Anthropic-style prompt caching fields.
    cache_read_input_tokens = _to_int(usage_dict.get("cache_read_input_tokens"))
    cache_creation_input_tokens = _to_int(usage_dict.get("cache_creation_input_tokens"))
    if cache_read_input_tokens:
        cached_tokens = max(cached_tokens, cache_read_input_tokens)

    if not cached_tokens:
        # Fallback for providers that surface cache details in nested metadata.
        response_usage = _coerce_mapping(response_dict.get("token_usage") or response_dict.get("usage"))
        response_details = _coerce_mapping(response_usage.get("input_token_details") or response_usage.get("prompt_tokens_details"))
        cached_tokens = _to_int(response_details.get("cached_tokens"))

    if not cached_tokens:
        kwargs_usage = _coerce_mapping(kwargs_dict.get("usage") or kwargs_dict.get("token_usage"))
        kwargs_details = _coerce_mapping(kwargs_usage.get("input_token_details") or kwargs_usage.get("prompt_tokens_details"))
        cached_tokens = _to_int(kwargs_details.get("cached_tokens"))

    cached_tokens = max(0, min(cached_tokens, input_tokens))
    new_input_tokens = max(input_tokens - cached_tokens, 0)
    cache_hit = cached_tokens > 0 or cache_read_input_tokens > 0

    return {
        "cache_hit": cache_hit,
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_tokens,
        "new_input_tokens": new_input_tokens,
        "output_tokens": output_tokens,
        "cache_read_input_tokens": cache_read_input_tokens,
        "cache_creation_input_tokens": cache_creation_input_tokens,
    }


def _extract_provider_reported_costs(
    usage: Any,
    *,
    response_metadata: Any = None,
    additional_kwargs: Any = None,
) -> dict[str, float]:
    def _read_costs(payload: dict[str, Any]) -> tuple[float | None, float | None, float | None]:
        total_cost = payload.get("total_cost_usd", payload.get("total_cost", payload.get("cost")))
        input_cost = payload.get("input_cost_usd", payload.get("prompt_cost", payload.get("input_cost")))
        output_cost = payload.get("output_cost_usd", payload.get("completion_cost", payload.get("output_cost")))

        nested_usage = _coerce_mapping(payload.get("usage") or payload.get("token_usage"))
        if nested_usage:
            total_cost = nested_usage.get("total_cost_usd", nested_usage.get("total_cost", total_cost))
            input_cost = nested_usage.get("input_cost_usd", nested_usage.get("prompt_cost", input_cost))
            output_cost = nested_usage.get("output_cost_usd", nested_usage.get("completion_cost", output_cost))

        try:
            parsed_total = float(total_cost) if total_cost is not None else None
            parsed_input = float(input_cost) if input_cost is not None else None
            parsed_output = float(output_cost) if output_cost is not None else None
        except (TypeError, ValueError):
            return (None, None, None)

        if parsed_total is None and parsed_input is None and parsed_output is None:
            return (None, None, None)
        if parsed_total is None and (parsed_input is not None or parsed_output is not None):
            parsed_total = float(parsed_input or 0.0) + float(parsed_output or 0.0)
        return (parsed_total, parsed_input, parsed_output)

    payloads = [
        _coerce_mapping(usage),
        _coerce_mapping(response_metadata),
        _coerce_mapping(additional_kwargs),
    ]
    for payload in payloads:
        if not payload:
            continue
        parsed_total, parsed_input, parsed_output = _read_costs(payload)
        if parsed_total is None and parsed_input is None and parsed_output is None:
            continue

        return {
            "estimated_input_cost_usd": round(max(float(parsed_input or 0.0), 0.0), 8),
            "estimated_cached_input_cost_usd": 0.0,
            "estimated_cache_write_cost_usd": 0.0,
            "estimated_output_cost_usd": round(max(float(parsed_output or 0.0), 0.0), 8),
            "estimated_total_cost_usd": round(max(float(parsed_total or 0.0), 0.0), 8),
        }

    return {
        "estimated_input_cost_usd": 0.0,
        "estimated_cached_input_cost_usd": 0.0,
        "estimated_cache_write_cost_usd": 0.0,
        "estimated_output_cost_usd": 0.0,
        "estimated_total_cost_usd": 0.0,
    }


class RuntimeEvent(BaseModel):
    seq: int
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    actor: str
    kind: str
    message: str
    status: str = "info"
    details: dict[str, Any] = Field(default_factory=dict)


class ObservabilityStatus(BaseModel):
    provider: str = "internal"
    enabled: bool
    project: str
    pricing_models: list[str] = Field(default_factory=list)
    default_dataset_name: str
    warnings: list[str] = Field(default_factory=list)


class RunTrace(BaseModel):
    run_id: str
    root_actor: str
    started_at: datetime
    finished_at: datetime | None = None
    events: list[RuntimeEvent] = Field(default_factory=list)
    metrics: RunMetrics | None = None
    observability: ObservabilityStatus
    completed: bool = False
    cancel_requested: bool = False
    cancel_reason: str = ""


class _RunState:
    def __init__(self, run_id: str, root_actor: str, observability: ObservabilityStatus) -> None:
        self.run_id = run_id
        self.root_actor = root_actor
        self.observability = observability
        self.started_at = datetime.utcnow()
        self.finished_at: datetime | None = None
        self.events: list[RuntimeEvent] = []
        self.metrics = RunMetrics(run_id=run_id, url="")
        self.completed = False
        self.cancel_requested = False
        self.cancel_reason = ""
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
                observability=self.observability,
                completed=self.completed,
                cancel_requested=self.cancel_requested,
                cancel_reason=self.cancel_reason,
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
        response_metadata: Any = None,
        additional_kwargs: Any = None,
        cache_metrics: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
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
        resolved_cache = cache_metrics or _extract_cache_metrics(
            usage,
            response_metadata=response_metadata,
            additional_kwargs=additional_kwargs,
        )
        cache_hit = bool(resolved_cache.get("cache_hit", False))
        cached_input_tokens = _to_int(resolved_cache.get("cached_input_tokens"))
        new_input_tokens = _to_int(resolved_cache.get("new_input_tokens"))
        cache_creation_input_tokens = _to_int(resolved_cache.get("cache_creation_input_tokens"))

        reported_costs = _extract_provider_reported_costs(
            usage,
            response_metadata=response_metadata,
            additional_kwargs=additional_kwargs,
        )
        has_reported_costs = any(
            float(reported_costs.get(key, 0.0) or 0.0) > 0.0
            for key in (
                "estimated_input_cost_usd",
                "estimated_output_cost_usd",
                "estimated_total_cost_usd",
            )
        )
        if has_reported_costs:
            costs = reported_costs
            cost_source = "provider_reported"
        else:
            pricing_input = float(pricing.get("input_per_million", 0.0) or 0.0)
            pricing_output = float(pricing.get("output_per_million", 0.0) or 0.0)
            pricing_cached_input = float(pricing.get("cached_input_per_million", 0.0) or 0.0)
            pricing_cache_write = float(pricing.get("cache_write_per_million", 0.0) or 0.0)
            if pricing_input > 0.0 or pricing_output > 0.0 or pricing_cached_input > 0.0 or pricing_cache_write > 0.0:
                if cache_hit or cache_creation_input_tokens > 0:
                    billable_input_tokens = max(new_input_tokens, 0)
                else:
                    billable_input_tokens = max(input_tokens, 0)
                cache_write_tokens = min(max(cache_creation_input_tokens, 0), max(billable_input_tokens, 0))
                billable_input_tokens = max(billable_input_tokens - cache_write_tokens, 0)
                costs = estimate_usage_cost(
                    billable_input_tokens,
                    output_tokens,
                    cached_input_tokens=cached_input_tokens,
                    cache_write_input_tokens=cache_write_tokens,
                    input_per_million=pricing_input,
                    output_per_million=pricing_output,
                    cached_input_per_million=pricing_cached_input,
                    cache_write_per_million=pricing_cache_write,
                )
                cost_source = "provider_pricing_catalog"
            else:
                costs = reported_costs
                cost_source = "provider_unreported"

        with self._state._lock:
            metrics = self._state.metrics
            metrics.total_llm_calls += 1
            metrics.total_tokens_in += input_tokens
            metrics.total_cached_input_tokens += cached_input_tokens
            metrics.total_new_input_tokens += new_input_tokens
            metrics.total_tokens_out += output_tokens
            if cache_hit:
                metrics.total_cache_hit_calls += 1
            metrics.estimated_input_cost_usd = round(metrics.estimated_input_cost_usd + costs["estimated_input_cost_usd"], 8)
            metrics.estimated_cached_input_cost_usd = round(
                metrics.estimated_cached_input_cost_usd + costs["estimated_cached_input_cost_usd"], 8
            )
            metrics.estimated_cache_write_cost_usd = round(
                metrics.estimated_cache_write_cost_usd + costs["estimated_cache_write_cost_usd"], 8
            )
            metrics.estimated_output_cost_usd = round(metrics.estimated_output_cost_usd + costs["estimated_output_cost_usd"], 8)
            metrics.estimated_total_cost_usd = round(metrics.estimated_total_cost_usd + costs["estimated_total_cost_usd"], 8)

            model_usage = self._state._get_model_usage(model_name or "unknown", resolved_provider)
            model_usage.llm_calls += 1
            if cache_hit:
                model_usage.cache_hit_calls += 1
            model_usage.input_tokens += input_tokens
            model_usage.cached_input_tokens += cached_input_tokens
            model_usage.new_input_tokens += new_input_tokens
            model_usage.output_tokens += output_tokens
            model_usage.estimated_input_cost_usd = round(model_usage.estimated_input_cost_usd + costs["estimated_input_cost_usd"], 8)
            model_usage.estimated_cached_input_cost_usd = round(
                model_usage.estimated_cached_input_cost_usd + costs["estimated_cached_input_cost_usd"], 8
            )
            model_usage.estimated_cache_write_cost_usd = round(
                model_usage.estimated_cache_write_cost_usd + costs["estimated_cache_write_cost_usd"], 8
            )
            model_usage.estimated_output_cost_usd = round(model_usage.estimated_output_cost_usd + costs["estimated_output_cost_usd"], 8)
            model_usage.estimated_total_cost_usd = round(model_usage.estimated_total_cost_usd + costs["estimated_total_cost_usd"], 8)

        return {
            "provider": resolved_provider,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "cached_input_tokens": cached_input_tokens,
            "new_input_tokens": new_input_tokens,
            "cache_creation_input_tokens": cache_creation_input_tokens,
            "cache_hit": cache_hit,
            "estimated_input_cost_usd": float(costs.get("estimated_input_cost_usd", 0.0) or 0.0),
            "estimated_cached_input_cost_usd": float(costs.get("estimated_cached_input_cost_usd", 0.0) or 0.0),
            "estimated_cache_write_cost_usd": float(costs.get("estimated_cache_write_cost_usd", 0.0) or 0.0),
            "estimated_output_cost_usd": float(costs.get("estimated_output_cost_usd", 0.0) or 0.0),
            "estimated_total_cost_usd": float(costs.get("estimated_total_cost_usd", 0.0) or 0.0),
            "cost_source": cost_source,
            "pricing": {
                "provider": resolved_provider,
                "input_per_million": float(pricing.get("input_per_million", 0.0) or 0.0),
                "output_per_million": float(pricing.get("output_per_million", 0.0) or 0.0),
                "cached_input_per_million": float(pricing.get("cached_input_per_million", 0.0) or 0.0),
                "cache_write_per_million": float(pricing.get("cache_write_per_million", 0.0) or 0.0),
                "context_window": int(pricing.get("context_window", 0) or 0),
            },
        }

    def increment_tool_calls(self, count: int = 1) -> None:
        with self._state._lock:
            self._state.metrics.total_tool_calls += count

    def request_cancel(self, reason: str = "") -> bool:
        with self._state._lock:
            if self._state.completed or self._state.cancel_requested:
                return False
            self._state.cancel_requested = True
            self._state.cancel_reason = reason or "Cancelled from the control room."
            event = RuntimeEvent(
                seq=self._state._next_seq,
                actor="control-room",
                kind="cancel_requested",
                message=self._state.cancel_reason,
                status="warning",
                details={"cancel_reason": self._state.cancel_reason},
            )
            self._state._next_seq += 1
            self._state.events.append(event)
            return True

    def is_cancel_requested(self) -> bool:
        with self._state._lock:
            return self._state.cancel_requested

    def cancel_reason(self) -> str:
        with self._state._lock:
            return self._state.cancel_reason

    def finish(self, *, success: bool, failure_mode: str = "") -> None:
        with self._state._lock:
            self._state.finished_at = datetime.utcnow()
            self._state.completed = True
            self._state.metrics.finished_at = self._state.finished_at
            self._state.metrics.total_duration_seconds = (self._state.finished_at - self._state.started_at).total_seconds()
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

    def create(self, run_id: str, root_actor: str, observability: ObservabilityStatus) -> RunObserver:
        with self._lock:
            state = self._runs.get(run_id)
            if state is None or state.completed:
                state = _RunState(run_id=run_id, root_actor=root_actor, observability=observability)
                self._runs[run_id] = state
            else:
                if root_actor and not state.root_actor:
                    state.root_actor = root_actor
                state.observability = observability
            self._runs.move_to_end(run_id)
            while len(self._runs) > self._max_runs:
                self._runs.popitem(last=False)
            return RunObserver(state, root_actor or state.root_actor)

    def restore(self, trace: RunTrace) -> RunObserver:
        with self._lock:
            existing = self._runs.get(trace.run_id)
            if existing is not None and len(existing.events) >= len(trace.events):
                self._runs.move_to_end(trace.run_id)
                return RunObserver(existing, existing.root_actor)

            state = _RunState(
                run_id=trace.run_id,
                root_actor=trace.root_actor,
                observability=trace.observability,
            )
            state.started_at = trace.started_at
            state.finished_at = trace.finished_at
            state.events = [event.model_copy(deep=True) for event in trace.events]
            state.metrics = (
                trace.metrics.model_copy(deep=True)
                if trace.metrics is not None
                else RunMetrics(run_id=trace.run_id, url="")
            )
            state.completed = trace.completed
            state.cancel_requested = trace.cancel_requested
            state.cancel_reason = trace.cancel_reason
            state._next_seq = max((event.seq for event in state.events), default=0) + 1
            self._runs[trace.run_id] = state
            self._runs.move_to_end(trace.run_id)
            while len(self._runs) > self._max_runs:
                self._runs.popitem(last=False)
            return RunObserver(state, trace.root_actor)

    def get(self, run_id: str) -> RunTrace | None:
        with self._lock:
            state = self._runs.get(run_id)
        return state.snapshot() if state else None

    def list_recent(self, limit: int = 20) -> list[RunTrace]:
        with self._lock:
            states = list(self._runs.values())[-limit:]
        return [state.snapshot() for state in reversed(states)]

    def request_cancel(self, run_id: str, reason: str = "") -> bool:
        with self._lock:
            state = self._runs.get(run_id)
        if state is None:
            return False
        observer = RunObserver(state, "control-room")
        return observer.request_cancel(reason=reason)


def get_observability_status(settings: Settings) -> ObservabilityStatus:
    pricing_config = resolve_model_pricing_config(settings)
    pricing_models = sorted({key for key in pricing_config.keys() if "::" not in key})
    warnings: list[str] = []
    if resolve_observability_enabled(settings) and not pricing_config:
        warnings.append(
            "No model pricing config is set. Token metrics work, but cost estimates stay at 0 until MODEL_PRICING_JSON or pricing rows are configured."
        )
    return ObservabilityStatus(
        enabled=resolve_observability_enabled(settings),
        project=resolve_observability_project_name(settings),
        default_dataset_name=resolve_default_dataset_name(settings),
        pricing_models=pricing_models,
        warnings=warnings,
    )


def get_model_pricing_for_settings(settings: Settings, model_name: str, provider: str = "") -> dict[str, Any]:
    return resolve_model_pricing(settings, model_name=model_name, provider=provider)


run_registry = RunRegistry()

# Compatibility aliases for older call sites while the new operator console lands.
TracingStatus = ObservabilityStatus
get_tracing_status = get_observability_status
