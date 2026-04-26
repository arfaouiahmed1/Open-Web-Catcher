"""Pydantic data models for the pipeline."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType


# ── Classification ────────────────────────────────────────────────────────────

class ClassificationResult(BaseModel):
    url: str
    page_type: PageType
    confidence: Confidence
    reasoning: str = ""
    agent_type: AgentType = AgentType.CLASSIFICATION


# ── Streams ───────────────────────────────────────────────────────────────────

class StreamURL(BaseModel):
    url: str
    protocol: str = ""          # hls / dash / mp4 / etc.
    quality: str = ""
    source_layer: str = ""      # which server/layer captured it
    captured_at: datetime = Field(default_factory=datetime.utcnow)


# ── Per-URL extraction results ────────────────────────────────────────────────

class ServerResult(BaseModel):
    label: str = "default"
    server_up: bool = True
    m3u8_urls: list[str] = Field(default_factory=list)
    mpd_urls: list[str] = Field(default_factory=list)
    mp4_urls: list[str] = Field(default_factory=list)
    primary_stream: str | None = None
    screenshot_url: str | None = None     # Cloudinary URL
    embedded_url: str | None = None       # set when needs_embed_agent
    status: str = "failed"                # success / failed / needs_embed_agent
    down_reason: str | None = None


class ExtractionResult(BaseModel):
    url: str
    page_type: PageType
    status: ExtractionStatus
    servers: list[ServerResult] = Field(default_factory=list)
    streams: list[StreamURL] = Field(default_factory=list)
    screenshots: list[str] = Field(default_factory=list)   # Cloudinary URLs
    embedded_urls: list[str] = Field(default_factory=list) # iframes needing embedded agent
    agent_type: AgentType
    tool_calls_used: int = 0
    duration_seconds: float = 0.0
    error_message: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


# ── Match/channel info from landing agent ─────────────────────────────────────

class MatchInfo(BaseModel):
    """A single watchable item discovered by the Landing Page Agent."""
    url: str
    title: str = ""
    participants: str | None = None    # "Team A vs Team B"
    channel: str | None = None
    sport: str | None = None
    league: str | None = None
    status: str = "unknown"            # live / upcoming / replay / unknown
    scheduled_time: str | None = None
    confidence: int = 70               # 0-100
    route: str = "embed_agent"         # embed_agent | stream_extractor
    iframes: list[str] = Field(default_factory=list)
    entry_point: str = ""


# ── Provider / Whois analysis ─────────────────────────────────────────────────

class ProviderInfo(BaseModel):
    """IPInfo / Whois result for a single stream URL."""
    stream_url: str
    ip: str = ""
    hostname: str = ""
    org: str = ""          # e.g. "AS12345 SomeHostingProvider"
    provider: str = ""     # cleaned provider name
    country: str = ""
    region: str = ""
    city: str = ""
    abuse_email: str = ""  # from whois abuse contact
    whois_raw: str = ""


# ── Takedown emails ───────────────────────────────────────────────────────────

class TakedownEmail(BaseModel):
    """A takedown notice email (not sent — written for human review)."""
    provider: str
    abuse_email: str
    subject: str
    body: str
    # Evidence attached
    infringing_url: str           # original streaming site URL
    stream_urls: list[str] = Field(default_factory=list)
    screenshot_urls: list[str] = Field(default_factory=list)
    server_labels: list[str] = Field(default_factory=list)
    provider_info: ProviderInfo | None = None
    generated_at: datetime = Field(default_factory=datetime.utcnow)


# ── Pipeline result ───────────────────────────────────────────────────────────

class ModelUsage(BaseModel):
    model_name: str
    provider: str = ""
    llm_calls: int = 0
    cache_hit_calls: int = 0
    input_tokens: int = 0
    cached_input_tokens: int = 0
    new_input_tokens: int = 0
    output_tokens: int = 0
    estimated_input_cost_usd: float = 0.0
    estimated_output_cost_usd: float = 0.0
    estimated_total_cost_usd: float = 0.0


class RunMetrics(BaseModel):
    run_id: str
    url: str
    started_at: datetime = Field(default_factory=datetime.utcnow)
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
    estimated_output_cost_usd: float = 0.0
    estimated_total_cost_usd: float = 0.0
    total_duration_seconds: float = 0.0
    agents_invoked: list[AgentType] = Field(default_factory=list)
    model_usage: list[ModelUsage] = Field(default_factory=list)
    success: bool = False
    failure_mode: str = ""


class PipelineResult(BaseModel):
    run_id: str
    url: str

    # Stage results
    classification: ClassificationResult | None = None
    matches: list[MatchInfo] = Field(default_factory=list)          # from landing agent
    extraction_results: list[ExtractionResult] = Field(default_factory=list)  # per match URL

    # Aggregated output
    final_status: ExtractionStatus = ExtractionStatus.FAILED
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


class PricingConfig(BaseModel):
    provider: str = ""
    model_name: str
    input_per_million: float = 0.0
    output_per_million: float = 0.0
    active: bool = True
    notes: str = ""


class OperatorOverview(BaseModel):
    summary: dict[str, Any] = Field(default_factory=dict)
    trend: list[dict[str, Any]] = Field(default_factory=list)
    model_breakdown: list[dict[str, Any]] = Field(default_factory=list)
    provider_breakdown: list[dict[str, Any]] = Field(default_factory=list)
    top_tools: list[dict[str, Any]] = Field(default_factory=list)
    recent_runs: list[dict[str, Any]] = Field(default_factory=list)
    evaluation_summary: dict[str, Any] = Field(default_factory=dict)
    active_runs: list[dict[str, Any]] = Field(default_factory=list)


class AgentTestRequest(BaseModel):
    agent: str
    url: str
    prompt_override: str = ""
    idempotency_key: str = ""


class WorkflowRunRequest(BaseModel):
    url: str
    idempotency_key: str = ""


class ToolPlaygroundRequest(BaseModel):
    profile: str
    tool_name: str
    args: dict[str, Any] = Field(default_factory=dict)


class ProviderLookupRequest(BaseModel):
    stream_urls: list[str] = Field(default_factory=list)


class EvaluationAssertionResult(BaseModel):
    name: str
    passed: bool
    expected: Any = None
    actual: Any = None
    message: str = ""


class EvaluationCase(BaseModel):
    id: int | None = None
    suite_id: int | None = None
    name: str
    description: str = ""
    mode: str = "synthetic"
    target_type: str = "workflow"
    active: bool = True
    input: dict[str, Any] = Field(default_factory=dict)
    assertions: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)


class EvaluationSuite(BaseModel):
    id: int | None = None
    name: str
    description: str = ""
    mode: str = "hybrid"
    active: bool = True
    config: dict[str, Any] = Field(default_factory=dict)
    cases: list[EvaluationCase] = Field(default_factory=list)


class EvaluationCaseResult(BaseModel):
    case_id: int | None = None
    case_name: str = ""
    status: str = "pending"
    target_type: str = "workflow"
    latency_ms: float = 0.0
    total_cost_usd: float = 0.0
    hallucination_score: float = 0.0
    tool_accuracy_score: float = 0.0
    reliability_score: float = 0.0
    assertion_results: list[EvaluationAssertionResult] = Field(default_factory=list)
    output: dict[str, Any] = Field(default_factory=dict)
    trace: dict[str, Any] = Field(default_factory=dict)


class EvaluationRun(BaseModel):
    run_id: str
    suite_id: int | None = None
    name: str = ""
    mode: str = "hybrid"
    status: str = "pending"
    success_rate: float = 0.0
    hallucination_rate: float = 0.0
    tool_accuracy_rate: float = 0.0
    reliability_rate: float = 0.0
    avg_latency_ms: float = 0.0
    avg_cost_usd: float = 0.0
    case_count: int = 0
    pass_count: int = 0
    summary: dict[str, Any] = Field(default_factory=dict)
    case_results: list[EvaluationCaseResult] = Field(default_factory=list)


class EvaluationRunRequest(BaseModel):
    suite_id: int | None = None
    mode: str = "hybrid"
    batch_name: str = ""
    urls: list[str] = Field(default_factory=list)


class DatabaseTableResponse(BaseModel):
    table: str
    columns: list[str] = Field(default_factory=list)
    rows: list[dict[str, Any]] = Field(default_factory=list)
    limit: int = 50
    offset: int = 0
    total: int = 0
