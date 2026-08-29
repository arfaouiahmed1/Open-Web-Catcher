"""LangGraph orchestrator for the full extraction pipeline."""

from __future__ import annotations

import asyncio
import json
import re
import uuid
from collections.abc import Callable
from functools import partial
from typing import Any, TypedDict, cast
from urllib.parse import urlparse

from langgraph.graph import END, START, StateGraph

from src.agents.errors import (
    RunCancelledError,
    WorkflowBudgetExceededError,
    WorkflowTimeoutError,
)
from src.agents.pools import (
    EMBEDDED_ROLE,
    HOSTING_ROLE,
    RunPools,
    register_run_pools,
)
from src.memory.long_term import LongTermMemory
from src.models.common import PipelineModel
from src.models.enums import (
    AgentType,
    Confidence,
    ExtractionStatus,
    FailureKind,
    PageType,
)
from src.models.judge import ValidationReport
from src.models.schemas import (
    ClassificationResult,
    ExtractionResult,
    MatchInfo,
    PipelineResult,
    ProviderInfo,
    StreamURL,
    TakedownEmail,
)
from src.orchestrator.emailing import TakedownEmailRenderInput, render_takedown_emails
from src.orchestrator.run_plan import emit_run_plan, transition_run_step
from src.storage.database import get_session

#: Canonical RunPlan artifact (plan T27). Step ids mirror the LangGraph node
#: names so the SSE timeline reflects the actual execution graph; each node
#: emits in_progress on entry and a terminal status on exit via the helpers in
#: src/orchestrator/run_plan.py.
_RUN_PLAN_STEPS = [
    {"id": "classify", "title": "Classify page", "criteria": "page_type assigned with confidence"},
    {"id": "landing_page", "title": "Extract landing streams", "criteria": ">= 0 candidate streams"},
    {"id": "analyze_providers", "title": "Extract hosting/embedded streams", "criteria": "provider analysis rows populated"},
    {"id": "validate_evidence", "title": "Validator evidence pass", "criteria": "validator verdict recorded OR bypassed on empty queue"},
    {"id": "generate_takedown_emails", "title": "Render takedown emails", "criteria": ">= 0 emails generated"},
]
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
    "record popup_window_diagnostics for opened, blocked, adopted, or closed popup/window targets, including opened_targets, blocked_popup_attempts, selected_target, target_decision, extracted_player_urls, and blocked_by_client evidence",
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
    "record popup_window_diagnostics for opened, blocked, adopted, or closed popup/window targets, including opened_targets, blocked_popup_attempts, selected_target, target_decision, extracted_player_urls, and blocked_by_client evidence",
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
    # Stage-parse safety (plan T15): malformed items skipped during stage
    # payload construction, each as {"stage", "reason", "item_preview"}.
    invalid_items: list[dict[str, Any]]
    # Evidence-validation gate (plan T24 / VAL-C2): typed report from the
    # validate_evidence node plus the per-stage replan budget spent so far.
    validation_report: ValidationReport | None
    validator_replan_attempts: int
    error: str
    gate_no_target: bool


def _dedupe_urls(urls: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for url in urls:
        if url and url not in seen:
            seen.add(url)
            result.append(url)
    return result


def classify_failure_kind(exc: BaseException) -> FailureKind:
    """Map a pipeline exception onto the typed failure taxonomy (T30/AGT-H3).

    Typed exceptions win; legacy string matching remains only as a fallback
    for third-party exceptions that carry timeout text.
    """
    if isinstance(exc, RunCancelledError):
        return FailureKind.CANCELLED
    if isinstance(exc, WorkflowBudgetExceededError):
        return FailureKind.BUDGET_EXCEEDED
    if isinstance(exc, WorkflowTimeoutError):
        return FailureKind.WORKFLOW_TIMEOUT
    if isinstance(exc, (TimeoutError, asyncio.TimeoutError)):
        return FailureKind.TIMEOUT
    text = str(exc or "").lower()
    if "timed out" in text or "timeout" in text:
        return FailureKind.TIMEOUT
    if _PAGE_INACCESSIBLE_RE.search(str(exc or "")):
        return FailureKind.SITE_INACCESSIBLE
    return FailureKind.AGENT_ERROR


def _failed_extraction(
    target_url: str,
    page_type: PageType,
    agent_type: AgentType,
    exc: BaseException,
) -> ExtractionResult:
    error_text = str(exc)
    kind = classify_failure_kind(exc)
    return ExtractionResult(
        url=target_url,
        page_type=page_type,
        status=ExtractionStatus.TIMEOUT
        if kind in {FailureKind.TIMEOUT, FailureKind.WORKFLOW_TIMEOUT}
        else ExtractionStatus.FAILED,
        agent_type=agent_type,
        error_message=error_text,
        metadata={
            "orchestrator_error": type(exc).__name__,
            "failure_kind": kind.value,
        },
    )


class _WorkflowGovernor:
    """Between-stage token/cost budget checks for a pipeline run (T30/AGT-M7/M8).

    Reads live totals from the RunObserver's RunMetrics, which the base agent
    updates after every LLM call, so no extra instrumentation is needed.
    Budgets of ``<= 0`` disable the corresponding check.
    """

    def __init__(
        self,
        observer: RunObserver | None,
        *,
        max_cost_usd: float = 0.0,
        max_tokens: int = 0,
    ) -> None:
        self._observer = observer
        self._max_cost_usd = max(0.0, float(max_cost_usd or 0.0))
        self._max_tokens = max(0, int(max_tokens or 0))
        self.exceeded: FailureKind | None = None

    @property
    def enabled(self) -> bool:
        return bool(self._observer is not None) and (self._max_cost_usd > 0 or self._max_tokens > 0)

    def _observer_metrics(self) -> Any | None:
        observer = self._observer
        if observer is None:
            return None
        # Some observer implementations expose ``metrics`` directly; this
        # repo's RunObserver serves it from the underlying run state via
        # ``trace()``.
        metrics = getattr(observer, "metrics", None)
        if metrics is not None:
            return metrics
        try:
            return observer.trace().metrics
        except Exception:  # noqa: BLE001 — budget checks must never crash the run
            return None

    def check(self, stage: str) -> None:
        if not self.enabled or self.exceeded is not None:
            return
        metrics = self._observer_metrics()
        if metrics is None:
            return
        total_tokens = int(
            getattr(metrics, "total_tokens_in", 0) or 0
        ) + int(getattr(metrics, "total_tokens_out", 0) or 0)
        total_cost = float(getattr(metrics, "estimated_total_cost_usd", 0.0) or 0.0)

        over_tokens = self._max_tokens > 0 and total_tokens > self._max_tokens
        over_cost = self._max_cost_usd > 0 and total_cost > self._max_cost_usd
        if not (over_tokens or over_cost):
            return
        self.exceeded = FailureKind.BUDGET_EXCEEDED
        _emit_orchestrator_decision(
            self._observer,
            f"Workflow budget exhausted before {stage}",
            status="warning",
            details={
                "stage": stage,
                "budget_max_cost_usd": self._max_cost_usd,
                "budget_max_tokens": self._max_tokens,
                "observed_total_cost_usd": round(total_cost, 6),
                "observed_total_tokens": total_tokens,
                "over_cost": over_cost,
                "over_tokens": over_tokens,
            },
        )
        raise WorkflowBudgetExceededError(
            f"Workflow budget exceeded before stage '{stage}': "
            f"tokens={total_tokens}/{self._max_tokens or 'inf'} "
            f"cost_usd={total_cost:.4f}/{self._max_cost_usd or 'inf'}"
        )


def make_workflow_governor(
    settings: Settings,
    observer: RunObserver | None = None,
) -> Callable[[str], None]:
    """Return a callable enforcing the configured per-run budget (T30).

    Usage inside a pipeline node: ``check_budget("hosting_page")`` before the
    stage body. With no budget configured this is a zero-cost no-op.
    """
    governor = _WorkflowGovernor(
        observer,
        max_cost_usd=getattr(settings, "workflow_max_cost_usd", 0.0),
        max_tokens=getattr(settings, "workflow_max_tokens", 0),
    )
    return governor.check


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


# Embedded trigger vocabulary (plan T28 / streaming role contracts spike §D2.3).
# The hosting agent emits exactly these ``metadata.decision`` values when it
# wants the embedded pool woken; every other decision (clean success included)
# enqueues nothing. This REPLACES the old fan-out that also matched the legacy
# ``needs_embed_agent`` / ``partial_success_needs_embed`` decision strings and
# server-level statuses — those are retained as server STATUS labels only and
# no longer wake the embedded pool.
_EMBEDDED_TRIGGER_DECISIONS = frozenset(
    {"activation_failed", "no_networking", "judge_validation_request"}
)


def _requires_embedded_followup(extraction: ExtractionResult) -> bool:
    """True only on an explicit embedded trigger (spike §D2.3).

    Embedded work is invoked ONLY on one of the three trigger decisions
    (``activation_failed`` / ``no_networking`` / ``judge_validation_request``).
    Server-level statuses and legacy decision strings no longer fan out.
    """
    decision = str(extraction.metadata.get("decision", "") or "").strip().lower()
    return decision in _EMBEDDED_TRIGGER_DECISIONS


def _page_type_for_role(role: str) -> PageType:
    return PageType.EMBEDDED if role == EMBEDDED_ROLE else PageType.HOSTING


def _agent_type_for_role(role: str) -> AgentType:
    return AgentType.EMBEDDED_PAGE if role == EMBEDDED_ROLE else AgentType.HOSTING_PAGE


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


_CONFIDENCE_SCORE_BY_LEVEL = {
    Confidence.LOW: 33,
    Confidence.MEDIUM: 66,
    Confidence.HIGH: 100,
}

_CONFIDENCE_SOURCE_PARSED = "parsed"
_CONFIDENCE_SOURCE_FALLBACK = "fallback"
_CONFIDENCE_SOURCE_HEURISTIC_DEFAULT = "heuristic_default"

_CLASSIFICATION_TIEBREAK_INSTRUCTION = (
    "RECLASSIFICATION RE-CHECK (judge tiebreak): your previous verdict was low-confidence "
    "or could not be parsed. Re-examine the live page evidence you already gathered and "
    "decide strictly between landing_page, host_page, embed_video_page, or other. Focus on "
    "concrete player/list signals versus generic site navigation, then answer using the exact "
    "Output Format. Do not extract streams."
)


def _confidence_gate_thresholds(settings: Settings | None) -> tuple[int, int]:
    low, high = 40, 70
    if settings is not None:
        low = int(getattr(settings, "classification_confidence_gate_low", low))
        high = int(getattr(settings, "classification_confidence_gate_high", high))
    return low, max(low, high)


def _confidence_gate_blocks(
    classification: ClassificationResult,
    *,
    settings: Settings | None = None,
) -> bool:
    """True when the confidence gate rejects this classification.

    Heuristic-default confidences (fabricated fallback values, e.g. landing-page
    memory/pattern candidates) are excluded from gating. A parse-failure marker
    (confidence_source="fallback") on an UNKNOWN page type is an unparseable
    verdict rather than a genuine UNKNOWN judgment, so it is gated too.
    """
    source = str(getattr(classification, "confidence_source", "") or _CONFIDENCE_SOURCE_PARSED)
    if source == _CONFIDENCE_SOURCE_HEURISTIC_DEFAULT:
        return False
    low, _high = _confidence_gate_thresholds(settings)
    score = _CONFIDENCE_SCORE_BY_LEVEL[classification.confidence]
    unparseable_unknown = (
        classification.page_type == PageType.UNKNOWN and source == _CONFIDENCE_SOURCE_FALLBACK
    )
    return unparseable_unknown or score < low


async def _invoke_classification_agent(
    settings: Settings,
    url: str,
    observer: RunObserver | None,
    *,
    instruction_override: str | None = None,
) -> ClassificationResult:
    from src.agents.classification import ClassificationAgent

    try:
        return await ClassificationAgent(settings).run(
            url=url, observer=observer, instruction_override=instruction_override
        )
    except RunCancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("Classification agent failed for %s: %s", url, exc)
        return ClassificationResult(
            url=url,
            page_type=PageType.UNKNOWN,
            confidence=Confidence.LOW,
            reasoning=f"Classification failed: {type(exc).__name__}: {str(exc)[:500]}",
            confidence_source=_CONFIDENCE_SOURCE_FALLBACK,
        )


async def classify_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    child = observer.child("classification", AgentType.CLASSIFICATION) if observer else None
    _emit_orchestrator_decision(
        observer,
        "Calling classification agent",
        details={"url": state["url"], "reason": "recheck page type before routing"},
    )
    result = await _invoke_classification_agent(settings, state["url"], child)
    if _confidence_gate_blocks(result, settings=settings):
        _emit_orchestrator_decision(
            observer,
            "Classification confidence below gate — judge tiebreak re-check",
            status="warning",
            details={
                "url": state["url"],
                "page_type": result.page_type.value,
                "confidence": result.confidence.value,
                "confidence_source": getattr(
                    result, "confidence_source", _CONFIDENCE_SOURCE_PARSED
                ),
                "policy": "single reclassify attempt before terminal no_target",
            },
        )
        result = await _invoke_classification_agent(
            settings,
            state["url"],
            child,
            instruction_override=_CLASSIFICATION_TIEBREAK_INSTRUCTION,
        )
    if settings.ocr_enabled:
        screenshots = _collect_all_screenshots(list(state.get("extraction_results", [])))
        if screenshots:
            try:
                from src.agents.ocr_agent import OcrAgent

                ocr_result = await OcrAgent(settings).run(screenshots[0], observer=child)
                result.metadata["ocr"] = ocr_result.model_dump(mode="json")
            except RunCancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — enrichment must never break routing
                logger.warning("OCR enrichment failed for %s: %s", state["url"], exc)
    next_node = route_after_classification({**state, "classification": result}, settings=settings)
    _emit_orchestrator_decision(
        observer,
        "Classification route selected",
        details={
            "page_type": result.page_type.value,
            "confidence": result.confidence.value,
            "confidence_source": getattr(result, "confidence_source", _CONFIDENCE_SOURCE_PARSED),
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
    pools_box: list[RunPools | None] | None = None,
) -> dict[str, Any]:
    from src.agents.landing_page import LandingPageAgent

    pools = pools_box[0] if pools_box else None
    if pools is not None:
        # Seed the pool's handoff context so workers can build rich handoffs
        # for targets discovered while the landing agent is still running.
        pools.set_handoff_context(
            url=state["url"],
            classification=state.get("classification"),
            matches=list(state.get("matches") or []),
        )

    landing_child = observer.child("landing", AgentType.LANDING_PAGE) if observer else None

    landing_memory_hint = _memory_hint(
        memory,
        url=state["url"],
        page_type=AgentType.LANDING_PAGE.value,
    )
    landing_handoff = _build_landing_handoff(state, memory_hint_text=landing_memory_hint)
    if settings.static_prepass_enabled:
        from src.tools.static_prepass import collect_static_candidate_links

        try:
            static_candidates = await asyncio.to_thread(
                collect_static_candidate_links,
                state["url"],
            )
        except Exception as exc:
            logger.warning("Static landing pre-pass failed for %s: %s", state["url"], exc)
            static_candidates = []
        if static_candidates:
            landing_handoff += "\n\nSTATIC PRE-PASS CANDIDATE LINKS\n" + "\n".join(
                f"- {candidate}" for candidate in static_candidates
            )
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
    except RunCancelledError:
        raise
    except Exception as exc:
        logger.warning("Landing page agent failed for %s: %s", state["url"], exc)
        landing_outcome = _failed_extraction(
            state["url"], PageType.LANDING, AgentType.LANDING_PAGE, exc
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
        normalized_match = (
            match.model_copy(update={"route": "stream_extractor"})
            if match.route != "stream_extractor"
            else match
        )
        normalized_matches.append(normalized_match)
        # Streaming handoff (plan T28 / spike §D2.1): each hosting target is
        # enqueued the moment it is classified, so pool workers start while
        # later matches are still being normalized. The pending list is kept
        # for PipelineState/routing compatibility (informational).
        if pools is not None and not _looks_like_provider_stream_url(normalized_match.url):
            pools.register_match(normalized_match)
            pools.enqueue(HOSTING_ROLE, normalized_match.url, source="landing")
        _, direct_streams = _split_landing_match_handoff_targets(normalized_match)
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
    pools_box: list[RunPools | None] | None = None,
) -> dict[str, Any]:
    """Drainer node for the hosting pool (plan T28 / spike §D1).

    Producers (landing normalization, frontier discoveries) enqueue while
    other stages run; this node closes the producer side, waits until the
    hosting queue drains with no in-flight item, and folds the worker-appended
    results into the graph state. Replaces the former up-front task list +
    ``asyncio.gather(..., return_exceptions=True)`` barrier.
    """
    pools = pools_box[0] if pools_box else None
    ephemeral_pools = False
    if pools is None:
        # Direct node invocation (tests/tools) without a run-scoped pool.
        pools = RunPools(
            run_id=str(state.get("run_id", "")),
            settings=settings,
            observer=observer,
            memory=memory,
        )
        ephemeral_pools = True

    if not state["pending_hosting_urls"] and not pools.has_pending_work(HOSTING_ROLE):
        if ephemeral_pools:
            await pools.aclose()
        return {}

    make_workflow_governor(settings, observer)("hosting_page")

    target_urls = _dedupe_urls(state["pending_hosting_urls"])
    total_targets = len(target_urls)
    _emit_orchestrator_decision(
        observer,
        "Hosting agent targets queued",
        details={"target_count": total_targets, "target_urls": target_urls[:20]},
    )

    try:
        pools.open_cycle(HOSTING_ROLE)
        matches = state.get("matches", [])
        site_url_pattern = ""
        for m in matches:
            if hasattr(m, "patterns") and isinstance(m.patterns, dict):
                site_url_pattern = str(m.patterns.get("url_pattern") or "").strip()
                if site_url_pattern:
                    break

        for idx, target_url in enumerate(target_urls):
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
            newly_queued = pools.enqueue(
                HOSTING_ROLE, target_url, source="graph_state", handoff=handoff
            )
            _emit_orchestrator_decision(
                observer,
                "Hosting handoff prepared",
                details={
                    "target_url": target_url,
                    "target_index": idx + 1,
                    "target_count": total_targets,
                    "newly_queued": newly_queued,
                    "duplicate_suppressed": not newly_queued,
                    "memory_hint_found": bool(hosting_memory_hint),
                },
            )

        await pools.wait_until_drained(HOSTING_ROLE)
        new_results = pools.consume_results(HOSTING_ROLE)
    finally:
        if ephemeral_pools:
            await pools.aclose()

    extraction_results = [*state["extraction_results"], *new_results]
    return {
        "pending_hosting_urls": [],
        "pending_embedded_urls": _dedupe_urls(
            [*state["pending_embedded_urls"], *pools.embedded_enqueued_urls]
        ),
        "extraction_results": extraction_results,
    }


async def embedded_page_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
    memory: LongTermMemory | None = None,
    pools_box: list[RunPools | None] | None = None,
) -> dict[str, Any]:
    """Drainer node for the embedded pool (plan T28 / spike §D1).

    Embedded work reaches the queue only via explicit hosting triggers
    (``activation_failed`` / ``no_networking`` / ``judge_validation_request``)
    or root-URL routing; this node drains it, replacing the former
    ``asyncio.gather(..., return_exceptions=True)`` barrier.
    """
    pools = pools_box[0] if pools_box else None
    ephemeral_pools = False
    if pools is None:
        pools = RunPools(
            run_id=str(state.get("run_id", "")),
            settings=settings,
            observer=observer,
            memory=memory,
        )
        ephemeral_pools = True

    if not state["pending_embedded_urls"] and not pools.has_pending_work(EMBEDDED_ROLE):
        if ephemeral_pools:
            await pools.aclose()
        return {}

    make_workflow_governor(settings, observer)("embedded_page")

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

    try:
        pools.open_cycle(EMBEDDED_ROLE)
        total_targets = len(target_urls)
        if total_targets:
            _emit_orchestrator_decision(
                observer,
                "Embedded agent targets queued",
                details={"target_count": total_targets, "target_urls": target_urls[:20]},
            )
        for idx, target_url in enumerate(target_urls):
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
            newly_queued = pools.enqueue(
                EMBEDDED_ROLE, target_url, source="graph_state", handoff=handoff
            )
            _emit_orchestrator_decision(
                observer,
                "Embedded handoff prepared",
                details={
                    "target_url": target_url,
                    "target_index": idx + 1,
                    "target_count": total_targets,
                    "newly_queued": newly_queued,
                    "duplicate_suppressed": not newly_queued,
                    "memory_hint_found": bool(embedded_memory_hint),
                },
            )

        await pools.wait_until_drained(EMBEDDED_ROLE)
        new_results = pools.consume_results(EMBEDDED_ROLE)
    finally:
        if ephemeral_pools:
            await pools.aclose()

    extraction_results = [*state["extraction_results"], *new_results]
    return {
        "pending_embedded_urls": [],
        "extraction_results": extraction_results,
    }


def repair_malformed_payload(raw_text: str) -> list[dict[str, Any]] | None:
    """Repair seam for malformed stage payloads (plan T15; judge wiring in T24).

    Contract: given raw stage-payload text that failed ``json.loads``, attempt
    to repair it into a list of item dicts. Return the repaired items on
    success, or ``None`` when no repairer is available.

    Today this seam intentionally returns ``None`` — no LLM judging happens
    here. Task 24 (validator agent) will wire a judge-based repairer behind
    this function; callers already treat ``None`` as "repair unavailable"
    and record a structured skip instead of crashing.
    """
    _ = raw_text
    return None


def _safe_build_stage_items(
    parsed: Any,
    model_cls: type[PipelineModel],
    *,
    stage: str,
) -> tuple[list[PipelineModel], list[dict[str, Any]]]:
    """Build stage models per item, skipping poisoned entries instead of crashing.

    Returns ``(valid_items, invalid_items)`` where each invalid entry records
    the stage, a reason, and a truncated preview of the offending payload.
    """
    valid: list[PipelineModel] = []
    invalid: list[dict[str, Any]] = []
    if not isinstance(parsed, list):
        return valid, [
            {
                "stage": stage,
                "reason": f"expected a JSON array, got {type(parsed).__name__}",
                "item_preview": str(parsed)[:300],
            }
        ]
    for index, item in enumerate(parsed):
        try:
            if not isinstance(item, dict):
                raise TypeError(f"expected object, got {type(item).__name__}")
            valid.append(model_cls(**item))
        except Exception as exc:  # noqa: BLE001 — one bad item must not kill the stage
            invalid.append(
                {
                    "stage": stage,
                    "reason": f"{type(exc).__name__}: {exc}",
                    "item_index": index,
                    "item_preview": str(item)[:300],
                }
            )
    return valid, invalid


def _invalid_item_event_details(invalid_items: list[dict[str, Any]]) -> dict[str, Any]:
    """Shape skipped-item previews for an orchestrator_decision event."""
    return {
        "skipped_count": len(invalid_items),
        "skipped_item_previews": [
            {
                "stage": entry.get("stage", ""),
                "reason": str(entry.get("reason", ""))[:200],
                "item_preview": str(entry.get("item_preview", ""))[:200],
            }
            for entry in invalid_items[:5]
        ],
    }


def _emit_invalid_items_event(
    observer: RunObserver | None,
    *,
    invalid_items: list[dict[str, Any]],
) -> None:
    if not invalid_items:
        return
    details = _invalid_item_event_details(invalid_items)
    stages = sorted({str(entry.get("stage", "")) for entry in invalid_items})
    _emit_orchestrator_decision(
        observer,
        "Stage parse skipped malformed items",
        status="warning",
        details={**details, "stages": stages},
    )


async def analyze_providers_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    make_workflow_governor(settings, observer)("analyze_providers")
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
    invalid_items: list[dict[str, Any]] = list(state.get("invalid_items") or [])
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        # Malformed JSON (plan T15): one repair attempt via the judge seam
        # (wired in task 24); until then, record a skip instead of crashing.
        repaired = repair_malformed_payload(str(payload))
        if repaired is None:
            invalid_items.append(
                {
                    "stage": "analyze_providers",
                    "reason": (
                        f"payload is not valid JSON ({type(exc).__name__}); repair unavailable"
                    ),
                    "item_preview": str(payload)[:300],
                }
            )
            parsed = []
        else:
            parsed = repaired
    providers, stage_invalid = _safe_build_stage_items(
        parsed,
        ProviderInfo,
        stage="analyze_providers",
    )
    invalid_items.extend(stage_invalid)
    _emit_invalid_items_event(observer, invalid_items=invalid_items)
    _emit_orchestrator_decision(
        observer,
        "Provider analysis completed",
        status="success" if providers else "warning",
        details={
            **evidence_overview,
            "provider_count": len(providers),
        },
    )
    return {"provider_analysis": providers, "invalid_items": invalid_items}


# ── Evidence-validation gate (plan T24 / VAL-C1/C2, U10, D14) ────────────────


def _filter_dropped_streams(
    extraction_results: list[ExtractionResult],
    dropped_urls: set[str],
) -> list[ExtractionResult]:
    """Return extraction results with dropped stream URLs removed from evidence."""
    if not dropped_urls:
        return list(extraction_results)
    filtered: list[ExtractionResult] = []
    for result in extraction_results:
        kept = [stream for stream in result.streams if stream.url not in dropped_urls]
        if len(kept) == len(result.streams):
            filtered.append(result)
        else:
            filtered.append(result.model_copy(update={"streams": kept}))
    return filtered


async def validate_evidence_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    """Gate between the extraction fan-in and ``analyze_providers`` (plan T24).

    Mandatory reachability probe first (VAL-C2): every candidate stream URL
    gets a HEAD/short-GET probe via httpx and unreachable URLs are dropped
    before they can enter the evidence set. The surviving inventory is then
    scored by an LLM-as-judge into a typed ``JudgeVerdict``; URLs the judge
    flags as suspected-hallucinated are dropped too. Below threshold → one
    bounded replan (max 1 per stage): re-queue the affected target pages back
    through ``hosting_page``; once the budget is spent the run degrades
    gracefully and proceeds with whatever evidence survived.
    """
    make_workflow_governor(settings, observer)("validate_evidence")
    from src.agents.validator import MAX_REPLANS_PER_STAGE, ValidatorAgent

    validator = ValidatorAgent(settings)
    extraction_results = list(state["extraction_results"])
    streams = _collect_all_streams(extraction_results)
    stream_urls = [stream.url for stream in streams]
    screenshot_count = len(_collect_all_screenshots(extraction_results))
    attempts = int(state.get("validator_replan_attempts") or 0)

    # 1. Mandatory reachability probe — before any URL enters the evidence set.
    probes = await validator.probe_reachability(stream_urls) if stream_urls else []
    probe_by_url = {probe.url: probe for probe in probes}
    unreachable = [probe.url for probe in probes if not probe.reachable]

    # 2. LLM-as-judge over the probed inventory.
    verdict = await validator.score_evidence(
        infringing_url=state["url"],
        stream_records=[stream.model_dump() for stream in streams],
        screenshot_count=screenshot_count,
        probe_outcomes={url: probe.reachable for url, probe in probe_by_url.items()},
    )
    flagged = [url for url in verdict.flagged_urls if url in set(stream_urls)]

    # 3. Drop unreachable + judge-flagged URLs from the evidence set.
    dropped = sorted({*unreachable, *flagged})
    kept = [url for url in stream_urls if url not in set(dropped)]
    filtered_results = _filter_dropped_streams(extraction_results, set(dropped))

    threshold = float(getattr(settings, "validator_evidence_threshold", 0.6))
    issues: list[str] = [
        *(f"unreachable stream dropped: {url}" for url in unreachable),
        *(f"judge-flagged stream dropped: {url}" for url in flagged),
    ]
    sufficient = bool(kept) and verdict.verdict != "fail" and verdict.evidence_score >= threshold

    # 4. Bounded replan (max 1 per stage): re-queue affected targets.
    replan = None
    if not sufficient:
        replan = validator.request_replan(
            stage="validate_evidence",
            reason=verdict.reasoning or "evidence below sufficiency threshold",
            attempt=attempts,
        )
    # ``passed`` reflects judge sufficiency only; a queued replan loops back
    # via ``route_after_validate_evidence`` without marking the gate as passed.
    passed = sufficient

    report = ValidationReport(
        passed=passed,
        issues=issues,
        probes=probes,
        dropped_streams=dropped,
        kept_streams=kept,
        verdict=verdict,
        replan=replan,
    )

    if not sufficient and replan is not None:
        affected = [
            result.url
            for result in extraction_results
            if any(stream.url in set(dropped) for stream in result.streams)
        ] or [result.url for result in extraction_results]
        _emit_orchestrator_decision(
            observer,
            "Evidence validation failed; bounded replan queued",
            status="warning",
            details={
                "stage": "validate_evidence",
                "replan_attempt": replan.attempt,
                "max_replans_per_stage": MAX_REPLANS_PER_STAGE,
                "requeued_targets": affected,
                "dropped_stream_count": len(dropped),
                "evidence_score": verdict.evidence_score,
            },
        )
        return {
            "extraction_results": filtered_results,
            "validation_report": report,
            "validator_replan_attempts": attempts + 1,
            "pending_hosting_urls": affected,
        }

    _emit_orchestrator_decision(
        observer,
        "Evidence validation completed",
        status="success" if sufficient else "warning",
        details={
            "passed": passed,
            "evidence_score": verdict.evidence_score,
            "verdict": verdict.verdict,
            "kept_stream_count": len(kept),
            "dropped_stream_count": len(dropped),
            "replan_budget_spent": attempts,
        },
    )
    return {
        "extraction_results": filtered_results,
        "validation_report": report,
        "validator_replan_attempts": attempts,
        "pending_hosting_urls": [],
    }


def route_after_validate_evidence(state: PipelineState) -> str:
    """Deterministic post-validation router.

    A pending bounded replan loops back to ``hosting_page`` with the re-queued
    targets; everything else (pass, or replan budget exhausted → graceful
    degrade) proceeds to ``analyze_providers``.
    """
    report = state.get("validation_report")
    if report is not None and report.replan is not None:
        return "hosting_page"
    return "analyze_providers"


async def generate_takedown_emails_node(
    state: PipelineState,
    *,
    settings: Settings | None = None,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    if settings is not None:
        make_workflow_governor(settings, observer)("generate_takedown_emails")
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
    invalid_items: list[dict[str, Any]] = list(state.get("invalid_items") or [])
    render_invalid: list[dict[str, Any]] = []
    try:
        emails = render_takedown_emails(
            TakedownEmailRenderInput(
                infringing_url=state["url"],
                extraction_results=list(state["extraction_results"]),
                provider_analysis=list(state["provider_analysis"]),
            ),
            invalid_sink=render_invalid,
        )
    except Exception as exc:  # noqa: BLE001 — final stage must never crash the run (T15)
        invalid_items.append(
            {
                "stage": "generate_takedown_emails",
                "reason": f"{type(exc).__name__}: {exc}",
                "item_preview": str(state["url"])[:300],
            }
        )
        _emit_orchestrator_decision(
            observer,
            "Takedown draft generation failed; run continues",
            status="warning",
            details={
                **evidence_overview,
                "email_count": 0,
                **_invalid_item_event_details(invalid_items),
            },
        )
        return {"takedown_emails": [], "invalid_items": invalid_items}
    if render_invalid:
        invalid_items.extend(render_invalid)
        _emit_invalid_items_event(observer, invalid_items=invalid_items)
    _emit_orchestrator_decision(
        observer,
        "Takedown draft generation completed",
        status="success" if emails else "warning",
        details={
            **evidence_overview,
            "email_count": len(emails),
        },
    )
    return {"takedown_emails": emails, "invalid_items": invalid_items}


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


def route_after_classification(state: PipelineState, *, settings: Settings | None = None) -> str:
    """Deterministic post-classification router, gated by classification confidence.

    Transition table (evaluated top to bottom; ``score`` maps
    low/medium/high → 33/66/100 and thresholds default to low=40, high=70):

    | classification            | confidence_source        | verdict                | next node            |
    |---------------------------|--------------------------|------------------------|----------------------|
    | missing                   | —                        | legacy guard           | analyze_providers    |
    | landing/hosting/embedded  | heuristic_default        | excluded from gate     | normal page route*   |
    | landing/hosting/embedded  | parsed or fallback       | score >= low           | normal page route*   |
    | landing/hosting/embedded  | parsed or fallback       | score < low            | no_target (terminal) |
    | UNKNOWN                   | parsed (genuine)         | any                    | analyze_providers    |
    | UNKNOWN                   | fallback (parse failure) | any                    | no_target (terminal) |

    * normal page routes: landing_page / queue_root_hosting / queue_root_embedded,
      where embedded keeps its site-shell → hosting fallback check.

    The single LOW-confidence reclassify attempt happens inside classify_node before
    this router runs, so a result that still fails the gate here has already exhausted
    its retry and terminates at no_target instead of the analyze_providers dead end.
    ``settings`` is bound via functools.partial in build_graph; direct callers may omit
    it (defaults 40/70 apply).
    """
    classification = state["classification"]
    if classification is None:
        return "analyze_providers"
    if _confidence_gate_blocks(classification, settings=settings):
        return "no_target"
    if classification.page_type == PageType.LANDING:
        return "landing_page"
    if classification.page_type == PageType.HOSTING:
        return "queue_root_hosting"
    if classification.page_type == PageType.EMBEDDED:
        if _embedded_classification_needs_hosting_fallback(classification):
            return "queue_root_hosting"
        return "queue_root_embedded"
    return "analyze_providers"


async def no_target_node(
    state: PipelineState,
    *,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    """Terminal stop-path for targets rejected by the confidence gate."""
    classification = state.get("classification")
    _emit_orchestrator_decision(
        observer,
        "Pipeline stopped: confidence gate rejected target",
        status="warning",
        details={
            "reason": (
                "classification stayed below the confidence gate after one "
                "reclassify attempt, or the verdict was unparseable"
            ),
            "page_type": classification.page_type.value if classification else "",
            "confidence": classification.confidence.value if classification else "",
            "confidence_source": str(getattr(classification, "confidence_source", "") or ""),
        },
    )
    return {"gate_no_target": True}


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


def _wrap_plan_step(step_id: str, node_fn, observer: RunObserver | None = None):
    """Wrap a pipeline node so it emits RunPlan SSE transitions (plan T27).

    Emits ``in_progress`` on entry and a terminal status on exit. Persisting
    transitions are best-effort: a DB error during transition must never abort
    a pipeline stage that already produced correct evidence.
    """

    async def _wrapped(state: PipelineState) -> dict[str, Any]:
        run_id = state.get("run_id", "")
        if observer is not None:
            _safe_transition(observer, run_id, step_id, "in_progress")
        try:
            result = await node_fn(state)
        except Exception:
            if observer is not None:
                _safe_transition(observer, run_id, step_id, "failed")
            raise
        if observer is not None:
            _safe_transition(observer, run_id, step_id, "done")
        return result

    return _wrapped


def _safe_transition(observer: RunObserver, run_id: str, step_id: str, status: str) -> None:
    """Persist one plan step transition; swallow errors so pipeline progress wins."""
    try:
        transition_run_step(observer, get_session(), run_id, step_id, status)
    except ValueError:
        # Unknown step id for this run — plan not yet emitted or step mismatch.
        # Not an error for the pipeline; the SSE plan just carries fewer ticks.
        logger.debug(
            "RunPlan step %r not transitioned (%s) for run %s",
            step_id,
            status,
            run_id,
            exc_info=True,
        )
    except Exception:
        logger.debug(
            "RunPlan step %r transition to %s failed for run %s",
            step_id,
            status,
            run_id,
            exc_info=True,
        )


def build_graph(
    settings: Settings,
    observer: RunObserver | None = None,
    pools_box: list[RunPools | None] | None = None,
):
    """Build the deterministic LangGraph orchestration graph.

    ``pools_box`` is a one-slot mutable holder filled by
    :meth:`OrchestratorAgent.run` with the run-scoped :class:`RunPools`, so the
    graph (built once per agent) can hand the current run's pools to nodes.
    """
    memory = LongTermMemory(settings.memory_db_path) if settings.memory_enabled else None
    box: list[RunPools | None] = pools_box if pools_box is not None else [None]
    graph = StateGraph(PipelineState)
    graph.add_node("classify", _wrap_plan_step("classify", partial(classify_node, settings=settings, observer=observer), observer))
    graph.add_node("queue_root_hosting", _wrap_plan_step("queue_root_hosting", partial(queue_root_hosting_node, observer=observer), observer))
    graph.add_node("queue_root_embedded", _wrap_plan_step("queue_root_embedded", partial(queue_root_embedded_node, observer=observer), observer))
    graph.add_node(
        "landing_page",
        _wrap_plan_step(
            "landing_page",
            partial(landing_page_node, settings=settings, observer=observer, memory=memory, pools_box=box),
            observer,
        ),
    )
    graph.add_node(
        "hosting_page",
        _wrap_plan_step(
            "hosting_page",
            partial(hosting_page_node, settings=settings, observer=observer, memory=memory, pools_box=box),
            observer,
        ),
    )
    graph.add_node(
        "embedded_page",
        _wrap_plan_step(
            "embedded_page",
            partial(embedded_page_node, settings=settings, observer=observer, memory=memory, pools_box=box),
            observer,
        ),
    )
    graph.add_node(
        "validate_evidence",
        _wrap_plan_step("validate_evidence", partial(validate_evidence_node, settings=settings, observer=observer), observer),
    )
    graph.add_node(
        "analyze_providers",
        _wrap_plan_step("analyze_providers", partial(analyze_providers_node, settings=settings, observer=observer), observer),
    )
    graph.add_node(
        "generate_takedown_emails",
        _wrap_plan_step("generate_takedown_emails", partial(generate_takedown_emails_node, settings=settings, observer=observer), observer),
    )
    graph.add_node("no_target", partial(no_target_node, observer=observer))

    graph.add_edge(START, "classify")
    # Plan T24: every extraction fan-in route into the provider stage now goes
    # through the validate_evidence gate. Route functions still return
    # "analyze_providers"; only the mapping destination changed.
    graph.add_conditional_edges(
        "classify",
        partial(route_after_classification, settings=settings),
        {
            "landing_page": "landing_page",
            "queue_root_hosting": "queue_root_hosting",
            "queue_root_embedded": "queue_root_embedded",
            "analyze_providers": "validate_evidence",
            "no_target": "no_target",
        },
    )
    graph.add_conditional_edges(
        "landing_page",
        route_after_landing,
        {
            "hosting_page": "hosting_page",
            "embedded_page": "embedded_page",
            "analyze_providers": "validate_evidence",
        },
    )
    graph.add_edge("queue_root_hosting", "hosting_page")
    graph.add_conditional_edges(
        "hosting_page",
        route_after_hosting,
        {
            "hosting_page": "hosting_page",
            "embedded_page": "embedded_page",
            "analyze_providers": "validate_evidence",
        },
    )
    graph.add_edge("queue_root_embedded", "embedded_page")
    graph.add_conditional_edges(
        "embedded_page",
        route_after_embedded,
        {"embedded_page": "embedded_page", "analyze_providers": "validate_evidence"},
    )
    graph.add_conditional_edges(
        "validate_evidence",
        route_after_validate_evidence,
        {"analyze_providers": "analyze_providers", "hosting_page": "hosting_page"},
    )
    graph.add_edge("analyze_providers", "generate_takedown_emails")
    graph.add_edge("generate_takedown_emails", END)
    graph.add_edge("no_target", END)
    return graph.compile()


class OrchestratorAgent:
    """LangGraph orchestrator wrapper."""

    def __init__(self, settings: Settings, observer: RunObserver | None = None) -> None:
        self.settings = settings
        self.observer = observer
        # One-slot holder for the current run's streaming pools (plan T28):
        # the graph is compiled once but pools are per-run.
        self._pools_box: list[RunPools | None] = [None]
        self.graph = build_graph(settings, observer=observer, pools_box=self._pools_box)

    async def _aclose_pools(self) -> None:
        """Tear down the run's pools on every graceful exit path."""
        pools = self._pools_box[0]
        if pools is None:
            return
        self._pools_box[0] = None
        await pools.aclose()

    async def _consume_graph_stream(
        self,
        initial_state: PipelineState,
        sink: dict[str, Any],
    ) -> None:
        """Drive ``graph.astream`` merging each node's output into ``sink``.

        Merged state survives cancellation, so a workflow-deadline abort still
        leaves every completed node's outputs available for the graceful
        partial-completion path (plan T30 / AGT-H3/H4).
        """
        async for chunk in self.graph.astream(initial_state):
            for delta in chunk.values():
                if isinstance(delta, dict):
                    sink.update(delta)

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
            "invalid_items": [],
            "validation_report": None,
            "validator_replan_attempts": 0,
            "error": "",
            "gate_no_target": False,
        }

        # Run-scoped streaming pools (plan T28 / spike §D1): created per run,
        # registered in the module map for hard teardown (spike §D4.4), and
        # reaped once the graph stream finishes (see the finally below).
        pools_box = getattr(self, "_pools_box", None)
        if pools_box is None:  # instance built via object.__new__ in tests
            pools_box = self._pools_box = [None]
        run_pools = RunPools(run_id=run_id, settings=self.settings, observer=self.observer)
        register_run_pools(run_id, run_pools)
        pools_box[0] = run_pools

        live_state: PipelineState | None = None
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
                    live_state: PipelineState = dict(initial_state)
                    # Plan T27: emit the RunPlan artifact once per run so the
                    # SSE timeline (plan_step_update events) reflects the
                    # canonical execution graph.
                    if self.observer is not None:
                        emit_run_plan(
                            self.observer,
                            get_session(),
                            run_id,
                            "sequential",
                            _RUN_PLAN_STEPS,
                        )
                    workflow_deadline = max(
                        1,
                        int(getattr(self.settings, "workflow_timeout_seconds", 3600) or 3600),
                    )
                    try:
                        await asyncio.wait_for(
                            self._consume_graph_stream(initial_state, live_state),
                            timeout=workflow_deadline,
                        )
                    except TimeoutError as exc:
                        raise WorkflowTimeoutError(
                            f"Workflow exceeded global timeout after {workflow_deadline}s"
                        ) from exc
                    finally:
                        # Drainers have joined their workers once the graph
                        # stream ends, so pools are idle here on every exit
                        # path (hard task cancellation falls back to the
                        # app-level cancel hook / spike §D4.4).
                        await self._aclose_pools()
                    final_state = cast(PipelineState, live_state)
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
        except RunCancelledError:
            raise
        except (WorkflowTimeoutError, WorkflowBudgetExceededError) as exc:
            # Graceful partial completion (T30/AGT-H4/M8): return whatever the
            # completed stages produced instead of surfacing an opaque crash.
            kind = classify_failure_kind(exc)
            partial_state = live_state if live_state is not None else dict(initial_state)
            result = _build_pipeline_result(
                partial_state,
                self.observer.trace().metrics if self.observer else None,
            )
            result.failure_kind = kind.value
            logger.warning(
                "Pipeline halted (%s): run_id=%s status=%s streams=%d",
                kind.value,
                run_id,
                result.final_status,
                len(result.all_streams),
            )
            if self.observer is not None:
                self.observer.emit(
                    "pipeline_halted",
                    f"Pipeline halted by {kind.value}; returning partial results",
                    status="warning",
                    details={
                        "failure_kind": kind.value,
                        "final_status": result.final_status.value,
                        "streams_found": len(result.all_streams),
                        "emails_generated": len(result.takedown_emails),
                    },
                )
                self.observer.finish(success=False, failure_mode=kind.value)
                result.metrics = self.observer.trace().metrics
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
    elif state.get("gate_no_target"):
        final_status = ExtractionStatus.NO_TARGET
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
