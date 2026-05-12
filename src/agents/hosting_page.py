"""Hosting Page Agent."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from src.agents.base import build_llm, run_agent_loop
from src.agents.memory import build_memory_context, remember_agent_run
from src.agents.prompting import build_runtime_context, build_task_brief, compile_agent_prompt
from src.memory.long_term import LongTermMemory
from src.memory.short_term import ShortTermMemory
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult, ServerResult, StreamURL
from src.tools.mcp_client import agent_tools
from src.utils.config import Settings
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
- if the host page clearly hands off to an embedded player, return that embedded URL instead of guessing streams
- respect the base policy's final JSON/output contract
- use site memory only as hints and re-check everything on the live page
- stay anchored to the assigned hosting content and recover from off-target drift
- preserve screenshot, iframe/embed, network, and player-state evidence per server when available
- if playback fails or no streams are recovered, return an embedded fallback only when you observed an explicit embedded/player URL; otherwise stop with failure evidence and no fabricated next target
"""


class HostingPageAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings, agent_id="hosting")
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
                                "treat ad redirects, unrelated pages, homepages, and off-target provider detours as drift"
                            ),
                        ),
                        bootstrap_url=url,
                        bootstrap_context_first=True,
                        bootstrap_memory_lookup_first=True,
                        bootstrap_memory_page_type=AgentType.HOSTING_PAGE.value,
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
        return _dedupe_urls([str(item or "").strip() for item in value])
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

    return {
        "label": label,
        "server_up": server_up,
        "screenshot_url": str(server.get("screenshot_url") or "").strip(),
        "embedded_url": embedded_url,
        "embedded_url_source": embedded_url_source,
        "player_iframe_url": player_iframe_url,
        "m3u8_urls": m3u8_urls,
        "mpd_urls": mpd_urls,
        "mp4_urls": mp4_urls,
        "stream_urls": stream_urls,
        "primary_stream": primary_stream,
        "status": status,
        "down_reason": str(server.get("down_reason") or "").strip(),
        "activation_attempts": _safe_int(server.get("activation_attempts"), 0),
        "player_state": str(server.get("player_state") or "").strip(),
        "visual_confirmation": str(server.get("visual_confirmation") or "").strip(),
        "extraction_method": str(server.get("extraction_method") or "").strip(),
        "network_diagnostics": _normalize_diagnostics_list(server.get("network_diagnostics")),
        "iframe_diagnostics": _normalize_diagnostics_list(server.get("iframe_diagnostics")),
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
    return normalized


def _build_server_results(servers: list[dict[str, Any]]) -> list[ServerResult]:
    result: list[ServerResult] = []
    for server in servers:
        result.append(
            ServerResult(
                label=str(server.get("label") or "default"),
                server_up=bool(server.get("server_up")),
                m3u8_urls=_normalize_url_list(server.get("m3u8_urls")),
                mpd_urls=_normalize_url_list(server.get("mpd_urls")),
                mp4_urls=_normalize_url_list(server.get("mp4_urls")),
                stream_urls=_normalize_url_list(server.get("stream_urls")),
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
                network_diagnostics=_normalize_diagnostics_list(server.get("network_diagnostics")),
                iframe_diagnostics=_normalize_diagnostics_list(server.get("iframe_diagnostics")),
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
                    )
                )
    return streams
