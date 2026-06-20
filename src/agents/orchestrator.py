"""LangGraph orchestrator for the full extraction pipeline."""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from functools import partial
from typing import Any, TypedDict, cast
from urllib.parse import urlparse

from langgraph.graph import END, START, StateGraph

from src.memory.long_term import LongTermMemory
from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import (
    ClassificationResult,
    ExtractionResult,
    MatchInfo,
    PipelineResult,
    ProviderInfo,
    StreamURL,
    TakedownEmail,
)
from src.tools.email_tool import EmailTool
from src.tools.ipinfo_tool import IPInfoTool
from src.utils.config import Settings
from src.utils.instrumentation import (
    observability_span,
    set_span_output,
    using_observability_context,
)
from src.utils.logging import get_logger
from src.utils.observability import RunObserver, get_observability_status, run_registry

logger = get_logger(__name__)


class HandoffContext(TypedDict, total=False):
    """Structured context passed from orchestrator to each child agent.

    All fields are optional so callers only populate what they have.
    Use ``render_handoff()`` to convert to a prompt string.
    """

    root_url: str
    target_url: str
    target_label: str
    page_type: str
    classification_reasoning: str
    candidate_title: str
    candidate_participants: str
    candidate_team1: str
    candidate_team2: str
    candidate_score: str
    candidate_status: str
    candidate_time: str
    candidate_league: str
    candidate_type: str
    candidate_sport: str
    candidate_channel: str
    candidate_channel_candidates: list[str]
    landing_screenshot_url: str
    landing_visual_evidence: str
    landing_server_hints: list[dict[str, Any]]
    landing_route: str
    landing_route_source: str
    landing_redirect_chain: list[str]
    landing_iframes: list[str]
    landing_video_srcs: list[str]
    landing_player_urls: list[str]
    recovery_url: str
    route_source: str
    navigation_policy: str
    required_evidence: list[str]
    source_hosting_url: str
    source_hosting_status: str
    source_hosting_decision: str
    source_streams_found: int
    focus: str
    memory_hints: str
    pattern_context: str


_SAME_CONTENT_NAVIGATION_POLICY = (
    "same-content okay: allow server/source URL changes only when the same event/player stays in focus; "
    "do not navigate to another match, fixture, channel, listing, homepage, or article; "
    "treat ad redirects, unrelated pages, homepages, and off-target provider detours as drift and recover "
    "to the assigned target URL"
)
_HOSTING_EVIDENCE_CHECKLIST = [
    "dismiss popups/overlays that cover the player before declaring a server failed",
    "switch only same-content server/source controls, not other matches or channels",
    "verify the player works before extraction and after every server switch",
    "record screenshot_url for each server attempt",
    "record extracted m3u8/mpd/mp4 URLs for each server attempt",
    "record embedded_url or player_iframe_url when present",
    "record network_diagnostics and iframe_diagnostics",
    "record popup_window_diagnostics for opened, blocked, adopted, or closed popup/window targets, including opened_targets, blocked_popup_attempts, target_decision, and blocked_by_client evidence",
    "record confirmed player_state before concluding on a server",
    "record detected channel metadata and screenshot-derived OCR text when the broadcast name is visible",
]
_EMBEDDED_EVIDENCE_CHECKLIST = [
    "dismiss popups/overlays that cover the player before declaring a source failed",
    "switch only same-player source/server controls, not other matches or channels",
    "stay on the assigned embedded URL and do not drift back into host-page exploration",
    "record screenshot_url for each server/source attempt",
    "record extracted m3u8/mpd/mp4 URLs for each server/source attempt",
    "record embedded_url or player_iframe_url when present",
    "record network_diagnostics and iframe_diagnostics",
    "record popup_window_diagnostics for opened, blocked, adopted, or closed popup/window targets, including opened_targets, blocked_popup_attempts, target_decision, and blocked_by_client evidence",
    "record confirmed player_state before concluding on a server/source",
    "record detected channel metadata and screenshot-derived OCR text when the broadcast name is visible",
]


def render_handoff(ctx: HandoffContext) -> str:
    """Serialize HandoffContext to a human-readable prompt string."""
    lines = ["ORCHESTRATOR HANDOFF"]

    root_url = ctx.get("root_url")
    if root_url:
        lines.append(f"- root url: {root_url}")

    target_url = ctx.get("target_url")
    if target_url:
        target_label = str(ctx.get("target_label") or "target url")
        lines.append(f"- {target_label}: {target_url}")

    page_type = ctx.get("page_type")
    if page_type:
        lines.append(f"- upstream classification: {page_type}")

    classification_reasoning = ctx.get("classification_reasoning")
    if classification_reasoning:
        lines.append(f"- classification reasoning: {_truncate(classification_reasoning)}")

    candidate_title = ctx.get("candidate_title")
    if candidate_title:
        lines.append(f"- candidate title: {_truncate(candidate_title, max_chars=180)}")

    candidate_participants = ctx.get("candidate_participants")
    if candidate_participants:
        lines.append(f"- participants: {_truncate(candidate_participants, max_chars=180)}")

    candidate_team1 = ctx.get("candidate_team1")
    candidate_team2 = ctx.get("candidate_team2")
    if candidate_team1 or candidate_team2:
        lines.append(
            f"- teams: {_truncate(candidate_team1, max_chars=90) or 'unknown'} vs "
            f"{_truncate(candidate_team2, max_chars=90) or 'unknown'}"
        )

    candidate_status = ctx.get("candidate_status")
    if candidate_status:
        lines.append(f"- landing status: {candidate_status}")

    candidate_score = ctx.get("candidate_score")
    if candidate_score:
        lines.append(f"- landing score: {_truncate(candidate_score, max_chars=80)}")

    candidate_time = ctx.get("candidate_time")
    if candidate_time:
        lines.append(f"- landing scheduled time: {_truncate(candidate_time, max_chars=80)}")

    candidate_league = ctx.get("candidate_league")
    if candidate_league:
        lines.append(f"- landing league: {_truncate(candidate_league, max_chars=140)}")

    candidate_type = ctx.get("candidate_type")
    if candidate_type:
        lines.append(f"- landing type: {_truncate(candidate_type, max_chars=140)}")

    candidate_sport = ctx.get("candidate_sport")
    if candidate_sport:
        lines.append(f"- landing sport: {_truncate(candidate_sport, max_chars=120)}")

    candidate_channel = ctx.get("candidate_channel")
    if candidate_channel:
        lines.append(f"- landing channel: {_truncate(candidate_channel, max_chars=140)}")

    candidate_channel_candidates = ctx.get("candidate_channel_candidates")
    if candidate_channel_candidates:
        lines.append(
            f"- landing channel candidates: {', '.join(candidate_channel_candidates[:6])}"
        )

    landing_screenshot_url = ctx.get("landing_screenshot_url")
    if landing_screenshot_url:
        lines.append(f"- landing screenshot evidence: {landing_screenshot_url}")

    landing_visual_evidence = ctx.get("landing_visual_evidence")
    if landing_visual_evidence:
        lines.append(
            f"- landing visual evidence: {_truncate(landing_visual_evidence, max_chars=240)}"
        )

    landing_server_hints = ctx.get("landing_server_hints")
    if landing_server_hints:
        hint_lines: list[str] = []
        for item in landing_server_hints[:8]:
            if not isinstance(item, dict):
                continue
            label = _truncate(str(item.get("label") or item.get("text") or ""), max_chars=80)
            source_group = _truncate(str(item.get("source_group") or item.get("provider") or ""), max_chars=60)
            source_url = _truncate(str(item.get("source_url") or item.get("url") or item.get("href") or ""), max_chars=160)
            selector = _truncate(str(item.get("selector") or item.get("xpath") or ""), max_chars=120)
            parts = [part for part in (source_group, label, source_url, selector) if part]
            if parts:
                hint_lines.append(" / ".join(parts))
        if hint_lines:
            lines.append(f"- landing server/source hints: {'; '.join(hint_lines)}")

    landing_route = ctx.get("landing_route")
    if landing_route:
        lines.append(f"- landing suggested route: {landing_route}")

    landing_route_source = ctx.get("landing_route_source")
    if landing_route_source:
        lines.append(f"- landing route source: {landing_route_source}")

    landing_redirect_chain = ctx.get("landing_redirect_chain")
    if landing_redirect_chain:
        lines.append(f"- landing redirect chain: {' -> '.join(landing_redirect_chain[:6])}")

    landing_iframes = ctx.get("landing_iframes")
    if landing_iframes:
        lines.append(f"- landing iframes to watch: {', '.join(landing_iframes[:4])}")

    landing_video_srcs = ctx.get("landing_video_srcs")
    if landing_video_srcs:
        lines.append(f"- landing video srcs to inspect: {', '.join(landing_video_srcs[:4])}")

    landing_player_urls = ctx.get("landing_player_urls")
    if landing_player_urls:
        lines.append(f"- landing player urls to inspect: {', '.join(landing_player_urls[:4])}")

    recovery_url = ctx.get("recovery_url")
    if recovery_url:
        lines.append(f"- recovery url: {recovery_url}")

    route_source = ctx.get("route_source")
    if route_source:
        lines.append(f"- route source: {route_source}")

    navigation_policy = ctx.get("navigation_policy")
    if navigation_policy:
        lines.append(f"- navigation policy: {navigation_policy}")

    required_evidence = ctx.get("required_evidence")
    if required_evidence:
        lines.append(f"- required evidence: {', '.join(required_evidence[:6])}")

    source_hosting_url = ctx.get("source_hosting_url")
    if source_hosting_url:
        lines.append(f"- source hosting page: {source_hosting_url}")

    source_hosting_status = ctx.get("source_hosting_status")
    if source_hosting_status:
        lines.append(f"- source hosting status: {source_hosting_status}")

    source_hosting_decision = ctx.get("source_hosting_decision")
    if source_hosting_decision:
        lines.append(f"- source hosting decision: {source_hosting_decision}")

    source_streams_found = ctx.get("source_streams_found")
    if source_streams_found:
        lines.append(f"- source hosting already found streams: {source_streams_found}")

    focus = ctx.get("focus")
    if focus:
        lines.append(f"- focus: {focus}")

    pattern_context = ctx.get("pattern_context")
    if pattern_context:
        lines.append(f"- pattern context: {pattern_context}")

    memory_hints = ctx.get("memory_hints")
    if memory_hints:
        lines.append("- memory check: prior hints found for this domain; use as soft guidance")
        lines.append(_truncate(memory_hints, max_chars=1200))
    return "\n".join(lines)


class PipelineState(TypedDict):
    url: str
    run_id: str
    classification: ClassificationResult | None
    matches: list[MatchInfo]
    extraction_results: list[ExtractionResult]
    pending_hosting_urls: list[str]
    pending_embedded_urls: list[str]
    provider_analysis: list[ProviderInfo]
    takedown_emails: list[TakedownEmail]
    error: str


def _dedupe_urls(urls: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for url in urls:
        if url and url not in seen:
            seen.add(url)
            result.append(url)
    return result


def _emit_orchestrator_decision(
    observer: RunObserver | None,
    message: str,
    *,
    status: str = "info",
    details: dict[str, Any] | None = None,
) -> None:
    if observer is None:
        return
    observer.emit(
        "orchestrator_decision",
        message,
        status=status,
        details=details or {},
    )


_OFF_TARGET_EMBEDDED_URL_SIGNALS = (
    "adserver",
    "adsystem",
    "doubleclick",
    "googlesyndication",
    "googleadservices",
    "popads",
    "popcash",
    "propeller",
    "onclick",
    "taboola",
    "outbrain",
    "casino",
    "betting",
    "sportsbook",
    "download",
    "apk",
    "appstore",
    "play.google.com",
    "facebook.com",
    "telegram",
    "twitter.com",
    "x.com/",
    "discord",
    "whatsapp",
    "/news/",
    "/article/",
    "/category/",
    "/tag/",
    "/login",
    "/register",
    "/subscribe",
    "/premium",
    "/checkout",
)


def _embedded_candidate_allowed_from_hosting(candidate_url: str, *, hosting_url: str) -> bool:
    candidate = str(candidate_url or "").strip()
    if not candidate.startswith(("http://", "https://")):
        return False
    if candidate.rstrip("/") == str(hosting_url or "").strip().rstrip("/"):
        return False
    if _looks_like_provider_stream_url(candidate):
        return False
    lowered = candidate.lower()
    return not any(signal in lowered for signal in _OFF_TARGET_EMBEDDED_URL_SIGNALS)


def _collect_embedded_urls(extraction: ExtractionResult) -> list[str]:
    urls = list(extraction.embedded_urls)
    for key in ("servers_needing_embed", "embedded_urls_for_processing", "embedded_urls"):
        raw_values = extraction.metadata.get(key, [])
        if isinstance(raw_values, list):
            urls.extend(str(value or "").strip() for value in raw_values)
        elif isinstance(raw_values, str):
            urls.append(raw_values.strip())
    for server in extraction.servers:
        if server.embedded_url:
            urls.append(server.embedded_url)
        if server.player_iframe_url:
            urls.append(server.player_iframe_url)
    for server in extraction.metadata.get("servers", []):
        if not isinstance(server, dict):
            continue
        for key in ("embedded_url", "player_iframe_url"):
            candidate = str(server.get(key) or "").strip()
            if candidate:
                urls.append(candidate)
    return _dedupe_urls(
        [
            url
            for url in urls
            if _embedded_candidate_allowed_from_hosting(url, hosting_url=extraction.url)
        ]
    )


def _extraction_evidence_overview(extraction_results: list[ExtractionResult]) -> dict[str, int]:
    stream_count = len(_collect_all_streams(extraction_results))
    screenshot_count = len(_collect_all_screenshots(extraction_results))
    server_count = 0
    network_diagnostics_count = 0
    iframe_diagnostics_count = 0

    for extraction in extraction_results:
        server_count += len(extraction.servers)
        network_diagnostics_count += sum(
            len(server.network_diagnostics or []) for server in extraction.servers
        )
        iframe_diagnostics_count += sum(
            len(server.iframe_diagnostics or []) for server in extraction.servers
        )
        for server in extraction.metadata.get("servers", []):
            if not isinstance(server, dict):
                continue
            network_values = server.get("network_diagnostics", [])
            iframe_values = server.get("iframe_diagnostics", [])
            if isinstance(network_values, list):
                network_diagnostics_count += len(
                    [item for item in network_values if isinstance(item, dict)]
                )
            if isinstance(iframe_values, list):
                iframe_diagnostics_count += len(
                    [item for item in iframe_values if isinstance(item, dict)]
                )

    return {
        "extraction_count": len(extraction_results),
        "server_count": server_count,
        "stream_count": stream_count,
        "screenshot_count": screenshot_count,
        "network_diagnostics_count": network_diagnostics_count,
        "iframe_diagnostics_count": iframe_diagnostics_count,
    }


def _normalize_domain(url: str) -> str:
    host = (urlparse(str(url or "").strip()).netloc or "").lower().strip()
    return host[4:] if host.startswith("www.") else host


def _same_site_or_subdomain(candidate_url: str, reference_url: str) -> bool:
    candidate_domain = _normalize_domain(candidate_url)
    reference_domain = _normalize_domain(reference_url)
    if not candidate_domain or not reference_domain:
        return False
    return (
        candidate_domain == reference_domain
        or candidate_domain.endswith(f".{reference_domain}")
        or reference_domain.endswith(f".{candidate_domain}")
    )


def _looks_like_direct_embed_url(url: str) -> bool:
    parsed = urlparse(str(url or "").strip())
    host = (parsed.netloc or "").lower()
    path = (parsed.path or "").lower()
    query = (parsed.query or "").lower()
    embed_tokens = ("embed", "player", "iframe")
    if any(token in host for token in embed_tokens):
        return True
    if any(token in path for token in ("/embed", "/player", "/iframe", "/e/")):
        return True
    return bool(re.search(r"(^|[?&])(embed|player|iframe)=", query))


def _normalize_landing_route(route: str) -> str:
    return (
        "embed_agent" if str(route or "").strip().lower() == "embed_agent" else "stream_extractor"
    )


def _resolve_landing_match_route(match: MatchInfo, *, root_url: str) -> str:
    return "stream_extractor"


def _split_landing_match_handoff_targets(match: MatchInfo) -> tuple[list[str], list[str]]:
    embedded_targets: list[str] = []
    direct_streams: list[str] = []
    iframe_set = set(match.iframes)
    video_set = set(match.video_srcs)
    player_set = set(match.player_urls)
    for candidate in _landing_match_handoff_urls(match):
        if not candidate.startswith(("http://", "https://")):
            continue
        if _looks_like_provider_stream_url(candidate):
            direct_streams.append(candidate)
            continue
        if (
            _looks_like_direct_embed_url(candidate)
            or candidate in iframe_set
            or candidate in video_set
            or candidate in player_set
        ):
            embedded_targets.append(candidate)
    return _dedupe_urls(embedded_targets), _dedupe_urls(direct_streams)


def _truncate(value: Any, *, max_chars: int = 700) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return text if len(text) <= max_chars else f"{text[: max_chars - 3]}..."


def _memory_hint(memory: LongTermMemory | None, *, url: str, page_type: str, limit: int = 3) -> str:
    if memory is None:
        return ""
    try:
        return memory.build_prompt_context(url=url, page_type=page_type, limit=limit)
    except Exception:
        return ""


def _match_for_url(matches: list[MatchInfo], target_url: str) -> MatchInfo | None:
    target = str(target_url or "").strip()
    if not target:
        return None
    for item in matches:
        if item.url == target:
            return item
    return None


def _landing_match_handoff_urls(match: MatchInfo) -> list[str]:
    metadata = match.metadata if isinstance(match.metadata, dict) else {}
    metadata_urls: list[str] = []
    for key in ("player_handoff_urls", "direct_stream_urls", "embedded_urls", "player_urls"):
        values = metadata.get(key, [])
        if isinstance(values, list):
            metadata_urls.extend(str(value or "").strip() for value in values)
        elif isinstance(values, str):
            metadata_urls.append(values.strip())
    return _dedupe_urls(
        [
            *match.iframes,
            *match.video_srcs,
            *match.player_urls,
            *metadata_urls,
        ]
    )


def _match_containing_handoff_url(matches: list[MatchInfo], target_url: str) -> MatchInfo | None:
    target = str(target_url or "").strip()
    if not target:
        return None
    for item in matches:
        if target in _landing_match_handoff_urls(item):
            return item
    return None


def _format_visual_evidence(value: str | list[str] | None) -> str:
    if isinstance(value, list):
        return "; ".join(str(item or "").strip() for item in value if item)
    return str(value or "").strip()


def _add_match_handoff_context(ctx: HandoffContext, match: MatchInfo) -> None:
    ctx["candidate_title"] = match.title or ""
    ctx["candidate_participants"] = match.participants or ""
    ctx["candidate_team1"] = match.team1 or ""
    ctx["candidate_team2"] = match.team2 or ""
    ctx["candidate_score"] = match.score or ""
    ctx["candidate_status"] = match.status or ""
    ctx["candidate_time"] = match.scheduled_time or ""
    ctx["candidate_league"] = match.league or ""
    ctx["candidate_type"] = match.type or ""
    ctx["candidate_sport"] = match.sport or ""
    ctx["candidate_channel"] = match.channel or ""
    ctx["candidate_channel_candidates"] = [
        str(value or "").strip() for value in match.channel_candidates if value
    ]
    ctx["landing_screenshot_url"] = match.screenshot_url or ""
    ctx["landing_visual_evidence"] = _format_visual_evidence(match.visual_evidence)
    ctx["landing_server_hints"] = match.server_hints or []
    ctx["landing_route"] = match.route or ""
    ctx["landing_route_source"] = match.route_source or ""
    ctx["landing_redirect_chain"] = match.redirect_chain or []


def _latest_hosting_context_for_embedded(
    extraction_results: list[ExtractionResult],
    *,
    embedded_url: str,
) -> ExtractionResult | None:
    target = str(embedded_url or "").strip()
    if not target:
        return None
    for extraction in reversed(extraction_results):
        if extraction.page_type != PageType.HOSTING:
            continue
        if target in _collect_embedded_urls(extraction):
            return extraction
    return None


def _requires_embedded_followup(extraction: ExtractionResult) -> bool:
    decision = str(extraction.metadata.get("decision", "") or "").strip().lower()
    embedded_candidates = _collect_embedded_urls(extraction)
    if decision in {"needs_embed_agent", "partial_success_needs_embed"}:
        return True
    for server in extraction.servers:
        if str(server.status or "").strip().lower() == "needs_embed_agent":
            return bool(embedded_candidates)
    for server in extraction.metadata.get("servers", []):
        if not isinstance(server, dict):
            continue
        if str(server.get("status") or "").strip().lower() == "needs_embed_agent":
            return bool(embedded_candidates)
    return not extraction.streams and bool(embedded_candidates)


def _embedded_target_allowed(state: PipelineState, target_url: str) -> bool:
    if _latest_hosting_context_for_embedded(
        state.get("extraction_results", []), embedded_url=target_url
    ):
        return True
    classification = state.get("classification")
    return bool(
        classification is not None
        and classification.page_type == PageType.EMBEDDED
        and str(target_url or "").strip() == str(state.get("url") or "").strip()
    )


def _build_landing_handoff(
    state: PipelineState,
    *,
    memory_hint_text: str,
) -> str:
    classification = state.get("classification")
    ctx: HandoffContext = {
        "root_url": state["url"],
        "page_type": classification.page_type.value if classification is not None else "unknown",
        "classification_reasoning": classification.reasoning if classification is not None else "",
        "focus": "return clean hosting candidates, keep iframe-heavy watch pages on the hosting path, and preserve iframe/player evidence only as hints for the hosting agent",
        "memory_hints": memory_hint_text,
    }
    return render_handoff(ctx)


def _build_hosting_handoff(
    state: PipelineState,
    *,
    target_url: str,
    memory_hint_text: str,
    pattern_context: str = "",
) -> str:
    classification = state.get("classification")
    match = _match_for_url(state.get("matches", []), target_url) or _match_containing_handoff_url(
        state.get("matches", []), target_url
    )
    ctx: HandoffContext = {
        "root_url": state["url"],
        "target_url": target_url,
        "target_label": "target hosting candidate",
        "recovery_url": target_url,
        "page_type": classification.page_type.value if classification is not None else "",
        "classification_reasoning": classification.reasoning if classification is not None else "",
        "route_source": "landing/hosting routing contract: hosting-first for site watch pages",
        "navigation_policy": _SAME_CONTENT_NAVIGATION_POLICY,
        "required_evidence": _HOSTING_EVIDENCE_CHECKLIST,
        "focus": "stay on the assigned hosting content, treat an event page with multiple same-event stream routes as a hosting mini-listing, build the same-event server frontier, activate the player for each source, handle blockers/ads/server switches, extract direct m3u8/mpd/mp4 when possible, and return embedded handoff only for explicit embedded/player URLs",
        "memory_hints": memory_hint_text,
    }
    if pattern_context:
        ctx["pattern_context"] = pattern_context
    if match is not None:
        _add_match_handoff_context(ctx, match)
        if match.channel:
            ctx["focus"] += f"; landing hinted channel '{match.channel}' so verify it from the live player and override it if the site is misleading"
    return render_handoff(ctx)


def _build_embedded_handoff(
    state: PipelineState,
    *,
    target_url: str,
    memory_hint_text: str,
) -> str:
    source_hosting = _latest_hosting_context_for_embedded(
        state.get("extraction_results", []), embedded_url=target_url
    )
    match = _match_for_url(state.get("matches", []), target_url) or _match_containing_handoff_url(
        state.get("matches", []), target_url
    )
    ctx: HandoffContext = {
        "root_url": state["url"],
        "target_url": target_url,
        "target_label": "target embedded player",
        "recovery_url": target_url,
        "route_source": "embedded-only routing: this target is already a direct embedded/player URL",
        "navigation_policy": _SAME_CONTENT_NAVIGATION_POLICY,
        "required_evidence": _EMBEDDED_EVIDENCE_CHECKLIST,
        "focus": "work only on the assigned embedded player, handle iframe-local controls and server/source switches, and recover clean stream/evidence artifacts without drifting away",
        "memory_hints": memory_hint_text,
    }
    if match is not None:
        _add_match_handoff_context(ctx, match)
        if match.channel:
            ctx["focus"] += f"; landing hinted channel '{match.channel}' so verify it from the live player and override it if the site is misleading"
    if source_hosting is not None:
        ctx["source_hosting_url"] = source_hosting.url
        ctx["source_hosting_status"] = source_hosting.status.value
        ctx["source_hosting_decision"] = str(
            source_hosting.metadata.get("decision", "") or ""
        ).strip()
        ctx["source_streams_found"] = len(source_hosting.streams)
        ctx["route_source"] = "hosting output: explicit embedded_url/player_iframe handoff"
        if source_hosting.primary_channel:
            ctx["focus"] += f"; hosting already reported '{source_hosting.primary_channel}', so verify or override it from the embedded player if needed"
    return render_handoff(ctx)


async def classify_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    from src.agents.classification import ClassificationAgent

    child = observer.child("classification", AgentType.CLASSIFICATION) if observer else None
    _emit_orchestrator_decision(
        observer,
        "Calling classification agent",
        details={"url": state["url"], "reason": "recheck page type before routing"},
    )
    try:
        result = await ClassificationAgent(settings).run(url=state["url"], observer=child)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Classification agent failed for %s: %s", state["url"], exc)
        result = ClassificationResult(
            url=state["url"],
            page_type=PageType.UNKNOWN,
            confidence=Confidence.LOW,
            reasoning=f"Classification failed: {type(exc).__name__}: {str(exc)[:500]}",
        )
    next_node = route_after_classification({**state, "classification": result})
    _emit_orchestrator_decision(
        observer,
        "Classification route selected",
        details={
            "page_type": result.page_type.value,
            "confidence": result.confidence.value,
            "next_node": next_node,
            "reasoning_preview": _truncate(result.reasoning, max_chars=900),
        },
    )
    return {"classification": result, "error": ""}


async def queue_root_hosting_node(
    state: PipelineState,
    *,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    _emit_orchestrator_decision(
        observer,
        "Root URL queued for hosting agent",
        details={"url": state["url"], "source": "classification"},
    )
    return {"pending_hosting_urls": _dedupe_urls([*state["pending_hosting_urls"], state["url"]])}


async def queue_root_embedded_node(
    state: PipelineState,
    *,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    _emit_orchestrator_decision(
        observer,
        "Root URL queued for embedded agent",
        details={"url": state["url"], "source": "classification"},
    )
    return {"pending_embedded_urls": _dedupe_urls([*state["pending_embedded_urls"], state["url"]])}


async def landing_page_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
    memory: LongTermMemory | None = None,
) -> dict[str, Any]:
    from src.agents.landing_page import LandingPageAgent

    landing_child = observer.child("landing", AgentType.LANDING_PAGE) if observer else None

    landing_memory_hint = _memory_hint(
        memory,
        url=state["url"],
        page_type=AgentType.LANDING_PAGE.value,
    )
    landing_handoff = _build_landing_handoff(state, memory_hint_text=landing_memory_hint)
    _emit_orchestrator_decision(
        observer,
        "Landing handoff prepared",
        details={
            "next_node": "landing_page",
            "handoff_preview": _truncate(landing_handoff, max_chars=1200),
            "memory_hint_found": bool(landing_memory_hint),
        },
    )
    hosting_pages: list[dict[str, Any]] = []
    extraction_results = list(state["extraction_results"])
    landing_outcome: ExtractionResult | None = None
    try:
        landing_outcome = await LandingPageAgent(settings).run(
            url=state["url"],
            observer=landing_child,
            orchestrator_handoff=landing_handoff,
        )
        hosting_pages = landing_outcome.metadata.get("hosting_pages", [])
        if not hosting_pages and isinstance(landing_outcome.metadata, dict):
            landing_match_urls = landing_outcome.metadata.get("landing_match_urls", [])
            if isinstance(landing_match_urls, list):
                hosting_pages = [
                    {"url": str(url or "").strip(), "route_source": "landing_match_urls_fallback"}
                    for url in landing_match_urls
                    if str(url or "").strip()
                ]
    except Exception as exc:
        logger.warning("Landing page agent failed for %s: %s", state["url"], exc)
        error_text = str(exc)
        landing_outcome = ExtractionResult(
            url=state["url"],
            page_type=PageType.LANDING,
            status=ExtractionStatus.TIMEOUT
            if "timed out" in error_text.lower()
            else ExtractionStatus.FAILED,
            agent_type=AgentType.LANDING_PAGE,
            error_message=error_text,
            metadata={"orchestrator_error": type(exc).__name__},
        )
    if landing_outcome is not None:
        extraction_results.append(landing_outcome)

    matches: list[MatchInfo] = []
    for page in hosting_pages:
        if not isinstance(page, dict) or not page.get("url"):
            continue
        try:
            matches.append(MatchInfo(**page))
        except Exception as exc:
            logger.warning("Skipping malformed landing-page match payload: %s (%s)", page, exc)

    pending_embedded_urls = list(state["pending_embedded_urls"])
    pending_hosting_urls: list[str] = []
    landing_direct_streams: list[str] = []
    normalized_matches: list[MatchInfo] = []

    for match in matches:
        resolved_route = _resolve_landing_match_route(match, root_url=state["url"])
        normalized_match = (
            match.model_copy(update={"route": resolved_route})
            if match.route != resolved_route
            else match
        )
        normalized_matches.append(normalized_match)
        _landing_player_hints, direct_streams = _split_landing_match_handoff_targets(
            normalized_match
        )
        landing_direct_streams.extend(direct_streams)
        if _looks_like_provider_stream_url(normalized_match.url):
            landing_direct_streams.append(normalized_match.url)
        else:
            pending_hosting_urls.append(normalized_match.url)

    matches = normalized_matches
    pending_hosting_urls = _dedupe_urls(pending_hosting_urls)
    pending_embedded_urls = _dedupe_urls(pending_embedded_urls)
    landing_direct_streams = _dedupe_urls(landing_direct_streams)
    landing_metadata = landing_outcome.metadata if landing_outcome is not None else {}
    if landing_direct_streams and landing_outcome is not None:
        existing_stream_urls = {stream.url for stream in landing_outcome.streams}
        for stream_url in landing_direct_streams:
            if stream_url not in existing_stream_urls:
                landing_outcome.streams.append(
                    StreamURL(
                        url=stream_url,
                        protocol="",
                        source_layer="landing_player_handoff",
                    )
                )
                existing_stream_urls.add(stream_url)
        existing_direct_streams = (
            [
                str(value or "").strip()
                for value in landing_metadata.get("direct_stream_urls", [])
                if value
            ]
            if isinstance(landing_metadata.get("direct_stream_urls"), list)
            else []
        )
        landing_metadata["direct_stream_urls"] = _dedupe_urls(
            [*existing_direct_streams, *landing_direct_streams]
        )

    _emit_orchestrator_decision(
        observer,
        "Landing results routed",
        status="warning"
        if not pending_hosting_urls and not pending_embedded_urls and not landing_direct_streams
        else "info",
        details={
            "hosting_pages_found": len(hosting_pages),
            "matches": len(matches),
            "pending_hosting_urls": pending_hosting_urls,
            "pending_embedded_urls": pending_embedded_urls,
            "landing_direct_streams": landing_direct_streams,
            "pattern_expansion": landing_metadata.get("pattern_expansion", {}),
            "note": (
                "No hosting candidates were found; workflow will finish without treating this as a runtime failure."
                if not pending_hosting_urls and not pending_embedded_urls and not landing_direct_streams
                else ""
            ),
        },
    )

    return {
        "matches": matches,
        "pending_hosting_urls": pending_hosting_urls,
        "pending_embedded_urls": pending_embedded_urls,
        "extraction_results": extraction_results,
    }


async def hosting_page_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
    memory: LongTermMemory | None = None,
) -> dict[str, Any]:
    from src.agents.hosting_page import HostingPageAgent

    if not state["pending_hosting_urls"]:
        return {}

    target_urls = _dedupe_urls(state["pending_hosting_urls"])
    total_targets = len(target_urls)
    _emit_orchestrator_decision(
        observer,
        "Hosting agent targets queued",
        details={"target_count": total_targets, "target_urls": target_urls[:20]},
    )

    # Derive pattern context from landing matches site_patterns
    matches = state.get("matches", [])
    site_url_pattern = ""
    for m in matches:
        if hasattr(m, "patterns") and isinstance(m.patterns, dict):
            site_url_pattern = str(m.patterns.get("url_pattern") or "").strip()
            if site_url_pattern:
                break

    parallel_limit = max(1, int(settings.max_parallel_hosting_pages or 1))
    sem = asyncio.Semaphore(parallel_limit)

    async def _guarded(coro: Any) -> Any:
        async with sem:
            return await coro

    tasks = []
    for idx, target_url in enumerate(target_urls):
        child = observer.child("hosting", AgentType.HOSTING_PAGE) if observer else None
        hosting_memory_hint = _memory_hint(
            memory,
            url=target_url,
            page_type=AgentType.HOSTING_PAGE.value,
        )
        pattern_context = (
            f"{idx + 1} of {total_targets} from pattern {site_url_pattern}"
            if site_url_pattern
            else f"{idx + 1} of {total_targets}"
        )
        handoff = _build_hosting_handoff(
            state,
            target_url=target_url,
            memory_hint_text=hosting_memory_hint,
            pattern_context=pattern_context,
        )
        _emit_orchestrator_decision(
            observer,
            "Hosting handoff prepared",
            details={
                "target_url": target_url,
                "target_index": idx + 1,
                "target_count": total_targets,
                "handoff_preview": _truncate(handoff, max_chars=900),
                "memory_hint_found": bool(hosting_memory_hint),
            },
        )
        tasks.append(
            _guarded(
                HostingPageAgent(settings).run(
                    url=target_url,
                    observer=child,
                    orchestrator_handoff=handoff,
                )
            )
        )

    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    extraction_results = list(state["extraction_results"])
    pending_embedded_urls = list(state["pending_embedded_urls"])

    for target_url, outcome in zip(target_urls, outcomes, strict=False):
        if isinstance(outcome, BaseException):
            logger.warning("Hosting page agent failed for %s: %s", target_url, outcome)
            error_text = str(outcome)
            extraction = ExtractionResult(
                url=target_url,
                page_type=PageType.HOSTING,
                status=ExtractionStatus.TIMEOUT
                if "timed out" in error_text.lower()
                else ExtractionStatus.FAILED,
                agent_type=AgentType.HOSTING_PAGE,
                error_message=error_text,
                metadata={"orchestrator_error": type(outcome).__name__},
            )
        else:
            extraction = cast(ExtractionResult, outcome)

        extraction_results.append(extraction)

        embedded_candidates = _collect_embedded_urls(extraction)
        needs_embed_followup = _requires_embedded_followup(extraction)
        if needs_embed_followup and embedded_candidates:
            pending_embedded_urls = _dedupe_urls([*pending_embedded_urls, *embedded_candidates])
        elif needs_embed_followup:
            logger.warning(
                "Hosting result for %s requested embedded follow-up but returned no embedded/player URL",
                target_url,
            )
            if observer is not None:
                observer.emit(
                    "embedded_handoff_missing",
                    "Hosting result requested embedded follow-up without an explicit embedded target",
                    status="warning",
                    details={
                        "hosting_url": target_url,
                        "decision": str(extraction.metadata.get("decision", "") or "").strip(),
                    },
                )

    return {
        "pending_hosting_urls": [],
        "pending_embedded_urls": pending_embedded_urls,
        "extraction_results": extraction_results,
    }


async def embedded_page_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
    memory: LongTermMemory | None = None,
) -> dict[str, Any]:
    from src.agents.embedded_page import EmbeddedPageAgent

    if not state["pending_embedded_urls"]:
        return {}

    original_target_urls = _dedupe_urls(state["pending_embedded_urls"])
    target_urls = [
        target_url
        for target_url in original_target_urls
        if _embedded_target_allowed(state, target_url)
    ]
    skipped_targets = [target_url for target_url in original_target_urls if target_url not in target_urls]
    if skipped_targets:
        _emit_orchestrator_decision(
            observer,
            "Embedded targets skipped without hosting iframe source",
            status="warning",
            details={"target_urls": skipped_targets[:20]},
        )
    if not target_urls:
        return {"pending_embedded_urls": []}
    total_targets = len(target_urls)
    _emit_orchestrator_decision(
        observer,
        "Embedded agent targets queued",
        details={"target_count": total_targets, "target_urls": target_urls[:20]},
    )
    tasks = []
    parallel_limit = max(1, int(settings.max_parallel_hosting_pages or 1))
    sem = asyncio.Semaphore(parallel_limit)

    async def _guarded(coro: Any) -> Any:
        async with sem:
            return await coro

    for idx, target_url in enumerate(target_urls):
        child = observer.child("embedded", AgentType.EMBEDDED_PAGE) if observer else None
        embedded_memory_hint = _memory_hint(
            memory,
            url=target_url,
            page_type=AgentType.EMBEDDED_PAGE.value,
        )
        handoff = _build_embedded_handoff(
            state,
            target_url=target_url,
            memory_hint_text=embedded_memory_hint,
        )
        _emit_orchestrator_decision(
            observer,
            "Embedded handoff prepared",
            details={
                "target_url": target_url,
                "target_index": idx + 1,
                "target_count": total_targets,
                "handoff_preview": _truncate(handoff, max_chars=900),
                "memory_hint_found": bool(embedded_memory_hint),
            },
        )
        tasks.append(
            _guarded(
                EmbeddedPageAgent(settings).run(
                    url=target_url,
                    observer=child,
                    orchestrator_handoff=handoff,
                )
            )
        )

    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    extraction_results = list(state["extraction_results"])
    for target_url, outcome in zip(target_urls, outcomes, strict=False):
        if isinstance(outcome, BaseException):
            logger.warning("Embedded page agent failed for %s: %s", target_url, outcome)
            error_text = str(outcome)
            extraction = ExtractionResult(
                url=target_url,
                page_type=PageType.EMBEDDED,
                status=ExtractionStatus.TIMEOUT
                if "timed out" in error_text.lower()
                else ExtractionStatus.FAILED,
                agent_type=AgentType.EMBEDDED_PAGE,
                error_message=error_text,
                metadata={"orchestrator_error": type(outcome).__name__},
            )
        else:
            extraction = cast(ExtractionResult, outcome)
        extraction_results.append(extraction)

    return {
        "pending_embedded_urls": [],
        "extraction_results": extraction_results,
    }


async def analyze_providers_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    stream_urls = [stream.url for stream in _collect_all_streams(state["extraction_results"])]
    evidence_overview = _extraction_evidence_overview(state["extraction_results"])
    if not stream_urls:
        _emit_orchestrator_decision(
            observer,
            "Provider analysis skipped",
            status="warning",
            details={
                "reason": "no stream URLs were found",
                **evidence_overview,
            },
        )
        return {"provider_analysis": []}
    _emit_orchestrator_decision(
        observer,
        "Provider analysis started",
        details={
            **evidence_overview,
            "stream_count": len(stream_urls),
        },
    )
    payload = await IPInfoTool(ipinfo_token=settings.ipinfo_token)._arun(stream_urls=stream_urls)
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        parsed = []
    providers = [ProviderInfo(**item) for item in parsed if isinstance(item, dict)]
    _emit_orchestrator_decision(
        observer,
        "Provider analysis completed",
        status="success" if providers else "warning",
        details={
            **evidence_overview,
            "provider_count": len(providers),
        },
    )
    return {"provider_analysis": providers}


async def generate_takedown_emails_node(
    state: PipelineState,
    *,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    evidence_overview = _extraction_evidence_overview(state["extraction_results"])
    if not _collect_all_streams(state["extraction_results"]):
        _emit_orchestrator_decision(
            observer,
            "Takedown draft generation skipped",
            status="warning",
            details={
                "reason": "no stream URLs were found",
                **evidence_overview,
            },
        )
        return {"takedown_emails": []}
    _emit_orchestrator_decision(
        observer,
        "Takedown draft generation started",
        details={
            **evidence_overview,
            "provider_analysis_count": len(state["provider_analysis"]),
        },
    )
    payload = await EmailTool()._arun(
        infringing_url=state["url"],
        provider_analysis=[
            provider.model_dump(mode="json") for provider in state["provider_analysis"]
        ],
        extraction_results=[
            result.model_dump(mode="json") for result in state["extraction_results"]
        ],
    )
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        parsed = []
    emails = [TakedownEmail(**item) for item in parsed if isinstance(item, dict)]
    _emit_orchestrator_decision(
        observer,
        "Takedown draft generation completed",
        status="success" if emails else "warning",
        details={
            **evidence_overview,
            "email_count": len(emails),
        },
    )
    return {"takedown_emails": emails}


_EMBEDDED_CLASSIFICATION_SITE_SHELL_SIGNALS = (
    "background video",
    "autoplay background",
    "decorative video",
    "hero video",
    "site chrome",
    "navigation bar",
    "navbar",
    "menu",
    "search box",
    "cookie banner",
    "full website",
    "home page",
    "landing page",
    "article page",
)

_EMBEDDED_CLASSIFICATION_PLAYER_SIGNALS = (
    "standalone player",
    "direct player",
    "iframe player",
    "embedded player",
    "third-party player",
    "minimal chrome",
    "player controls",
    "video controls",
    "play button",
    "fullscreen",
    "m3u8",
    "hls",
    "dash stream",
)

_EMBEDDED_CLASSIFICATION_NEGATED_PLAYER_SIGNALS = (
    "not an embedded player",
    "not embedded player",
    "not a standalone player",
    "no player controls",
    "no video controls",
    "decorative rather than a player",
)


def _embedded_classification_needs_hosting_fallback(
    classification: ClassificationResult,
) -> bool:
    """Guard the route when a decorative/site-shell video was mislabeled embedded."""
    text = " ".join(
        [
            str(classification.reasoning or ""),
            str(classification.url or ""),
        ]
    ).lower()
    if not text:
        return False
    if any(signal in text for signal in _EMBEDDED_CLASSIFICATION_NEGATED_PLAYER_SIGNALS):
        return True
    has_site_shell_signal = any(
        signal in text for signal in _EMBEDDED_CLASSIFICATION_SITE_SHELL_SIGNALS
    )
    if not has_site_shell_signal:
        return False
    has_player_signal = any(
        signal in text for signal in _EMBEDDED_CLASSIFICATION_PLAYER_SIGNALS
    )
    return not has_player_signal


def route_after_classification(state: PipelineState) -> str:
    classification = state["classification"]
    if classification is None:
        return "analyze_providers"
    if classification.page_type == PageType.LANDING:
        return "landing_page"
    if classification.page_type == PageType.HOSTING:
        return "queue_root_hosting"
    if classification.page_type == PageType.EMBEDDED:
        if _embedded_classification_needs_hosting_fallback(classification):
            return "queue_root_hosting"
        return "queue_root_embedded"
    return "analyze_providers"


def route_after_landing(state: PipelineState) -> str:
    if state["pending_hosting_urls"]:
        return "hosting_page"
    if state["pending_embedded_urls"]:
        return "embedded_page"
    return "analyze_providers"


def route_after_hosting(state: PipelineState) -> str:
    if state["pending_hosting_urls"]:
        return "hosting_page"
    if state["pending_embedded_urls"]:
        return "embedded_page"
    return "analyze_providers"


def route_after_embedded(state: PipelineState) -> str:
    return "analyze_providers"


def build_graph(settings: Settings, observer: RunObserver | None = None):
    """Build the deterministic LangGraph orchestration graph."""
    memory = LongTermMemory(settings.memory_db_path) if settings.memory_enabled else None
    graph = StateGraph(PipelineState)
    graph.add_node("classify", partial(classify_node, settings=settings, observer=observer))
    graph.add_node("queue_root_hosting", partial(queue_root_hosting_node, observer=observer))
    graph.add_node("queue_root_embedded", partial(queue_root_embedded_node, observer=observer))
    graph.add_node(
        "landing_page",
        partial(landing_page_node, settings=settings, observer=observer, memory=memory),
    )
    graph.add_node(
        "hosting_page",
        partial(hosting_page_node, settings=settings, observer=observer, memory=memory),
    )
    graph.add_node(
        "embedded_page",
        partial(embedded_page_node, settings=settings, observer=observer, memory=memory),
    )
    graph.add_node(
        "analyze_providers", partial(analyze_providers_node, settings=settings, observer=observer)
    )
    graph.add_node(
        "generate_takedown_emails", partial(generate_takedown_emails_node, observer=observer)
    )

    graph.add_edge(START, "classify")
    graph.add_conditional_edges(
        "classify",
        route_after_classification,
        {
            "landing_page": "landing_page",
            "queue_root_hosting": "queue_root_hosting",
            "queue_root_embedded": "queue_root_embedded",
            "analyze_providers": "analyze_providers",
        },
    )
    graph.add_conditional_edges(
        "landing_page",
        route_after_landing,
        {
            "hosting_page": "hosting_page",
            "embedded_page": "embedded_page",
            "analyze_providers": "analyze_providers",
        },
    )
    graph.add_edge("queue_root_hosting", "hosting_page")
    graph.add_conditional_edges(
        "hosting_page",
        route_after_hosting,
        {
            "hosting_page": "hosting_page",
            "embedded_page": "embedded_page",
            "analyze_providers": "analyze_providers",
        },
    )
    graph.add_edge("queue_root_embedded", "embedded_page")
    graph.add_conditional_edges(
        "embedded_page",
        route_after_embedded,
        {"embedded_page": "embedded_page", "analyze_providers": "analyze_providers"},
    )
    graph.add_edge("analyze_providers", "generate_takedown_emails")
    graph.add_edge("generate_takedown_emails", END)
    return graph.compile()


class OrchestratorAgent:
    """LangGraph orchestrator wrapper."""

    def __init__(self, settings: Settings, observer: RunObserver | None = None) -> None:
        self.settings = settings
        self.observer = observer
        self.graph = build_graph(settings, observer=observer)

    async def run(self, url: str) -> PipelineResult:
        run_id = self.observer.run_id if self.observer is not None else str(uuid.uuid4())
        logger.info("Pipeline started: run_id=%s url=%s", run_id, url)
        if self.observer is not None:
            self.observer.set_url(url)
            self.observer.mark_agent(AgentType.ORCHESTRATOR)
            self.observer.emit("pipeline_started", f"Pipeline started for {url}")
            if self.settings.memory_enabled:
                try:
                    memory = LongTermMemory(self.settings.memory_db_path)
                    memory_hints = {
                        agent_type.value: _memory_hint(
                            memory, url=url, page_type=agent_type.value, limit=2
                        )
                        for agent_type in (
                            AgentType.CLASSIFICATION,
                            AgentType.LANDING_PAGE,
                            AgentType.HOSTING_PAGE,
                            AgentType.EMBEDDED_PAGE,
                        )
                    }
                    found_hints = {
                        page_type: _truncate(hint, max_chars=700)
                        for page_type, hint in memory_hints.items()
                        if hint
                    }
                    _emit_orchestrator_decision(
                        self.observer,
                        "Orchestrator memory checked",
                        details={
                            "url": url,
                            "page_types_checked": list(memory_hints.keys()),
                            "hints_found": len(found_hints),
                            "hint_previews": found_hints,
                            "routing_policy": "memory is soft guidance; classification is still called to re-check the current page",
                        },
                    )
                except Exception as exc:
                    _emit_orchestrator_decision(
                        self.observer,
                        "Orchestrator memory check skipped",
                        status="warning",
                        details={"error_type": type(exc).__name__, "error_preview": str(exc)[:500]},
                    )

        initial_state: PipelineState = {
            "url": url,
            "run_id": run_id,
            "classification": None,
            "matches": [],
            "extraction_results": [],
            "pending_hosting_urls": [],
            "pending_embedded_urls": [],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        }

        try:
            with using_observability_context(
                session_id=self.observer.run_id if self.observer is not None else "",
                metadata={"agent_type": AgentType.ORCHESTRATOR.value, "url": url},
                tags=["orchestrator", "pipeline", "langgraph"],
            ):
                with observability_span(
                    "orchestrator_agent.run",
                    kind="agent",
                    input_value={"url": url},
                    attributes={
                        "owc.agent_type": AgentType.ORCHESTRATOR.value,
                        "owc.runtime": "langgraph",
                    },
                ) as span:
                    final_state = cast(PipelineState, await self.graph.ainvoke(initial_state))
                    result = _build_pipeline_result(
                        final_state,
                        self.observer.trace().metrics if self.observer else None,
                    )
                    set_span_output(
                        span,
                        {
                            "final_status": result.final_status.value,
                            "streams_found": len(result.all_streams),
                            "emails_generated": len(result.takedown_emails),
                            "provider_analyses": len(result.provider_analysis),
                        },
                    )

            if self.observer is not None:
                non_failure_statuses = {ExtractionStatus.SUCCESS, ExtractionStatus.PARTIAL}
                failure_mode = (
                    ""
                    if result.final_status == ExtractionStatus.SUCCESS
                    else result.final_status.value
                )
                self.observer.emit(
                    "pipeline_finished",
                    f"Pipeline finished with status {result.final_status}",
                    status="success"
                    if result.final_status == ExtractionStatus.SUCCESS
                    else "warning",
                    details={
                        "streams_found": len(result.all_streams),
                        "emails_generated": len(result.takedown_emails),
                        "final_status": result.final_status.value,
                    },
                )
                self.observer.finish(
                    success=result.final_status in non_failure_statuses,
                    failure_mode=failure_mode,
                )
                result.metrics = self.observer.trace().metrics

            logger.info(
                "Pipeline finished: run_id=%s status=%s streams=%d emails=%d",
                run_id,
                result.final_status,
                len(result.all_streams),
                len(result.takedown_emails),
            )
            return result
        except Exception as exc:
            if self.observer is not None:
                self.observer.emit("pipeline_failed", str(exc), status="error")
                self.observer.finish(success=False, failure_mode=type(exc).__name__)
            raise


async def run_pipeline(
    url: str,
    settings: Settings,
    observer: RunObserver | None = None,
) -> PipelineResult:
    if observer is None:
        observer = run_registry.create(
            run_id=str(uuid.uuid4()),
            root_actor="orchestrator",
            observability=get_observability_status(settings),
        )
    return await OrchestratorAgent(settings, observer=observer).run(url)


def _collect_all_streams(extraction_results: list[ExtractionResult]) -> list[StreamURL]:
    seen: set[str] = set()
    streams: list[StreamURL] = []
    for extraction in extraction_results:
        for stream in extraction.streams:
            if _looks_like_provider_stream_url(stream.url) and stream.url not in seen:
                seen.add(stream.url)
                streams.append(stream)
        for server in extraction.servers:
            for url in server.stream_urls + server.m3u8_urls + server.mpd_urls + server.mp4_urls:
                if _looks_like_provider_stream_url(url) and url not in seen:
                    seen.add(url)
                    streams.append(StreamURL(url=url, source_layer=server.label))
        # Backward-compatible fallback for legacy payloads that only kept servers in metadata.
        for server in extraction.metadata.get("servers", []):
            for url in (
                server.get("stream_urls", [])
                + server.get("m3u8_urls", [])
                + server.get("mpd_urls", [])
                + server.get("mp4_urls", [])
            ):
                if _looks_like_provider_stream_url(url) and url not in seen:
                    seen.add(url)
                    streams.append(StreamURL(url=url, source_layer=server.get("label", "")))
    return streams


def _looks_like_provider_stream_url(url: str) -> bool:
    raw = str(url or "").strip()
    candidate = raw.lower()
    if not candidate.startswith(("http://", "https://")):
        return False
    parsed = urlparse(candidate)
    path = parsed.path or ""
    query = parsed.query or ""
    if re.search(r"\.(m3u8|mpd|mp4|m4s|ts)(?:$|[?#])", candidate) or path.endswith(
        (".m3u8", ".mpd", ".mp4", ".m4s", ".ts")
    ):
        return True

    stream_context = bool(
        re.search(
            r"(^|[/_.-])(hls|dash|manifest|playlist|master|chunklist|m3u8|mpd|mono)([/_.-]|$)",
            path,
        )
        or re.search(r"(^|[?&])(hls|dash|m3u8|mpd|playlist|manifest|stream)=", query)
        or re.search(r"(^|[?&])(format|type|protocol)=(hls|dash|m3u8|mpd)", query)
    )
    if not stream_context:
        return False

    # Some piracy players expose tokenized HLS manifests or segment playlists
    # behind misleading extensions such as mono.css. Do not accept ordinary
    # assets unless the path/query also carries strong stream context above.
    stream_container = bool(
        re.search(r"/(?:hls|dash|m3u8|mpd|manifest|playlist|tracks[^/]*)/", path)
        or re.search(r"(^|[?&])(format|type|protocol)=(hls|dash|m3u8|mpd)", query)
    )
    playlist_name = bool(
        re.search(r"(?:^|/)(?:master|index|chunklist|playlist|manifest)(?:[.-]|$)", path)
    )
    disguised_segment_name = bool(re.search(r"(?:^|/)mono(?:[.-]|$)", path))
    return bool(
        playlist_name
        or stream_container
        or (disguised_segment_name and ("token=" in query or "expires=" in query))
    )


_PAGE_INACCESSIBLE_RE = re.compile(
    r"(inaccessible|unreachable|could not be accessed|failed to load|navigation error|"
    r"browser-level|chrome-error|about:blank|err_|dns|ssl handshake|connection refused|"
    r"connection reset|site unavailable|timed out)",
    re.IGNORECASE,
)


def _flatten_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, dict):
        return " ".join(_flatten_text(item) for item in value.values())
    if isinstance(value, list):
        return " ".join(_flatten_text(item) for item in value)
    return str(value)


def _extraction_failure_text(result: ExtractionResult) -> str:
    values: list[Any] = [
        result.error_message,
        result.metadata.get("session_summary"),
        result.metadata.get("early_stop_reason"),
        result.metadata.get("navigation_attempt_summary"),
        result.metadata.get("orchestrator_error"),
        result.metadata.get("decision"),
        result.metadata.get("reasoning"),
    ]
    for server in result.servers:
        values.extend(
            [
                server.down_reason,
                server.player_state,
                server.visual_confirmation,
                server.network_diagnostics,
                server.iframe_diagnostics,
            ]
        )
    values.append(result.metadata.get("servers", []))
    return _flatten_text(values)


def _result_page_inaccessible(result: ExtractionResult) -> bool:
    if result.status in {ExtractionStatus.SITE_DEAD, ExtractionStatus.TIMEOUT}:
        return True
    return bool(_PAGE_INACCESSIBLE_RE.search(_extraction_failure_text(result)))


def _result_has_hosting_pages(result: ExtractionResult) -> bool:
    pages = result.metadata.get("hosting_pages", []) if isinstance(result.metadata, dict) else []
    return isinstance(pages, list) and bool(pages)


def _result_no_hosting_pages(result: ExtractionResult) -> bool:
    return (
        result.page_type == PageType.LANDING
        and not _result_has_hosting_pages(result)
        and not _result_page_inaccessible(result)
    )


def _result_no_streams(result: ExtractionResult) -> bool:
    if result.page_type not in {PageType.HOSTING, PageType.EMBEDDED}:
        return False
    if result.streams or any(
        server.stream_urls or server.m3u8_urls or server.mpd_urls or server.mp4_urls
        for server in result.servers
    ):
        return False
    if _result_page_inaccessible(result):
        return False
    decision = str(result.metadata.get("decision", "") or "").strip().lower()
    return decision in {"", "no_stream_found", "safe_exit"} or "no stream" in _extraction_failure_text(result).lower()


def _collect_all_screenshots(extraction_results: list[ExtractionResult]) -> list[str]:
    screenshots: list[str] = []
    for extraction in extraction_results:
        screenshots.extend(extraction.screenshots)
        for server in extraction.servers:
            if server.screenshot_url:
                screenshots.append(server.screenshot_url)
        for server in extraction.metadata.get("servers", []):
            screenshot_url = server.get("screenshot_url")
            if screenshot_url:
                screenshots.append(screenshot_url)
    return _dedupe_urls(screenshots)


def _build_pipeline_result(state: PipelineState, metrics: Any | None = None) -> PipelineResult:
    extraction_results = state["extraction_results"]
    all_streams = _collect_all_streams(extraction_results)
    all_screenshots = _collect_all_screenshots(extraction_results)
    pending_followups = bool(state["pending_hosting_urls"] or state["pending_embedded_urls"])
    has_nonfailed_evidence = any(
        result.status in {ExtractionStatus.SUCCESS, ExtractionStatus.PARTIAL}
        or bool(result.streams)
        or bool(result.screenshots)
        or bool(result.embedded_urls)
        or bool(_collect_embedded_urls(result))
        for result in extraction_results
    )
    has_timeout = any(result.status == ExtractionStatus.TIMEOUT for result in extraction_results)
    landing_discovery_exhausted = (
        state.get("classification") is not None
        and state["classification"].page_type == PageType.LANDING
        and not extraction_results
        and not pending_followups
    )

    if all_streams:
        final_status = ExtractionStatus.SUCCESS
    elif has_timeout:
        final_status = ExtractionStatus.TIMEOUT
    elif any(_result_page_inaccessible(result) for result in extraction_results):
        final_status = ExtractionStatus.PAGE_INACCESSIBLE
    elif any(_result_no_hosting_pages(result) for result in extraction_results) or landing_discovery_exhausted:
        final_status = ExtractionStatus.NO_HOSTING_PAGES
    elif extraction_results and all(_result_no_streams(result) for result in extraction_results):
        final_status = ExtractionStatus.NO_STREAMS
    elif any(_result_no_streams(result) for result in extraction_results) and not pending_followups:
        final_status = ExtractionStatus.NO_STREAMS
    elif pending_followups or has_nonfailed_evidence:
        final_status = ExtractionStatus.PARTIAL
    else:
        final_status = ExtractionStatus.FAILED

    return PipelineResult(
        run_id=state["run_id"],
        url=state["url"],
        classification=state["classification"],
        matches=state["matches"],
        extraction_results=state["extraction_results"],
        final_status=final_status,
        all_streams=all_streams,
        all_screenshots=all_screenshots,
        provider_analysis=state["provider_analysis"],
        takedown_emails=state["takedown_emails"],
        metrics=metrics,
    )
