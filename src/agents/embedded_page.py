"""Embedded Page Agent."""

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
from src.utils.logging import get_logger
from src.utils.instrumentation import observability_span, set_span_output, using_observability_context
from src.utils.observability import RunObserver

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/embedded_page_v1.md")
_AGENT_CONTRACT = """\
- work inside the embedded player context and extract verified stream URLs
- check server switches, player activation, and network evidence before concluding
- respect the final JSON/output format from the base policy
- use remembered site hints only as soft guidance
"""


class EmbeddedPageAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self.memory = LongTermMemory(settings.memory_db_path) if settings.memory_enabled else None
        self._system_prompt = (
            PROMPT_PATH.read_text(encoding="utf-8")
            if PROMPT_PATH.exists()
            else "Extract all stream URLs from this embedded video player page."
        )

    async def run(
        self,
        url: str,
        observer: RunObserver | None = None,
        orchestrator_handoff: str = "",
    ) -> ExtractionResult:
        logger.info("EmbeddedPageAgent: %s", url)
        if observer is not None:
            observer.mark_agent(AgentType.EMBEDDED_PAGE)
            observer.emit("agent_started", f"Embedded page agent started for {url}")
            if orchestrator_handoff.strip():
                observer.emit(
                    "orchestrator_handoff_received",
                    "Embedded agent received orchestrator guidance",
                    details={"handoff_preview": orchestrator_handoff[:800]},
                )

        with using_observability_context(
            session_id=observer.run_id if observer is not None else "",
            metadata={"agent_type": AgentType.EMBEDDED_PAGE.value, "url": url},
            tags=["embedded", "agent"],
        ):
            with observability_span(
                "embedded_page_agent.run",
                kind="agent",
                input_value={"url": url},
                attributes={"owc.agent_type": AgentType.EMBEDDED_PAGE.value},
            ) as span:
                short_memory = ShortTermMemory(
                    k=self.settings.memory_short_window,
                    page_type=AgentType.EMBEDDED_PAGE.value,
                )
                memory_context = build_memory_context(
                    self.memory,
                    url=url,
                    page_type=AgentType.EMBEDDED_PAGE.value,
                    prompt_limit=self.settings.memory_prompt_limit,
                    observer=observer,
                )
                compiled_prompt = compile_agent_prompt(
                    settings=self.settings,
                    agent_id=AgentType.EMBEDDED_PAGE.value,
                    base_policy=self._system_prompt,
                    agent_contract=_AGENT_CONTRACT,
                    task_brief=build_task_brief(
                        url=url,
                        page_type=AgentType.EMBEDDED_PAGE.value,
                        run_goal="Work inside the embedded player and recover stream URLs from live player activity.",
                        extras={
                            "orchestrator_handoff": orchestrator_handoff[:600] if orchestrator_handoff else "",
                        },
                    ),
                    memory_context=memory_context,
                    working_state=short_memory.working_state(
                        objective="Extract streams from the embedded player.",
                        page_url=url,
                        page_type=AgentType.EMBEDDED_PAGE.value,
                    ),
                    runtime_context=build_runtime_context(
                        tool_profile="embedded",
                        max_tool_calls=self.settings.embedded_page_max_tool_calls,
                    ),
                )
                if observer is not None:
                    observer.emit(
                        "prompt_compiled",
                        "Compiled layered prompt for embedded page agent",
                        details=compiled_prompt.model_dump(exclude={"content"}),
                    )
                initial_message = (
                    f"Extract all stream URLs from this embedded video player page.\n\n"
                    f"mainUrl: {url}\n"
                    f"Embedded_url: {url}"
                )
                if orchestrator_handoff.strip():
                    initial_message += (
                        "\n\nORCHESTRATOR HANDOFF\n"
                        f"{orchestrator_handoff}\n"
                        "Use this context as guidance and verify findings from live page evidence."
                    )
                async with agent_tools("embedded", self.settings, observer=observer) as tools:
                    result = await run_agent_loop(
                        settings=self.settings,
                        llm=self.llm,
                        tools=tools,
                        system_prompt=compiled_prompt.content,
                        initial_message=initial_message,
                        max_tool_calls=self.settings.embedded_page_max_tool_calls,
                        budget_exhausted_message="Budget exhausted. Output your final JSON now.",
                        observer=observer,
                        run_name="embedded_page_agent",
                        working_memory=short_memory,
                        prompt_metadata=compiled_prompt.model_dump(exclude={"content"}),
                        turn_context_provider=lambda _state: short_memory.working_state(
                            objective="Extract streams from the embedded player.",
                            page_url=url,
                            page_type=AgentType.EMBEDDED_PAGE.value,
                        ),
                        bootstrap_url=url,
                        bootstrap_context_first=True,
                    )

                output = result.parse_json()
                normalized_output = _normalize_embedded_output(output)
                streams = _collect_streams(normalized_output)
                servers = _build_server_results(normalized_output.get("servers", []))
                screenshots = [server.screenshot_url for server in servers if server.screenshot_url]
                embedded_urls = [server.embedded_url for server in servers if server.embedded_url]

                successful = int(normalized_output.get("successful_servers", 0) or 0)
                status = (
                    ExtractionStatus.SUCCESS
                    if streams
                    else ExtractionStatus.PARTIAL
                    if successful
                    else ExtractionStatus.FAILED
                )

                extraction = ExtractionResult(
                    url=url,
                    page_type=PageType.EMBEDDED,
                    status=status,
                    streams=streams,
                    screenshots=screenshots,
                    embedded_urls=embedded_urls,
                    servers=servers,
                    agent_type=AgentType.EMBEDDED_PAGE,
                    tool_calls_used=result.tool_calls_made,
                    metadata=normalized_output,
                )
                set_span_output(
                    span,
                    {
                        "streams_found": len(streams),
                        "successful_servers": successful,
                        "status": extraction.status.value,
                    },
                )
                remember_agent_run(
                    self.memory,
                    url=url,
                    page_type=AgentType.EMBEDDED_PAGE.value,
                    status=extraction.status.value,
                    payload=normalized_output,
                    observer=observer,
                    short_memory=short_memory,
                )

        if observer is not None:
            observer.emit(
                "agent_finished",
                f"Embedded page agent finished with {len(streams)} streams",
                status="success" if streams else "warning",
                details={"streams_found": len(streams), "successful_servers": successful},
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


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _normalize_server_entry(server: dict[str, Any], index: int) -> dict[str, Any]:
    label = str(server.get("label") or server.get("name") or f"server_{index + 1}").strip() or f"server_{index + 1}"
    m3u8_urls = _normalize_url_list(server.get("m3u8_urls"))
    mpd_urls = _normalize_url_list(server.get("mpd_urls"))
    mp4_urls = _normalize_url_list(server.get("mp4_urls"))
    for item in _normalize_url_list(server.get("stream_urls")):
        protocol = _protocol_from_url(item)
        if protocol == "hls":
            m3u8_urls = _dedupe_urls([*m3u8_urls, item])
        elif protocol == "dash":
            mpd_urls = _dedupe_urls([*mpd_urls, item])
        elif protocol == "mp4":
            mp4_urls = _dedupe_urls([*mp4_urls, item])

    primary_stream = str(server.get("primary_stream") or "").strip()
    if not primary_stream:
        for candidate in [*m3u8_urls, *mpd_urls, *mp4_urls]:
            if candidate:
                primary_stream = candidate
                break

    status = str(server.get("status") or "").strip().lower()
    if not status:
        status = "success" if (m3u8_urls or mpd_urls or mp4_urls) else "failed"

    server_up_value = server.get("server_up")
    server_up = bool(server_up_value) if isinstance(server_up_value, bool) else status in {"success", "partial", "active"}

    return {
        "label": label,
        "server_up": server_up,
        "screenshot_url": str(server.get("screenshot_url") or "").strip(),
        "embedded_url": str(server.get("embedded_url") or "").strip(),
        "m3u8_urls": m3u8_urls,
        "mpd_urls": mpd_urls,
        "mp4_urls": mp4_urls,
        "primary_stream": primary_stream,
        "status": status,
        "down_reason": str(server.get("down_reason") or "").strip(),
        "activation_attempts": _safe_int(server.get("activation_attempts"), 0),
        "player_state": str(server.get("player_state") or "").strip(),
        "extraction_method": str(server.get("extraction_method") or "").strip(),
    }


def _normalize_servers(output: dict[str, Any]) -> list[dict[str, Any]]:
    rows = output.get("servers", [])
    if not isinstance(rows, list):
        return []
    return [_normalize_server_entry(server, index) for index, server in enumerate(rows) if isinstance(server, dict)]


def _normalize_all_stream_urls(output: dict[str, Any], servers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    rows = output.get("all_stream_urls", [])
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
                "type": str(row.get("type") or row.get("protocol") or _protocol_from_url(url)).strip(),
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

    return merged


def _normalize_embedded_output(output: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(output or {})
    servers = _normalize_servers(normalized)
    normalized["servers"] = servers
    normalized["all_stream_urls"] = _normalize_all_stream_urls(normalized, servers)
    normalized["total_servers"] = int(normalized.get("total_servers") or len(servers))
    successful = sum(1 for server in servers if server.get("status") in {"success", "partial"} or server.get("server_up"))
    normalized["successful_servers"] = int(normalized.get("successful_servers") or successful)
    normalized["total_unique_streams"] = int(normalized.get("total_unique_streams") or len(normalized["all_stream_urls"]))
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
                primary_stream=str(server.get("primary_stream") or "") or None,
                screenshot_url=str(server.get("screenshot_url") or "") or None,
                embedded_url=str(server.get("embedded_url") or "") or None,
                status=str(server.get("status") or "failed"),
                down_reason=str(server.get("down_reason") or "") or None,
            )
        )
    return result


def _collect_streams(output: dict[str, Any]) -> list[StreamURL]:
    seen: set[str] = set()
    streams: list[StreamURL] = []
    for entry in output.get("all_stream_urls", []):
        url = str(entry.get("url") or "").strip()
        if url and url not in seen:
            seen.add(url)
            streams.append(
                StreamURL(
                    url=url,
                    protocol=str(entry.get("type") or entry.get("protocol") or _protocol_from_url(url)),
                    source_layer=str(entry.get("source") or ""),
                )
            )
    for server in output.get("servers", []):
        for url in server.get("m3u8_urls", []) + server.get("mpd_urls", []) + server.get("mp4_urls", []):
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
