"""Orchestrator-stage models (plan task 14, batch W3).

Canonical home for run-level models owned by the orchestrator:

- ``ModelUsage`` / ``RunMetrics`` — per-model and per-run observability,
- ``PipelineResult`` — the end-to-end pipeline output,
- the workflow/operator request DTOs previously defined in
  ``schemas.py`` (``OperatorOverview``, ``AgentTestRequest``,
  ``WorkflowRunRequest``, ``ToolPlaygroundRequest``,
  ``ProviderLookupRequest``, ``DatabaseTableResponse``, ``PricingConfig``).
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import Field

from src.models.classification import ClassificationResult
from src.models.common import (
    AgentType,
    ExtractionStatus,
    PipelineModel,
)
from src.models.hosting import ExtractionResult, StreamURL
from src.models.judge import ProviderInfo, TakedownEmail
from src.models.landing import MatchInfo


class ModelUsage(PipelineModel):
    model_name: str
    provider: str = ""
    llm_calls: int = 0
    cache_hit_calls: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    new_input_tokens: int = 0
    output_tokens: int = 0
    estimated_input_cost_usd: float = 0.0
    estimated_cached_input_cost_usd: float = 0.0
    estimated_cache_write_cost_usd: float = 0.0
    estimated_output_cost_usd: float = 0.0
    estimated_total_cost_usd: float = 0.0


class RunMetrics(PipelineModel):
    run_id: str
    url: str
    started_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    finished_at: datetime | None = None
    total_tokens_in: int = 0
    total_cached_input_tokens: int = 0
    total_new_input_tokens: int = 0
    total_tokens_out: int = 0
    total_llm_calls: int = 0
    total_cache_hit_calls: int = 0
    total_tool_calls: int = 0
    total_messages: int = 0
    system_messages: int = 0
    human_messages: int = 0
    ai_messages: int = 0
    tool_messages: int = 0
    estimated_input_cost_usd: float = 0.0
    estimated_cached_input_cost_usd: float = 0.0
    estimated_cache_write_cost_usd: float = 0.0
    estimated_output_cost_usd: float = 0.0
    estimated_total_cost_usd: float = 0.0
    total_duration_seconds: float = 0.0
    agents_invoked: list[AgentType] = Field(default_factory=list)
    model_usage: list[ModelUsage] = Field(default_factory=list)
    success: bool = False
    failure_mode: str = ""


class PipelineResult(PipelineModel):
    run_id: str
    url: str

    # Stage results
    classification: ClassificationResult | None = None
    matches: list[MatchInfo] = Field(default_factory=list)  # from landing agent
    extraction_results: list[ExtractionResult] = Field(default_factory=list)  # per match URL

    # Aggregated output
    final_status: ExtractionStatus = ExtractionStatus.FAILED
    failure_kind: str = ""  # FailureKind value when the run ended abnormally (T30)
    all_streams: list[StreamURL] = Field(default_factory=list)
    all_screenshots: list[str] = Field(default_factory=list)

    # Analysis & emails
    provider_analysis: list[ProviderInfo] = Field(default_factory=list)
    takedown_emails: list[TakedownEmail] = Field(default_factory=list)

    metrics: RunMetrics | None = None

    @property
    def streams(self) -> list[StreamURL]:
        """Backward-compatible alias for legacy callers/tests."""
        return self.all_streams


class PricingConfig(PipelineModel):
    provider: str = ""
    model_name: str
    input_per_million: float = 0.0
    output_per_million: float = 0.0
    cached_input_per_million: float = 0.0
    cache_write_per_million: float = 0.0
    context_window: int = 0
    active: bool = True
    notes: str = ""


class OperatorOverview(PipelineModel):
    summary: dict[str, Any] = Field(default_factory=dict)
    trend: list[dict[str, Any]] = Field(default_factory=list)
    model_breakdown: list[dict[str, Any]] = Field(default_factory=list)
    provider_breakdown: list[dict[str, Any]] = Field(default_factory=list)
    top_tools: list[dict[str, Any]] = Field(default_factory=list)
    recent_runs: list[dict[str, Any]] = Field(default_factory=list)
    active_runs: list[dict[str, Any]] = Field(default_factory=list)


class AgentTestRequest(PipelineModel):
    agent: str
    url: str
    prompt_override: str = ""
    idempotency_key: str = ""


class WorkflowRunRequest(PipelineModel):
    url: str
    idempotency_key: str = ""
    max_cost_usd: float | None = None


class ToolPlaygroundRequest(PipelineModel):
    profile: str
    tool_name: str
    args: dict[str, Any] = Field(default_factory=dict)


class ProviderLookupRequest(PipelineModel):
    stream_urls: list[str] = Field(default_factory=list)


class DatabaseTableResponse(PipelineModel):
    table: str
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    limit: int = 50
    offset: int = 0
    total: int = 0
