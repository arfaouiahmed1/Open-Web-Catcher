"""Hosting Page Agent."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.agents.memory import build_memory_context, remember_agent_run
from src.agents.prompting import build_runtime_context, build_task_brief, compile_agent_prompt
from src.memory.long_term import LongTermMemory
from src.memory.short_term import ShortTermMemory
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult, ServerResult, StreamURL
from src.utils.channel_detection import best_channel_match, collect_channel_text_fragments, normalize_channel_name
from src.utils.config import Settings
from src.utils.language_detection import best_language_match, detect_language_candidates
from src.utils.instrumentation import (
    observability_span,
    set_span_output,
    using_observability_context,
)
from src.utils.logging import get_logger
from src.utils.observability import RunObserver

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/hosting_page_v1.md")
_AGENT_CONTRACT = """\
- extract verified stream URLs from the hosting page when possible
- if the host page clearly exposes an iframe src or embedded player URL, return that embedded URL only after trying accessible iframe-local activation evidence instead of guessing streams
- respect the base policy's final JSON/output contract
- use site memory only as hints and re-check everything on the live page
- stay anchored to the assigned hosting content and recover from off-target drift
- preserve screenshot, iframe/embed, network, and player-state evidence per server when available
- return detected channel/broadcast metadata per server only when a known broadcaster name is visible or strongly evidenced
- crawl visible JS-driven player/server/source/language controls before falling back to URL-only evidence
- preserve source language labels when they are shown as flags, country emoji, audio labels, captions, or short codes
- work across any language or script; verify channel/source labels from player evidence instead of English-only terms
- detect source/server switches from multilingual rows, cards, provider groups, dropdown options, quality chips, language labels, and repeated stream/link/option patterns, not only English server buttons
- use `inspect_hosting.server_frontier[]` as the initial source queue when present, then merge landing handoff hints and scoped source-list reads
- build a server_frontier from landing handoff hints plus visible provider groups/source rows, then open, activate/play, screenshot, harvest, and record every same-content source; do not stop after the first successful server
- treat same-event child routes such as provider/index watch URLs as server sources for the current event, using navigate for each real route and rejecting other event slugs
- preserve source_group, source_index, source_url, route_pattern, and current_marker for every attempted source when visible or inferable
- activate/play the default player and every switched server before harvest, capture the post-activation screenshot, then harvest that server
- treat ad redirects, news/article detours, fake downloads, VPN/DNS utility pages, and unrelated provider pages as drift, then recover once unless popup telemetry exposes decoded same-content player URLs
- choose player activation targets from activation_candidates, top_playback_targets, exact scoped evidence, or coordinates; bare play_media is only candidate discovery and is not an activation attempt
- when inspect_hosting exposes iframe-local sample_buttons, sample_links, or sample_videos, choose exact frame_path targets and try play_media or interact before embedded handoff
- treat opened_targets, blocked_popup_attempts, selected_target, target_decision, active_page_url, extracted_player_urls, and blocked_by_client as popup/window/uBlock evidence; record popup_window_diagnostics per server/source
- when selected_target.extracted_player_urls or opened_targets[].extracted_player_urls appears after a Play/Watch click, add those decoded URLs to the current server_frontier and try the most direct player URL before declaring no streams
- do not trust same hostname alone for a new tab/window; compare URL, title, screenshot/layout, assigned content, and media/frame signals before adopting it
- after every Play/Watch overlay click, check whether server/source controls or iframe/player evidence loaded before failing
- after any interaction, react to newly displayed server/source controls by merging them into the current server_frontier and processing them before final JSON or embedded handoff
- remove anything that blocks the assigned player view or whole viewport, including popups, modals, overlays, consent walls, anti-adblock notices, sticky ads, transparent click shields, and full-screen interstitials, using inspect popup close selectors/xpaths, blocker_candidates, or exact close controls before activation, screenshots, harvest, embedded handoff, or failure
- if a click only dismisses a blocker, do not count it as activation; verify the player is visible and continue activation from the revealed state
- switch only same-content server/source controls; never navigate to other matches, channels, listings, articles, or homepages
- if playback does not start, try distinct activation strategies instead of repeating the same click
- if playback fails or no streams are recovered, return an embedded fallback only when the current hosting page exposes an explicit iframe src or embedded/player URL and iframe-local activation was tried or inaccessible; otherwise stop with failure evidence and no fabricated next target
"""


class HostingPageAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = None
        self.memory = LongTermMemory(settings.memory_db_path) if settings.memory_enabled else None
        self._system_prompt = (
            PROMPT_PATH.read_text(encoding="utf-8")
            if PROMPT_PATH.exists()
            else "Extract all stream URLs from this hosting page."
        )

    async def run(
        self,
        url: str,
        observer: RunObserver | None = None,
        orchestrator_handoff: str = "",
    ) -> ExtractionResult:
        from src.agents.base import build_llm, run_agent_loop
        from src.tools.mcp_client import agent_tools

        if self.llm is None:
            self.llm = build_llm(self.settings, agent_id="hosting")
        logger.info("HostingPageAgent: %s", url)
        if observer is not None:
            observer.mark_agent(AgentType.HOSTING_PAGE)
            observer.emit("agent_started", f"Hosting page agent started for {url}")
            if orchestrator_handoff.strip():
                observer.emit(
                    "orchestrator_handoff_received",
                    "Hosting agent received orchestrator guidance",
                    details={"handoff_preview": orchestrator_handoff[:800]},
                )

        with using_observability_context(
            session_id=observer.run_id if observer is not None else "",
            metadata={"agent_type": AgentType.HOSTING_PAGE.value, "url": url},
            tags=["hosting", "agent"],
        ):
            with observability_span(
                "hosting_page_agent.run",
                kind="agent",
                input_value={"url": url},
                attributes={"owc.agent_type": AgentType.HOSTING_PAGE.value},
            ) as span:
                short_memory = ShortTermMemory(
                    k=self.settings.memory_short_window,
                    page_type=AgentType.HOSTING_PAGE.value,
                )
                memory_context = build_memory_context(
                    self.memory,
                    url=url,
                    page_type=AgentType.HOSTING_PAGE.value,
                    prompt_limit=self.settings.memory_prompt_limit,
                    observer=observer,
                )
                compiled_prompt = compile_agent_prompt(
                    settings=self.settings,
                    agent_id=AgentType.HOSTING_PAGE.value,
                    base_policy=self._system_prompt,
                    agent_contract=_AGENT_CONTRACT,
                    task_brief=build_task_brief(
                        url=url,
                        page_type=AgentType.HOSTING_PAGE.value,
                        run_goal="Extract streams directly from the hosting page or identify the embedded player handoff.",
                        extras={
                            "orchestrator_handoff": orchestrator_handoff[:600]
                            if orchestrator_handoff
                            else "",
                        },
                    ),
                    memory_context=memory_context,
                    working_state=short_memory.working_state(
                        objective="Extract streams from the hosting page or find the embedded handoff.",
                        page_url=url,
                        page_type=AgentType.HOSTING_PAGE.value,
                        anchor_url=url,
                        navigation_policy=(
                            "same-content okay: allow server/source URL changes only when the same event/player stays in focus; "
                            "do not navigate to other matches, channels, listings, articles, or homepages; "
                            "treat ad redirects, unrelated pages, homepages, and off-target provider detours as drift"
                        ),
                    ),
                    runtime_context=build_runtime_context(
                        tool_profile="hosting",
                        max_tool_calls=self.settings.hosting_page_max_tool_calls,
                    ),
                )
                if observer is not None:
                    observer.emit(
                        "prompt_compiled",
                        "Compiled layered prompt for hosting page agent",
                        details=compiled_prompt.model_dump(exclude={"content"}),
                    )
                initial_message = (
                    f"Extract all stream URLs from this hosting page.\n\nmainUrl: {url}"
                )
                if orchestrator_handoff.strip():
                    initial_message += (
                        "\n\nORCHESTRATOR HANDOFF\n"
                        f"{orchestrator_handoff}\n"
                        "Use this context as guidance and verify findings from live page evidence."
                    )
                async with agent_tools("hosting", self.settings, observer=observer) as tools:
                    result = await run_agent_loop(
                        settings=self.settings,
                        llm=self.llm,
                        tools=tools,
                        system_prompt=compiled_prompt.content,
                        initial_message=initial_message,
                        max_tool_calls=self.settings.hosting_page_max_tool_calls,
                        budget_exhausted_message="Budget exhausted. Output your final JSON now.",
                        observer=observer,
                        run_name="hosting_page_agent",
                        working_memory=short_memory,
                        prompt_metadata=compiled_prompt.model_dump(exclude={"content"}),
                        turn_context_provider=lambda _state: short_memory.working_state(
                            objective="Extract streams from the hosting page or find the embedded handoff.",
                            page_url=url,
                            page_type=AgentType.HOSTING_PAGE.value,
                            anchor_url=url,
                            navigation_policy=(
                                "same-content okay: allow server/source URL changes only when the same event/player stays in focus; "
                                "do not navigate to other matches, channels, listings, articles, or homepages; "
                                "treat ad redirects, unrelated pages, homepages, and off-target provider detours as drift"
                            ),
                        ),
                        bootstrap_url=url,
                        bootstrap_context_first=True,
                        bootstrap_memory_lookup_first=True,
                        bootstrap_memory_page_type=AgentType.HOSTING_PAGE.value,
                        runtime_profile=AgentType.HOSTING_PAGE.value,
                    )

                output = result.parse_json()
                run_memory = short_memory.export_run_memory(page_type=AgentType.HOSTING_PAGE.value)
                output = _merge_run_memory_into_hosting_output(output, run_memory=run_memory)
                output.setdefault(
                    "agent_run",
                    {
                        "stop_reason": getattr(result, "stop_reason", "completed"),
                        "budget_exhausted": bool(getattr(result, "budget_exhausted", False)),
                        "tool_calls_used": result.tool_calls_made,
                        "bootstrap_tool_calls": int(
                            getattr(result, "bootstrap_tool_calls", 0) or 0
                        ),
                        "llm_tool_calls_made": int(
                            getattr(result, "llm_tool_calls_made", result.tool_calls_made) or 0
                        ),
                        "parse_error": str(getattr(result, "parse_error", "") or ""),
                        "continuation_count": int(
                            getattr(result, "continuation_count", 0) or 0
                        ),
                        "continuation_capsules": list(
                            getattr(result, "continuation_capsules", []) or []
                        ),
                    },
                )
                if getattr(result, "parse_error", ""):
                    output["raw_final_text"] = str(getattr(result, "final_text", "") or "")[:4000]
                normalized_output = _normalize_hosting_output(output)
                streams = _collect_streams(normalized_output)
                decision = normalized_output.get("decision", "")
                servers = _build_server_results(normalized_output.get("servers", []))
                screenshots = [server.screenshot_url for server in servers if server.screenshot_url]
                embedded_urls = _dedupe_urls(
                    [
                        candidate
                        for server in servers
                        for candidate in (server.embedded_url, server.player_iframe_url)
                        if candidate
                    ]
                )

                status = (
                    ExtractionStatus.SUCCESS
                    if streams
                    else ExtractionStatus.PARTIAL
                    if decision in ("needs_embed_agent", "partial_success_needs_embed")
                    else ExtractionStatus.FAILED
                )

                extraction = ExtractionResult(
                    url=url,
                    page_type=PageType.HOSTING,
                    status=status,
                    streams=streams,
                    screenshots=screenshots,
                    embedded_urls=embedded_urls,
                    servers=servers,
                    primary_channel=str(normalized_output.get("primary_channel") or "").strip(),
                    detected_channels=list(normalized_output.get("detected_channels") or []),
                    channel_metadata=dict(normalized_output.get("channel_metadata") or {}),
                    agent_type=AgentType.HOSTING_PAGE,
                    tool_calls_used=result.tool_calls_made,
                    metadata=normalized_output,
                )
                set_span_output(
                    span,
                    {
                        "streams_found": len(streams),
                        "embedded_urls": extraction.embedded_urls,
                        "status": extraction.status.value,
                        "decision": decision,
                    },
                )
                remember_agent_run(
                    self.memory,
                    url=url,
                    page_type=AgentType.HOSTING_PAGE.value,
                    status=extraction.status.value,
                    payload=normalized_output,
                    observer=observer,
                    short_memory=short_memory,
                )

        if observer is not None:
            observer.emit(
                "agent_finished",
                f"Hosting page agent finished with {len(streams)} streams",
                status="success" if streams else "warning",
                details={
                    "streams_found": len(streams),
                    "embedded_urls": extraction.embedded_urls,
                    "decision": decision,
                },
            )
        return extraction


def _protocol_from_url(url: str) -> str:
    lowered = str(url or "").lower()
    if ".m3u8" in lowered:
        return "hls"
    if ".mpd" in lowered:
        return "dash"
    if ".mp4" in lowered:
        return "mp4"
    return ""


def _dedupe_urls(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        candidate = str(value or "").strip()
        if candidate and candidate not in seen:
            seen.add(candidate)
            result.append(candidate)
    return result


def _normalize_url_list(value: Any) -> list[str]:
    if isinstance(value, list):
        urls: list[str] = []
        for item in value:
            if isinstance(item, dict):
                candidate = str(
                    item.get("url")
                    or item.get("stream_url")
                    or item.get("playlist_url")
                    or item.get("manifest_url")
                    or ""
                ).strip()
            else:
                candidate = str(item or "").strip()
            if candidate:
                urls.append(candidate)
        return _dedupe_urls(urls)
    if isinstance(value, dict):
        candidate = str(
            value.get("url")
            or value.get("stream_url")
            or value.get("playlist_url")
            or value.get("manifest_url")
            or ""
        ).strip()
        return [candidate] if candidate else []
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _normalize_diagnostics_list(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _is_tokenized_url(url: str) -> bool:
    lowered = str(url or "").lower()
    return any(
        token in lowered
        for token in (
            "token=",
            "signature=",
            "sig=",
            "expires=",
            "expires_at=",
            "exp=",
            "policy=",
            "key-pair-id=",
            "x-amz-",
            "x-goog-",
            "hdnts=",
        )
    )


def _stream_role_from_url(url: str, protocol: str) -> str:
    lowered = str(url or "").lower()
    if protocol == "hls":
        if "master" in lowered:
            return "master_playlist"
        if "chunklist" in lowered or "media" in lowered or "index" in lowered:
            return "media_playlist"
        return "playlist"
    if protocol == "dash":
        return "manifest"
    if protocol == "mp4":
        return "direct_file"
    return ""


def _normalize_protocol_details(
    value: Any, server: dict[str, Any], *, source: str
) -> list[dict[str, Any]]:
    details: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def add_detail(raw: Any, default_protocol: str = "") -> None:
        if isinstance(raw, dict):
            url = str(
                raw.get("url")
                or raw.get("stream_url")
                or raw.get("playlist_url")
                or raw.get("manifest_url")
                or ""
            ).strip()
            protocol = str(
                raw.get("protocol")
                or raw.get("type")
                or default_protocol
                or _protocol_from_url(url)
            ).strip()
            role = str(raw.get("role") or _stream_role_from_url(url, protocol)).strip()
            detail = {
                "protocol": protocol,
                "url": url,
                "role": role,
                "playlist_url": str(raw.get("playlist_url") or "").strip(),
                "stream_url": str(raw.get("stream_url") or "").strip(),
                "tokenized": bool(raw.get("tokenized")) or _is_tokenized_url(url),
                "expires_at": str(raw.get("expires_at") or raw.get("expires") or "").strip(),
                "headers_required": bool(raw.get("headers_required")),
                "source": str(raw.get("source") or source).strip(),
            }
        else:
            url = str(raw or "").strip()
            protocol = default_protocol or _protocol_from_url(url)
            detail = {
                "protocol": protocol,
                "url": url,
                "role": _stream_role_from_url(url, protocol),
                "playlist_url": url if protocol in {"hls", "dash"} else "",
                "stream_url": url if protocol == "mp4" else "",
                "tokenized": _is_tokenized_url(url),
                "expires_at": "",
                "headers_required": False,
                "source": source,
            }
        if not detail["url"]:
            return
        key = (detail["url"], detail["protocol"])
        if key in seen:
            return
        seen.add(key)
        details.append(detail)

    if isinstance(value, list):
        for item in value:
            add_detail(item)
    elif isinstance(value, dict):
        add_detail(value)

    for protocol, field in (("hls", "m3u8_urls"), ("dash", "mpd_urls"), ("mp4", "mp4_urls")):
        for url in _normalize_url_list(server.get(field)):
            add_detail(url, protocol)
    for url in _normalize_url_list(server.get("stream_urls")):
        add_detail(url)

    return details


def _normalize_server_entry(server: dict[str, Any], index: int) -> dict[str, Any]:
    label = (
        str(server.get("label") or server.get("name") or f"server_{index + 1}").strip()
        or f"server_{index + 1}"
    )
    m3u8_urls = _normalize_url_list(server.get("m3u8_urls"))
    mpd_urls = _normalize_url_list(server.get("mpd_urls"))
    mp4_urls = _normalize_url_list(server.get("mp4_urls"))
    raw_stream_urls = _normalize_url_list(server.get("stream_urls"))
    for item in raw_stream_urls:
        protocol = _protocol_from_url(item)
        if protocol == "hls":
            m3u8_urls = _dedupe_urls([*m3u8_urls, item])
        elif protocol == "dash":
            mpd_urls = _dedupe_urls([*mpd_urls, item])
        elif protocol == "mp4":
            mp4_urls = _dedupe_urls([*mp4_urls, item])
    stream_urls = _dedupe_urls([*raw_stream_urls, *m3u8_urls, *mpd_urls, *mp4_urls])

    primary_stream = str(server.get("primary_stream") or "").strip()
    if not primary_stream:
        for candidate in stream_urls:
            if candidate:
                primary_stream = candidate
                break
    protocol_details = _normalize_protocol_details(
        server.get("protocol_details") or server.get("stream_details") or [],
        {
            **server,
            "m3u8_urls": m3u8_urls,
            "mpd_urls": mpd_urls,
            "mp4_urls": mp4_urls,
            "stream_urls": stream_urls,
        },
        source=label,
    )

    status = str(server.get("status") or "").strip().lower()
    embedded_url = str(server.get("embedded_url") or "").strip()
    embedded_url_source = str(server.get("embedded_url_source") or "").strip()
    player_iframe_url = str(
        server.get("player_iframe_url") or server.get("iframe_url") or ""
    ).strip()
    if not status:
        status = (
            "success"
            if stream_urls
            else ("needs_embed_agent" if (embedded_url or player_iframe_url) else "failed")
        )

    server_up_value = server.get("server_up")
    server_up = (
        bool(server_up_value)
        if isinstance(server_up_value, bool)
        else status in {"success", "partial", "active"}
    )
    channel_texts = collect_channel_text_fragments(
        [
            label,
            server.get("channel"),
            server.get("detected_channel"),
            server.get("ocr_text"),
            server.get("player_ocr_text"),
            server.get("visual_confirmation"),
            server.get("session_summary"),
        ]
    )
    channel_match = best_channel_match(*channel_texts)
    language_candidates = [
        item
        for item in detect_language_candidates(
            label,
            server.get("language"),
            server.get("language_candidates"),
            server.get("audio"),
            server.get("audio_track"),
            server.get("subtitle"),
            server.get("caption"),
            server.get("ocr_text"),
            server.get("visual_confirmation"),
        )
        if item
    ]
    raw_language = str(server.get("language") or server.get("detected_language") or "").strip()
    detected_language = raw_language or best_language_match(label, server.get("ocr_text"))
    detected_channel = normalize_channel_name(
        str(server.get("detected_channel") or server.get("channel") or "").strip()
    )
    if not detected_channel:
        detected_channel = normalize_channel_name(
            str(channel_match.get("channel_name") or "").strip()
        )
    channel_candidates = _dedupe_urls(
        [
            detected_channel,
            *[
                normalize_channel_name(item)
                for item in (
                    server.get("channel_candidates", [])
                    if isinstance(server.get("channel_candidates"), list)
                    else channel_match.get("channel_candidates", [])
                )
            ],
        ]
    )

    return {
        "label": label,
        "source_group": str(
            server.get("source_group")
            or server.get("provider")
            or server.get("group")
            or server.get("server_group")
            or ""
        ).strip(),
        "source_index": _safe_int(
            server.get("source_index") if server.get("source_index") is not None else index,
            index,
        ),
        "source_url": str(
            server.get("source_url") or server.get("url") or server.get("href") or ""
        ).strip(),
        "route_pattern": str(server.get("route_pattern") or server.get("pattern") or "").strip(),
        "current_marker": bool(
            server.get("current_marker") or server.get("is_current") or server.get("current")
        ),
        "server_up": server_up,
        "screenshot_url": str(server.get("screenshot_url") or "").strip(),
        "embedded_url": embedded_url,
        "embedded_url_source": embedded_url_source,
        "player_iframe_url": player_iframe_url,
        "m3u8_urls": m3u8_urls,
        "mpd_urls": mpd_urls,
        "mp4_urls": mp4_urls,
        "stream_urls": stream_urls,
        "protocol_details": protocol_details,
        "primary_stream": primary_stream,
        "status": status,
        "down_reason": str(server.get("down_reason") or "").strip(),
        "activation_attempts": _safe_int(server.get("activation_attempts"), 0),
        "player_state": str(server.get("player_state") or "").strip(),
        "visual_confirmation": str(server.get("visual_confirmation") or "").strip(),
        "extraction_method": str(server.get("extraction_method") or "").strip(),
        "detected_channel": detected_channel,
        "channel_candidates": channel_candidates,
        "channel_confidence": str(
            server.get("channel_confidence") or channel_match.get("channel_confidence") or ""
        ).strip(),
        "channel_detection_method": str(
            server.get("channel_detection_method")
            or ("ocr+screenshot" if str(server.get("ocr_text") or server.get("player_ocr_text") or "").strip() else channel_match.get("channel_detection_method") or "")
        ).strip(),
        "language": detected_language,
        "language_candidates": _dedupe_urls([detected_language, *language_candidates]),
        "ocr_text": str(server.get("ocr_text") or server.get("player_ocr_text") or "").strip(),
        "playback_confirmed": bool(server.get("playback_confirmed"))
        or str(server.get("player_state") or "").strip().lower() == "playing"
        or "video playing" in str(server.get("visual_confirmation") or "").lower(),
        "server_change_observed": bool(server.get("server_change_observed"))
        or bool(server.get("switch_detected"))
        or bool(server.get("switched")),
        "network_diagnostics": _normalize_diagnostics_list(server.get("network_diagnostics")),
        "iframe_diagnostics": _normalize_diagnostics_list(server.get("iframe_diagnostics")),
        "popup_window_diagnostics": _normalize_diagnostics_list(
            server.get("popup_window_diagnostics")
            or server.get("popup_diagnostics")
            or server.get("window_diagnostics")
        ),
    }


def _normalize_servers(output: dict[str, Any]) -> list[dict[str, Any]]:
    rows = output.get("servers", [])
    if not isinstance(rows, list):
        return []
    normalized = [
        _normalize_server_entry(server, index)
        for index, server in enumerate(rows)
        if isinstance(server, dict)
    ]
    return normalized


def _normalize_streaming_urls(
    output: dict[str, Any], servers: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    rows = output.get("streaming_urls", [])
    if not isinstance(rows, list):
        rows = []

    merged: list[dict[str, Any]] = []
    seen: set[str] = set()

    for row in rows:
        if not isinstance(row, dict):
            continue
        url = str(row.get("url") or row.get("stream_url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        merged.append(
            {
                "url": url,
                "source": str(row.get("source") or "").strip(),
                "type": str(
                    row.get("type") or row.get("protocol") or _protocol_from_url(url)
                ).strip(),
                "role": str(row.get("role") or "").strip(),
            }
        )

    for server in servers:
        source = str(server.get("label") or "").strip()
        for protocol, field in (("m3u8", "m3u8_urls"), ("mpd", "mpd_urls"), ("mp4", "mp4_urls")):
            for url in server.get(field, []):
                url_text = str(url or "").strip()
                if not url_text or url_text in seen:
                    continue
                seen.add(url_text)
                merged.append({"url": url_text, "source": source, "type": protocol, "role": ""})
        for url in server.get("stream_urls", []):
            url_text = str(url or "").strip()
            if not url_text or url_text in seen:
                continue
            seen.add(url_text)
            merged.append(
                {
                    "url": url_text,
                    "source": source,
                    "type": _protocol_from_url(url_text),
                    "role": "",
                }
            )

    return merged


def _merge_run_memory_into_hosting_output(
    output: dict[str, Any], *, run_memory: dict[str, Any]
) -> dict[str, Any]:
    """Fallback-merge concrete tool evidence captured in short-term memory."""
    merged = dict(output or {})
    memory_streams = _dedupe_urls(
        [
            *list(run_memory.get("stream_urls", []) if isinstance(run_memory, dict) else []),
            *list(run_memory.get("server_stream_urls", []) if isinstance(run_memory, dict) else []),
        ]
    )
    memory_iframes = _dedupe_urls(
        list(run_memory.get("iframe_urls", []) if isinstance(run_memory, dict) else [])
    )
    memory_screenshots = _dedupe_urls(
        list(run_memory.get("server_screenshots", []) if isinstance(run_memory, dict) else [])
    )

    streaming_urls = merged.get("streaming_urls", [])
    if not isinstance(streaming_urls, list):
        streaming_urls = []
    existing_streams = {
        str(item.get("url") or item.get("stream_url") or "").strip()
        for item in streaming_urls
        if isinstance(item, dict)
    }
    for stream_url in memory_streams:
        if not stream_url.startswith(("http://", "https://")) or stream_url in existing_streams:
            continue
        streaming_urls.append(
            {
                "url": stream_url,
                "source": "short_term_memory",
                "type": _protocol_from_url(stream_url),
                "role": "memory_fallback",
            }
        )
        existing_streams.add(stream_url)
    merged["streaming_urls"] = streaming_urls

    embedded_urls = _dedupe_urls(
        [
            *_normalize_url_list(merged.get("servers_needing_embed")),
            *_normalize_url_list(merged.get("embedded_urls_for_processing")),
            *memory_iframes,
        ]
    )
    if embedded_urls:
        merged["servers_needing_embed"] = embedded_urls
        merged["embedded_urls_for_processing"] = embedded_urls

    servers = merged.get("servers", [])
    if not isinstance(servers, list):
        servers = []
    if not servers and (memory_streams or embedded_urls or memory_screenshots):
        iframe = embedded_urls[0] if embedded_urls else ""
        servers = [
            {
                "label": "memory_evidence",
                "server_up": bool(memory_streams),
                "screenshot_url": memory_screenshots[0] if memory_screenshots else "",
                "embedded_url": iframe,
                "embedded_url_source": "short_term_memory" if iframe else "",
                "player_iframe_url": iframe,
                "stream_urls": memory_streams,
                "primary_stream": memory_streams[0] if memory_streams else "",
                "status": "success"
                if memory_streams
                else ("needs_embed_agent" if iframe else "failed"),
                "extraction_method": "short_term_memory",
                "player_state": "unknown",
                "visual_confirmation": "tool evidence recovered from short-term memory",
            }
        ]
    merged["servers"] = servers
    return merged


def _normalize_hosting_output(output: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(output or {})
    servers = _normalize_servers(normalized)
    normalized["servers"] = servers
    normalized["streaming_urls"] = _normalize_streaming_urls(normalized, servers)
    normalized["all_detected_servers"] = _dedupe_urls(
        [str(item.get("label") or "").strip() for item in servers]
    )

    top_level_embeds: list[str] = []
    for key in ("servers_needing_embed", "embedded_urls_for_processing", "embedded_urls"):
        top_level_embeds.extend(_normalize_url_list(normalized.get(key)))
    per_server_embeds = [
        candidate
        for item in servers
        for candidate in (
            str(item.get("embedded_url") or "").strip(),
            str(item.get("player_iframe_url") or "").strip(),
        )
        if candidate
    ]
    normalized["servers_needing_embed"] = _dedupe_urls([*top_level_embeds, *per_server_embeds])
    normalized["embedded_urls_for_processing"] = list(normalized["servers_needing_embed"])
    successful_servers = sum(
        1
        for server in servers
        if server.get("status") in {"success", "partial"} or server.get("server_up")
    )
    failed_servers_count = sum(
        1 for server in servers if server.get("status") in {"failed", "needs_embed_agent"}
    )
    down_servers_count = sum(
        1
        for server in servers
        if not server.get("server_up") and str(server.get("down_reason") or "").strip()
    )
    normalized["total_servers"] = int(normalized.get("total_servers") or len(servers))
    normalized["successful_servers"] = int(
        normalized.get("successful_servers") or successful_servers
    )
    normalized["failed_servers_count"] = int(
        normalized.get("failed_servers_count") or failed_servers_count
    )
    normalized["down_servers_count"] = int(
        normalized.get("down_servers_count") or down_servers_count
    )
    normalized["total_unique_streams"] = int(
        normalized.get("total_unique_streams") or len(normalized["streaming_urls"])
    )
    decision = str(normalized.get("decision") or "").strip().lower()
    if not decision:
        if normalized["streaming_urls"] and normalized["servers_needing_embed"]:
            decision = "partial_success_needs_embed"
        elif normalized["streaming_urls"]:
            decision = "safe_exit"
        elif normalized["servers_needing_embed"]:
            decision = "needs_embed_agent"
        else:
            decision = "no_stream_found"
    normalized["decision"] = decision
    channel_texts = collect_channel_text_fragments(
        [
            normalized.get("channel"),
            normalized.get("detected_channel"),
            normalized.get("session_summary"),
            normalized.get("page_title"),
            normalized.get("event_title"),
            normalized.get("servers"),
        ]
    )
    channel_match = best_channel_match(*channel_texts)
    detected_channels = _dedupe_urls(
        [
            normalize_channel_name(str(normalized.get("primary_channel") or normalized.get("channel") or "").strip())
            or normalize_channel_name(str(channel_match.get("channel_name") or "").strip()),
            *[
                normalize_channel_name(server.get("detected_channel"))
                for server in servers
                if isinstance(server, dict)
            ],
            *[
                normalize_channel_name(item)
                for item in channel_match.get("channel_candidates", [])
            ],
        ]
    )
    primary_channel = detected_channels[0] if detected_channels else ""
    normalized["primary_channel"] = primary_channel
    normalized["detected_channels"] = detected_channels
    normalized["channel_metadata"] = {
        "primary_channel": primary_channel,
        "channel_candidates": detected_channels,
        "channel_confidence": channel_match.get("channel_confidence", ""),
        "channel_detection_method": channel_match.get("channel_detection_method", ""),
        "channel_evidence": channel_match.get("channel_evidence", []),
        "ocr_texts": [
            str(server.get("ocr_text") or "").strip()
            for server in servers
            if isinstance(server, dict) and str(server.get("ocr_text") or "").strip()
        ][:6],
    }
    return normalized


def _build_server_results(servers: list[dict[str, Any]]) -> list[ServerResult]:
    result: list[ServerResult] = []
    for server in servers:
        result.append(
            ServerResult(
                label=str(server.get("label") or "default"),
                source_group=str(server.get("source_group") or "") or None,
                source_index=(
                    _safe_int(server.get("source_index"), 0)
                    if server.get("source_index") is not None
                    else None
                ),
                source_url=str(server.get("source_url") or "") or None,
                route_pattern=str(server.get("route_pattern") or "") or None,
                current_marker=bool(server.get("current_marker")),
                server_up=bool(server.get("server_up")),
                m3u8_urls=_normalize_url_list(server.get("m3u8_urls")),
                mpd_urls=_normalize_url_list(server.get("mpd_urls")),
                mp4_urls=_normalize_url_list(server.get("mp4_urls")),
                stream_urls=_normalize_url_list(server.get("stream_urls")),
                protocol_details=_normalize_diagnostics_list(server.get("protocol_details")),
                primary_stream=str(server.get("primary_stream") or "") or None,
                screenshot_url=str(server.get("screenshot_url") or "") or None,
                embedded_url=str(server.get("embedded_url") or "") or None,
                embedded_url_source=str(server.get("embedded_url_source") or "") or None,
                player_iframe_url=str(server.get("player_iframe_url") or "") or None,
                status=str(server.get("status") or "failed"),
                down_reason=str(server.get("down_reason") or "") or None,
                activation_attempts=_safe_int(server.get("activation_attempts"), 0),
                player_state=str(server.get("player_state") or "") or None,
                visual_confirmation=str(server.get("visual_confirmation") or "") or None,
                extraction_method=str(server.get("extraction_method") or "") or None,
                detected_channel=str(server.get("detected_channel") or "") or None,
                channel_candidates=_normalize_url_list(server.get("channel_candidates")),
                channel_confidence=str(server.get("channel_confidence") or "") or None,
                channel_detection_method=str(server.get("channel_detection_method") or "") or None,
                language=str(server.get("language") or "") or None,
                language_candidates=_normalize_url_list(server.get("language_candidates")),
                ocr_text=str(server.get("ocr_text") or "") or None,
                playback_confirmed=bool(server.get("playback_confirmed")),
                server_change_observed=bool(server.get("server_change_observed")),
                network_diagnostics=_normalize_diagnostics_list(server.get("network_diagnostics")),
                iframe_diagnostics=_normalize_diagnostics_list(server.get("iframe_diagnostics")),
                popup_window_diagnostics=_normalize_diagnostics_list(
                    server.get("popup_window_diagnostics")
                ),
            )
        )
    return result


def _collect_streams(output: dict[str, Any]) -> list[StreamURL]:
    seen: set[str] = set()
    streams: list[StreamURL] = []
    for entry in output.get("streaming_urls", []):
        url = str(entry.get("url") or "").strip()
        if url and url not in seen:
            seen.add(url)
            streams.append(
                StreamURL(
                    url=url,
                    protocol=str(
                        entry.get("type") or entry.get("protocol") or _protocol_from_url(url)
                    ),
                    source_layer=str(entry.get("source") or ""),
                    channel_name=str(output.get("primary_channel") or ""),
                )
            )
    for server in output.get("servers", []):
        server_urls = (
            server.get("stream_urls", [])
            + server.get("m3u8_urls", [])
            + server.get("mpd_urls", [])
            + server.get("mp4_urls", [])
        )
        for url in server_urls:
            url_text = str(url or "").strip()
            if url_text and url_text not in seen:
                seen.add(url_text)
                streams.append(
                    StreamURL(
                        url=url_text,
                        protocol=_protocol_from_url(url_text),
                        source_layer=str(server.get("label") or ""),
                        channel_name=str(server.get("detected_channel") or output.get("primary_channel") or ""),
                    )
                )
    return streams
