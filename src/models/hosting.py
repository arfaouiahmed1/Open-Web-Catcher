"""Hosting/extraction-stage models (plan task 14, batch W3).

Canonical home for the per-URL extraction-result family produced by the
stream-extractor agents:

- ``StreamURL`` — one discovered stream (HLS/DASH/MP4/...),
- ``ServerResult`` — probing outcome for a single server/embed slot,
- ``ExtractionResult`` — the aggregated per-match extraction output.

The embedded-page agent reuses the same shapes (its runs are recorded as
``ExtractionResult`` with ``page_type=EMBEDDED``); no embedded-specific
model exists yet. ``src/models/embedded.py`` documents that seam.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from pydantic import Field

from src.models.common import (
    AgentType,
    ExtractionStatus,
    PageType,
    PipelineModel,
)


class StreamURL(PipelineModel):
    url: str
    protocol: str = ""  # hls / dash / mp4 / etc.
    quality: str = ""
    source_layer: str = ""  # which server/layer captured it
    channel_name: str = ""
    captured_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class ServerResult(PipelineModel):
    label: str = "default"
    source_group: str | None = None
    source_index: int | None = None
    source_url: str | None = None
    route_pattern: str | None = None
    current_marker: bool = False
    server_up: bool = True
    m3u8_urls: list[str] = Field(default_factory=list)
    mpd_urls: list[str] = Field(default_factory=list)
    mp4_urls: list[str] = Field(default_factory=list)
    stream_urls: list[str] = Field(default_factory=list)
    protocol_details: list[dict[str, Any]] = Field(default_factory=list)
    primary_stream: str | None = None
    screenshot_url: str | None = None  # Cloudinary URL
    embedded_url: str | None = None  # set when needs_embed_agent
    embedded_url_source: str | None = None
    player_iframe_url: str | None = None
    status: str = "failed"  # success / failed / needs_embed_agent
    down_reason: str | None = None
    activation_attempts: int = 0
    player_state: str | None = None
    visual_confirmation: str | None = None
    extraction_method: str | None = None
    detected_channel: str | None = None
    channel_candidates: list[str] = Field(default_factory=list)
    channel_confidence: str | None = None
    channel_detection_method: str | None = None
    language: str | None = None
    language_candidates: list[str] = Field(default_factory=list)
    ocr_text: str | None = None
    playback_confirmed: bool = False
    server_change_observed: bool = False
    network_diagnostics: list[dict[str, Any]] = Field(default_factory=list)
    iframe_diagnostics: list[dict[str, Any]] = Field(default_factory=list)
    popup_window_diagnostics: list[dict[str, Any]] = Field(default_factory=list)


class ExtractionResult(PipelineModel):
    url: str
    page_type: PageType
    status: ExtractionStatus
    servers: list[ServerResult] = Field(default_factory=list)
    streams: list[StreamURL] = Field(default_factory=list)
    screenshots: list[str] = Field(default_factory=list)  # Cloudinary URLs
    embedded_urls: list[str] = Field(default_factory=list)  # iframes needing embedded agent
    primary_channel: str = ""
    detected_channels: list[str] = Field(default_factory=list)
    channel_metadata: dict[str, Any] = Field(default_factory=dict)
    agent_type: AgentType
    tool_calls_used: int = 0
    duration_seconds: float = 0.0
    error_message: str = ""
    metadata: dict[str, Any] = Field(default_factory=dict)
