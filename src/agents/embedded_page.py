"""Embedded Page Agent."""

from __future__ import annotations

from pathlib import Path

from src.agents.base import build_llm, run_agent_loop
from src.agents.memory import build_memory_context, remember_agent_run
from src.agents.prompting import build_runtime_context, build_task_brief, compile_agent_prompt
from src.memory.long_term import LongTermMemory
from src.memory.short_term import ShortTermMemory
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult, StreamURL
from src.tools.mcp_client import agent_tools
from src.utils.config import Settings
from src.utils.logging import get_logger
from src.utils.observability import RunObserver
from src.utils.phoenix import phoenix_span, set_span_output, using_phoenix_attributes

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

    async def run(self, url: str, observer: RunObserver | None = None) -> ExtractionResult:
        logger.info("EmbeddedPageAgent: %s", url)
        if observer is not None:
            observer.mark_agent(AgentType.EMBEDDED_PAGE)
            observer.emit("agent_started", f"Embedded page agent started for {url}")

        with using_phoenix_attributes(
            session_id=observer.run_id if observer is not None else "",
            metadata={"agent_type": AgentType.EMBEDDED_PAGE.value, "url": url},
            tags=["embedded", "agent"],
        ):
            with phoenix_span(
                "embedded_page_agent.run",
                kind="agent",
                input_value={"url": url},
                attributes={"owc.agent_type": AgentType.EMBEDDED_PAGE.value},
            ) as span:
                short_memory = ShortTermMemory(k=self.settings.memory_short_window)
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
                async with agent_tools("embedded", self.settings) as tools:
                    result = await run_agent_loop(
                        settings=self.settings,
                        llm=self.llm,
                        tools=tools,
                        system_prompt=compiled_prompt.content,
                        initial_message=(
                            f"Extract all stream URLs from this embedded video player page.\n\n"
                            f"mainUrl: {url}\n"
                            f"Embedded_url: {url}"
                        ),
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
                    )

                output = result.parse_json()
                streams = _collect_streams(output)

                successful = output.get("successful_servers", 0)
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
                    agent_type=AgentType.EMBEDDED_PAGE,
                    tool_calls_used=result.tool_calls_made,
                    metadata=output,
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
                    payload=output,
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


def _collect_streams(output: dict) -> list[StreamURL]:
    seen: set[str] = set()
    streams: list[StreamURL] = []
    for entry in output.get("all_stream_urls", []):
        url = entry.get("url", "")
        if url and url not in seen:
            seen.add(url)
            streams.append(
                StreamURL(url=url, protocol=entry.get("type", ""), source_layer=entry.get("source", ""))
            )
    for server in output.get("servers", []):
        for url in server.get("m3u8_urls", []) + server.get("mpd_urls", []) + server.get("mp4_urls", []):
            if url and url not in seen:
                seen.add(url)
                streams.append(StreamURL(url=url, source_layer=server.get("label", "")))
    return streams
