"""SQLAlchemy ORM models for legacy and normalized run persistence."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class RunRecord(Base):
    __tablename__ = "runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    url: Mapped[str] = mapped_column(Text)
    page_type: Mapped[str] = mapped_column(String(32), default="unknown")
    status: Mapped[str] = mapped_column(String(32), default="failed")
    streams_found: Mapped[int] = mapped_column(Integer, default=0)
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    tool_calls: Mapped[int] = mapped_column(Integer, default=0)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    success: Mapped[bool] = mapped_column(Boolean, default=False)
    failure_mode: Mapped[str] = mapped_column(String(64), default="")
    result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class BackgroundJobRecord(Base):
    __tablename__ = "background_jobs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    job_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    run_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    job_type: Mapped[str] = mapped_column(String(32), index=True)  # workflow | agent
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    idempotency_key: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    url: Mapped[str] = mapped_column(Text, default="")
    actor: Mapped[str] = mapped_column(String(64), default="")
    payload_json: Mapped[dict] = mapped_column(JSON, default=dict)
    result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error_text: Mapped[str] = mapped_column(Text, default="")
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=2)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("job_type", "idempotency_key", name="uq_background_jobs_type_idempotency"),
    )


class PipelineRunRecord(Base):
    __tablename__ = "pipeline_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    run_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    root_url: Mapped[str] = mapped_column(Text, index=True)
    page_type: Mapped[str] = mapped_column(String(32), default="unknown", index=True)
    final_status: Mapped[str] = mapped_column(String(32), default="failed", index=True)
    success: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    failure_mode: Mapped[str] = mapped_column(String(64), default="")
    stream_count: Mapped[int] = mapped_column(Integer, default=0)
    screenshot_count: Mapped[int] = mapped_column(Integer, default=0)
    email_count: Mapped[int] = mapped_column(Integer, default=0)
    provider_analysis_count: Mapped[int] = mapped_column(Integer, default=0)
    top_level_page_type: Mapped[str] = mapped_column(String(32), default="unknown")
    classification_confidence: Mapped[str] = mapped_column(String(16), default="")
    classification_reasoning: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    total_tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    total_cached_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_new_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    total_tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    total_llm_calls: Mapped[int] = mapped_column(Integer, default=0)
    total_cache_hit_calls: Mapped[int] = mapped_column(Integer, default=0)
    total_tool_calls: Mapped[int] = mapped_column(Integer, default=0)
    total_messages: Mapped[int] = mapped_column(Integer, default=0)
    estimated_input_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_cached_input_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_cache_write_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_output_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_total_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class RunSnapshotRecord(Base):
    __tablename__ = "run_snapshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey("pipeline_runs.id", ondelete="CASCADE"), unique=True, index=True)
    run_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    snapshot_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AgentRunRecord(Base):
    __tablename__ = "agent_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey("pipeline_runs.id", ondelete="CASCADE"), index=True)
    actor: Mapped[str] = mapped_column(String(64), index=True)
    agent_type: Mapped[str] = mapped_column(String(32), index=True)
    target_url: Mapped[str] = mapped_column(Text, default="")
    page_type: Mapped[str] = mapped_column(String(32), default="unknown", index=True)
    status: Mapped[str] = mapped_column(String(32), default="unknown", index=True)
    tool_call_budget: Mapped[int] = mapped_column(Integer, default=0)
    tool_calls_made: Mapped[int] = mapped_column(Integer, default=0)
    llm_calls_made: Mapped[int] = mapped_column(Integer, default=0)
    prompt_compiled: Mapped[bool] = mapped_column(Boolean, default=False)
    memory_injected: Mapped[bool] = mapped_column(Boolean, default=False)
    provider: Mapped[str] = mapped_column(String(64), default="", index=True)
    model_name: Mapped[str] = mapped_column(String(128), default="", index=True)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cached_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    new_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    context_window: Mapped[int] = mapped_column(Integer, default=0)
    context_tokens: Mapped[int] = mapped_column(Integer, default=0)
    context_usage_pct: Mapped[float] = mapped_column(Float, default=0.0)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    invocation_index: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class AgentOutputRecord(Base):
    __tablename__ = "agent_outputs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_run_id: Mapped[int] = mapped_column(ForeignKey("agent_runs.id", ondelete="CASCADE"), unique=True, index=True)
    output_json: Mapped[dict] = mapped_column(JSON, default=dict)
    summary_text: Mapped[str] = mapped_column(Text, default="")
    stream_count: Mapped[int] = mapped_column(Integer, default=0)
    embedded_url_count: Mapped[int] = mapped_column(Integer, default=0)
    hosting_page_count: Mapped[int] = mapped_column(Integer, default=0)
    validation_status: Mapped[str] = mapped_column(String(32), default="ok")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class PromptVersionRecord(Base):
    __tablename__ = "prompt_versions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_id: Mapped[str] = mapped_column(String(32), index=True)
    source_path: Mapped[str] = mapped_column(Text, default="")
    semantic_version: Mapped[str] = mapped_column(String(64), default="")
    content_hash: Mapped[str] = mapped_column(String(128), index=True)
    prompt_text: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("agent_id", "content_hash", name="uq_prompt_versions_agent_hash"),
    )


class PromptCompilationRecord(Base):
    __tablename__ = "prompt_compilations"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    prompt_version_id: Mapped[int | None] = mapped_column(ForeignKey("prompt_versions.id", ondelete="SET NULL"), nullable=True, index=True)
    agent_run_id: Mapped[int] = mapped_column(ForeignKey("agent_runs.id", ondelete="CASCADE"), index=True)
    cache_mode: Mapped[str] = mapped_column(String(32), default="")
    compiled_prompt_hash: Mapped[str] = mapped_column(String(128), index=True)
    provider_cache_key: Mapped[str] = mapped_column(Text, default="")
    provider_cache_eligible: Mapped[bool] = mapped_column(Boolean, default=False)
    static_cache_hit: Mapped[bool] = mapped_column(Boolean, default=False)
    memory_injected: Mapped[bool] = mapped_column(Boolean, default=False)
    output_contract_version: Mapped[str] = mapped_column(String(64), default="")
    sections_json: Mapped[list] = mapped_column(JSON, default=list)
    metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class LLMCallRecord(Base):
    __tablename__ = "llm_calls"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_run_id: Mapped[int] = mapped_column(ForeignKey("agent_runs.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer, index=True)
    provider: Mapped[str] = mapped_column(String(64), default="", index=True)
    model_name: Mapped[str] = mapped_column(String(128), default="", index=True)
    prompt_version: Mapped[str] = mapped_column(String(128), default="")
    prompt_hash: Mapped[str] = mapped_column(String(128), default="", index=True)
    cache_mode: Mapped[str] = mapped_column(String(32), default="")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cached_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    new_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cache_creation_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    context_window: Mapped[int | None] = mapped_column(Integer, nullable=True, default=None)
    estimated_input_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_cached_input_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_cache_write_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_output_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_total_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    tool_calls_requested: Mapped[int] = mapped_column(Integer, default=0)
    tools_requested: Mapped[list] = mapped_column(JSON, default=list)
    content_preview: Mapped[str] = mapped_column(Text, default="")
    usage_metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    response_metadata_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ToolCallRecord(Base):
    __tablename__ = "tool_calls"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_run_id: Mapped[int] = mapped_column(ForeignKey("agent_runs.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer, index=True)
    tool_name: Mapped[str] = mapped_column(String(128), index=True)
    args_json: Mapped[dict] = mapped_column(JSON, default=dict)
    target_summary: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(32), default="info", index=True)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    result_preview: Mapped[str] = mapped_column(Text, default="")
    error_text: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ToolPlaygroundCallRecord(Base):
    __tablename__ = "tool_playground_calls"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    call_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    origin: Mapped[str] = mapped_column(String(32), default="playground", index=True)
    related_run_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    profile: Mapped[str] = mapped_column(String(64), default="", index=True)
    tool_name: Mapped[str] = mapped_column(String(128), index=True)
    status: Mapped[str] = mapped_column(String(32), default="success", index=True)
    duration_seconds: Mapped[float] = mapped_column(Float, default=0.0)
    args_json: Mapped[dict] = mapped_column(JSON, default=dict)
    result_json: Mapped[dict] = mapped_column(JSON, default=dict)
    error_text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class RunDecisionRecord(Base):
    __tablename__ = "run_decisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int | None] = mapped_column(
        ForeignKey("pipeline_runs.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    run_id: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(255), default="")
    summary: Mapped[str] = mapped_column(Text, default="")
    actor: Mapped[str] = mapped_column(String(64), default="", index=True)
    category: Mapped[str] = mapped_column(String(64), default="", index=True)
    status: Mapped[str] = mapped_column(String(32), default="open", index=True)
    details_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class RunTaskRecord(Base):
    __tablename__ = "run_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int | None] = mapped_column(
        ForeignKey("pipeline_runs.id", ondelete="CASCADE"),
        nullable=True,
        index=True,
    )
    run_id: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(255), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    actor: Mapped[str] = mapped_column(String(64), default="", index=True)
    priority: Mapped[str] = mapped_column(String(32), default="medium", index=True)
    status: Mapped[str] = mapped_column(String(32), default="open", index=True)
    details_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
    )


class ProviderLookupCheckRecord(Base):
    __tablename__ = "provider_lookup_checks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    lookup_id: Mapped[str] = mapped_column(String(64), index=True)
    stream_url: Mapped[str] = mapped_column(Text)
    hostname: Mapped[str] = mapped_column(String(255), default="", index=True)
    ip: Mapped[str] = mapped_column(String(128), default="", index=True)
    org: Mapped[str] = mapped_column(Text, default="")
    provider: Mapped[str] = mapped_column(Text, default="", index=True)
    country: Mapped[str] = mapped_column(String(64), default="", index=True)
    region: Mapped[str] = mapped_column(String(128), default="")
    city: Mapped[str] = mapped_column(String(128), default="")
    abuse_email: Mapped[str] = mapped_column(String(255), default="", index=True)
    whois_raw: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class RuntimeEventRecord(Base):
    __tablename__ = "runtime_events"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey("pipeline_runs.id", ondelete="CASCADE"), index=True)
    agent_run_id: Mapped[int | None] = mapped_column(ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True, index=True)
    actor: Mapped[str] = mapped_column(String(64), index=True)
    seq: Mapped[int] = mapped_column(Integer, index=True)
    kind: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(32), default="info", index=True)
    message: Mapped[str] = mapped_column(Text, default="")
    details_json: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class RunModelUsageRecord(Base):
    __tablename__ = "run_model_usage"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey("pipeline_runs.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(String(64), default="", index=True)
    model_name: Mapped[str] = mapped_column(String(128), default="", index=True)
    llm_calls: Mapped[int] = mapped_column(Integer, default=0)
    cache_hit_calls: Mapped[int] = mapped_column(Integer, default=0)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cached_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    new_input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    estimated_input_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_cached_input_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_cache_write_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_output_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_total_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("pipeline_run_id", "provider", "model_name", name="uq_run_model_usage"),
    )


class RunStreamRecord(Base):
    __tablename__ = "run_streams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey("pipeline_runs.id", ondelete="CASCADE"), index=True)
    stream_url: Mapped[str] = mapped_column(Text)
    source_url: Mapped[str] = mapped_column(Text, default="")
    protocol: Mapped[str] = mapped_column(String(32), default="")
    quality: Mapped[str] = mapped_column(String(64), default="")
    source_layer: Mapped[str] = mapped_column(String(128), default="")
    server_label: Mapped[str] = mapped_column(String(128), default="")
    dedupe_hash: Mapped[str] = mapped_column(String(128), index=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("pipeline_run_id", "dedupe_hash", name="uq_run_stream_dedupe"),
    )


class RunScreenshotRecord(Base):
    __tablename__ = "run_screenshots"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey("pipeline_runs.id", ondelete="CASCADE"), index=True)
    agent_run_id: Mapped[int | None] = mapped_column(ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True, index=True)
    screenshot_url: Mapped[str] = mapped_column(Text)
    source_url: Mapped[str] = mapped_column(Text, default="")
    label: Mapped[str] = mapped_column(String(128), default="")
    actor: Mapped[str] = mapped_column(String(128), default="", index=True)
    agent_type: Mapped[str] = mapped_column(String(32), default="", index=True)
    invocation_index: Mapped[int] = mapped_column(Integer, default=0)
    tool_name: Mapped[str] = mapped_column(String(128), default="")
    target_url: Mapped[str] = mapped_column(Text, default="")
    seq: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class ProviderAnalysisRecord(Base):
    __tablename__ = "provider_analyses"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey("pipeline_runs.id", ondelete="CASCADE"), index=True)
    stream_url: Mapped[str] = mapped_column(Text, default="")
    ip: Mapped[str] = mapped_column(String(128), default="")
    hostname: Mapped[str] = mapped_column(String(255), default="")
    org: Mapped[str] = mapped_column(Text, default="")
    provider: Mapped[str] = mapped_column(Text, default="")
    country: Mapped[str] = mapped_column(String(64), default="")
    region: Mapped[str] = mapped_column(String(128), default="")
    city: Mapped[str] = mapped_column(String(128), default="")
    abuse_email: Mapped[str] = mapped_column(String(255), default="")
    whois_raw: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class TakedownEmailRecord(Base):
    __tablename__ = "takedown_emails"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    pipeline_run_id: Mapped[int] = mapped_column(ForeignKey("pipeline_runs.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(Text, default="")
    abuse_email: Mapped[str] = mapped_column(String(255), default="")
    channel_name: Mapped[str] = mapped_column(String(255), default="", index=True)
    subject: Mapped[str] = mapped_column(Text, default="")
    body: Mapped[str] = mapped_column(Text, default="")
    infringing_url: Mapped[str] = mapped_column(Text, default="")
    stream_urls_json: Mapped[list] = mapped_column(JSON, default=list)
    screenshot_urls_json: Mapped[list] = mapped_column(JSON, default=list)
    server_labels_json: Mapped[list] = mapped_column(JSON, default=list)
    stream_evidence_json: Mapped[list] = mapped_column(JSON, default=list)
    provider_info_json: Mapped[dict] = mapped_column(JSON, default=dict)
    rights_owner_reference_url: Mapped[str] = mapped_column(Text, default="")
    generated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class MemoryEntryRecord(Base):
    __tablename__ = "memory_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    domain: Mapped[str] = mapped_column(String(255), index=True)
    page_type: Mapped[str] = mapped_column(String(32), index=True)
    source_run_id: Mapped[str] = mapped_column(String(64), default="", index=True)
    source_agent_run_id: Mapped[int | None] = mapped_column(ForeignKey("agent_runs.id", ondelete="SET NULL"), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(32), default="unknown", index=True)
    success: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    url: Mapped[str] = mapped_column(Text, default="")
    data_json: Mapped[dict] = mapped_column(JSON, default=dict)
    result_summary: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


class MemoryHintUsedRecord(Base):
    __tablename__ = "memory_hints_used"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    agent_run_id: Mapped[int] = mapped_column(ForeignKey("agent_runs.id", ondelete="CASCADE"), index=True)
    memory_entry_id: Mapped[int] = mapped_column(ForeignKey("memory_entries.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("agent_run_id", "memory_entry_id", name="uq_memory_hint_used"),
    )


class PricingConfigRecord(Base):
    __tablename__ = "pricing_configs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    provider: Mapped[str] = mapped_column(String(64), default="", index=True)
    model_name: Mapped[str] = mapped_column(String(128), index=True)
    input_per_million: Mapped[float] = mapped_column(Float, default=0.0)
    output_per_million: Mapped[float] = mapped_column(Float, default=0.0)
    cached_input_per_million: Mapped[float] = mapped_column(Float, default=0.0)
    cache_write_per_million: Mapped[float] = mapped_column(Float, default=0.0)
    context_window: Mapped[int] = mapped_column(Integer, default=0)
    active: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        UniqueConstraint("provider", "model_name", name="uq_pricing_configs_provider_model"),
    )


class DatasetSiteRecord(Base):
    __tablename__ = "dataset_sites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    canonical_url: Mapped[str] = mapped_column(String(1024), unique=True, index=True)
    url: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(32), default="csv_seed", index=True)
    language: Mapped[str] = mapped_column(String(32), default="", index=True)
    label: Mapped[str] = mapped_column(String(32), default="", index=True)
    notes: Mapped[str] = mapped_column(Text, default="")
    total_runs: Mapped[int] = mapped_column(Integer, default=0)
    successful_runs: Mapped[int] = mapped_column(Integer, default=0)
    failed_runs: Mapped[int] = mapped_column(Integer, default=0)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
    last_success_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DatasetBatchRecord(Base):
    __tablename__ = "dataset_batches"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    batch_name: Mapped[str] = mapped_column(String(128), default="", index=True)
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    source: Mapped[str] = mapped_column(String(32), default="dataset", index=True)
    language_filter: Mapped[str] = mapped_column(String(32), default="", index=True)
    label_filter: Mapped[str] = mapped_column(String(32), default="", index=True)
    requested_count: Mapped[int] = mapped_column(Integer, default=0)
    completed_count: Mapped[int] = mapped_column(Integer, default=0)
    passed_count: Mapped[int] = mapped_column(Integer, default=0)
    failed_count: Mapped[int] = mapped_column(Integer, default=0)
    cancelled_count: Mapped[int] = mapped_column(Integer, default=0)
    urls_json: Mapped[list] = mapped_column(JSON, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class DatasetSiteRunRecord(Base):
    __tablename__ = "dataset_site_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    batch_id: Mapped[int] = mapped_column(ForeignKey("dataset_batches.id", ondelete="CASCADE"), index=True)
    site_id: Mapped[int | None] = mapped_column(ForeignKey("dataset_sites.id", ondelete="SET NULL"), nullable=True, index=True)
    run_id: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    url: Mapped[str] = mapped_column(Text, default="")
    language: Mapped[str] = mapped_column(String(32), default="", index=True)
    label: Mapped[str] = mapped_column(String(32), default="", index=True)
    status: Mapped[str] = mapped_column(String(32), default="queued", index=True)
    final_status: Mapped[str] = mapped_column(String(32), default="", index=True)
    stream_count: Mapped[int] = mapped_column(Integer, default=0)
    total_cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    error_text: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
