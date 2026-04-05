"""Pydantic data models for the pipeline."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field, HttpUrl

from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType


class ClassificationResult(BaseModel):
    url: str
    page_type: PageType
    confidence: Confidence
    reasoning: str = ""
    raw_html_snippet: str = ""
    agent_type: AgentType = AgentType.CLASSIFICATION


class StreamURL(BaseModel):
    url: str
    protocol: str = ""          # hls / dash / mp4 / etc.
    quality: str = ""
    source_layer: str = ""      # which CDP layer caught it
    captured_at: datetime = Field(default_factory=datetime.utcnow)


class ServerResult(BaseModel):
    server_url: str
    status: ExtractionStatus
    streams: list[StreamURL] = Field(default_factory=list)
    tool_calls_used: int = 0
    error_message: str = ""


class ExtractionResult(BaseModel):
    url: str
    page_type: PageType
    status: ExtractionStatus
    servers: list[ServerResult] = Field(default_factory=list)
    streams: list[StreamURL] = Field(default_factory=list)
    screenshots: list[str] = Field(default_factory=list)   # Cloudinary URLs
    agent_type: AgentType
    tool_calls_used: int = 0
    duration_seconds: float = 0.0
    error_message: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)


class RunMetrics(BaseModel):
    run_id: str
    url: str
    started_at: datetime = Field(default_factory=datetime.utcnow)
    finished_at: datetime | None = None
    total_tokens_in: int = 0
    total_tokens_out: int = 0
    total_tool_calls: int = 0
    total_duration_seconds: float = 0.0
    agents_invoked: list[AgentType] = Field(default_factory=list)
    success: bool = False
    failure_mode: str = ""


class PipelineResult(BaseModel):
    run_id: str
    url: str
    classification: ClassificationResult | None = None
    extraction: ExtractionResult | None = None
    metrics: RunMetrics | None = None
    final_status: ExtractionStatus = ExtractionStatus.FAILED
    streams: list[StreamURL] = Field(default_factory=list)
    screenshots: list[str] = Field(default_factory=list)
    evidence_package: dict[str, Any] = Field(default_factory=dict)
