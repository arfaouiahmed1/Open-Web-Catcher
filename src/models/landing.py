"""Landing-page-stage models (plan task 14, batch W3).

Canonical home for ``MatchInfo`` — a single watchable item discovered by
the Landing Page Agent.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from src.models.common import PipelineModel


class MatchInfo(PipelineModel):
    """A single watchable item discovered by the Landing Page Agent."""

    url: str
    title: str = ""
    participants: str | None = None  # "Team A vs Team B"
    team1: str | None = None
    team2: str | None = None
    score: str | None = None
    channel: str | None = None
    channel_candidates: list[str] = Field(default_factory=list)
    sport: str | None = None
    league: str | None = None
    type: str | None = None
    status: str = "unknown"  # live / upcoming / not_live / unknown
    scheduled_time: str | None = None
    confidence: int = 70  # 0-100
    # stream_extractor = hosting-first, embed_agent = direct embedded URL only.
    route: str = "stream_extractor"
    iframes: list[str] = Field(default_factory=list)
    video_srcs: list[str] = Field(default_factory=list)
    player_urls: list[str] = Field(default_factory=list)
    entry_point: str = ""
    route_source: str = ""
    redirect_chain: list[str] = Field(default_factory=list)
    screenshot_url: str | None = None
    visual_evidence: str | list[str] | None = None
    server_hints: list[dict[str, Any]] = Field(default_factory=list)
    patterns: dict[str, Any] = Field(default_factory=dict)
    metadata: dict[str, Any] = Field(default_factory=dict)
