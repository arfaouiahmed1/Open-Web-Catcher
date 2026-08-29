"""Shared base types for the pipeline data models (plan task 14, batch W3).

Canonical home for:
- the shared enumerations previously defined in ``src/models/enums.py``
  (which is now a pure re-export shim kept for import compatibility);
- ``PipelineModel``, the strict Pydantic base every pipeline model inherits.
  It sets ``model_config = ConfigDict(extra="forbid")`` so instantiating any
  stage result with an unknown field raises ``pydantic.ValidationError``
  instead of silently dropping data (plan acceptance criterion).
"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, ConfigDict


class PageType(StrEnum):
    LANDING = "landing_page"
    HOSTING = "hosting_page"
    EMBEDDED = "embedded_page"
    UNKNOWN = "unknown"


class Confidence(StrEnum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class ExtractionStatus(StrEnum):
    SUCCESS = "success"
    PARTIAL = "partial"
    FAILED = "failed"
    TIMEOUT = "timeout"
    SITE_DEAD = "site_dead"
    REDIRECT = "redirect"
    PAGE_INACCESSIBLE = "page_inaccessible"
    NO_HOSTING_PAGES = "no_hosting_pages"
    NO_STREAMS = "no_streams"
    NO_TARGET = "no_target"


class AgentType(StrEnum):
    CLASSIFICATION = "classification"
    LANDING_PAGE = "landing_page"
    HOSTING_PAGE = "hosting_page"
    EMBEDDED_PAGE = "embedded_page"
    ORCHESTRATOR = "orchestrator"


class FailureKind(StrEnum):
    """Typed failure taxonomy for pipeline outcomes (plan T30 / AGT-H3/H4/M7/M8).

    Replaces ad-hoc ``"timed out" in error_text.lower()`` string matching so
    routing decisions, persisted failure modes, and UI surfacing share one
    closed vocabulary instead of substring guesses.
    """

    UNKNOWN = "unknown"
    TIMEOUT = "timeout"
    WORKFLOW_TIMEOUT = "workflow_timeout"
    BUDGET_EXCEEDED = "budget_exceeded"
    CANCELLED = "cancelled"
    SITE_INACCESSIBLE = "site_inaccessible"
    AGENT_ERROR = "agent_error"


class PipelineModel(BaseModel):
    """Strict base for all pipeline models: unknown fields are rejected."""

    model_config = ConfigDict(extra="forbid")


class EventKind(StrEnum):
    """Typed taxonomy of runtime-event kinds (plan T31 / SCH-M6/H5).

    Closed vocabulary for ``RuntimeEvent.kind`` values emitted across the
    orchestrator/agents and persisted to the ``runtime_events`` table. The
    runtime_events write path validates against this enum: unknown kinds raise
    in dev environments and coerce to ``UNKNOWN`` with a warning in prod.
    """

    # Lifecycle
    RUN_STARTED = "run_started"
    PIPELINE_STARTED = "pipeline_started"
    PIPELINE_FINISHED = "pipeline_finished"
    PIPELINE_FAILED = "pipeline_failed"
    PIPELINE_HALTED = "pipeline_halted"
    RUN_CANCELLED = "run_cancelled"
    CANCEL_REQUESTED = "cancel_requested"

    # Agent loop
    AGENT = "agent"
    AGENT_STARTED = "agent_started"
    AGENT_FINISHED = "agent_finished"
    AGENT_LOOP_STARTED = "agent_loop_started"
    AGENT_LOOP_FINISHED = "agent_loop_finished"
    AGENT_STOP_REQUESTED = "agent_stop_requested"
    AGENT_TIMEOUT = "agent_timeout"
    ORCHESTRATOR_DECISION = "orchestrator_decision"
    ORCHESTRATOR_HANDOFF_RECEIVED = "orchestrator_handoff_received"
    EMBEDDED_HANDOFF_MISSING = "embedded_handoff_missing"

    # LLM
    CHAIN = "chain"
    LLM_TURN_STARTED = "llm_turn_started"
    LLM_RESPONSE = "llm_response"
    LLM_RETRY_SCHEDULED = "llm_retry_scheduled"
    LLM_RATE_LIMITED = "llm_rate_limited"
    LLM_TIMEOUT = "llm_timeout"
    LLM_ERROR = "llm_error"

    # Tools
    TOOL = "tool"
    TOOL_CALL_STARTED = "tool_call_started"
    TOOL_CALL_FINISHED = "tool_call_finished"
    TOOL_GUARDRAIL_WARNING = "tool_guardrail_warning"
    TOOL_SESSION_CONNECTING = "tool_session_connecting"
    TOOL_SESSION_READY = "tool_session_ready"
    TOOL_SESSION_FAILED = "tool_session_failed"
    TOOL_SESSION_CLOSED = "tool_session_closed"

    # Prompts / memory / context
    PROMPT_COMPILED = "prompt_compiled"
    MEMORY_LOADED = "memory_loaded"
    MEMORY_LOAD_FAILED = "memory_load_failed"
    MEMORY_SAVED = "memory_saved"
    MEMORY_SAVE_FAILED = "memory_save_failed"
    MEMORY_SKIPPED = "memory_skipped"
    CONTEXT_COMPACTION_STARTED = "context_compaction_started"
    CONTEXT_COMPACTION_FINISHED = "context_compaction_finished"

    # Budget / pricing
    BUDGET_EXHAUSTED = "budget_exhausted"
    COST_THRESHOLD_EXCEEDED = "cost_threshold_exceeded"
    PRICING_MISSING = "pricing_missing"

    # Typed notifications (plan T34)
    SERVER_ACTIVATED = "server_activated"
    STREAM_EXTRACTED = "stream_extracted"
    HOSTING_PAGE_DISCOVERED = "hosting_page_discovered"
    PLAYER_FAILED = "player_failed"

    # Streaming pools (plan T28 / streaming role contracts spike §D6)
    QUEUE_ENQUEUED = "queue_enqueued"
    HOSTING_ITEM_STARTED = "hosting_item_started"
    HOSTING_ITEM_FINISHED = "hosting_item_finished"
    POOL_DRAINED = "pool_drained"

    UNKNOWN = "unknown"


class EventStatus(StrEnum):
    """Typed status vocabulary for runtime events (plan T31 / SCH-M6/H5)."""

    INFO = "info"
    STARTED = "started"
    RUNNING = "running"
    OK = "ok"
    SUCCESS = "success"
    SUCCEEDED = "succeeded"
    WARNING = "warning"
    ERROR = "error"
    FAILED = "failed"
    RETRYING = "retrying"
    CANCELLED = "cancelled"
    PARTIAL = "partial"
    SKIPPED = "skipped"
