"""Hosting Page Agent."""

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
from src.utils.instrumentation import observability_span, set_span_output, using_observability_context
from src.utils.observability import RunObserver

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/hosting_page_v1.md")
_AGENT_CONTRACT = """\
- extract verified stream URLs from the hosting page when possible
- if the host page clearly hands off to an embedded player, return that embedded URL instead of guessing streams
- respect the base policy's final JSON/output contract
- use site memory only as hints and re-check everything on the live page
"""


class HostingPageAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self.memory = LongTermMemory(settings.memory_db_path) if settings.memory_enabled else None
        self._system_prompt = (
            PROMPT_PATH.read_text(encoding="utf-8")
            if PROMPT_PATH.exists()
            else "Extract all stream URLs from this hosting page."
        )

    async def run(self, url: str, observer: RunObserver | None = None) -> ExtractionResult:
        logger.info("HostingPageAgent: %s", url)
        if observer is not None:
            observer.mark_agent(AgentType.HOSTING_PAGE)
            observer.emit("agent_started", f"Hosting page agent started for {url}")

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
                short_memory = ShortTermMemory(k=self.settings.memory_short_window)
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
                    ),
                    memory_context=memory_context,
                    working_state=short_memory.working_state(
                        objective="Extract streams from the hosting page or find the embedded handoff.",
                        page_url=url,
                        page_type=AgentType.HOSTING_PAGE.value,
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
                async with agent_tools("hosting", self.settings, observer=observer) as tools:
                    result = await run_agent_loop(
                        settings=self.settings,
                        llm=self.llm,
                        tools=tools,
                        system_prompt=compiled_prompt.content,
                        initial_message=f"Extract all stream URLs from this hosting page.\n\nmainUrl: {url}",
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
                        ),
                        bootstrap_url=url,
                        bootstrap_context_first=True,
                    )

                output = result.parse_json()
                streams = _collect_streams(output)
                decision = output.get("decision", "")

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
                    screenshots=[s["screenshot_url"] for s in output.get("servers", []) if s.get("screenshot_url")],
                    embedded_urls=[s["embedded_url"] for s in output.get("servers", []) if s.get("embedded_url")],
                    agent_type=AgentType.HOSTING_PAGE,
                    tool_calls_used=result.tool_calls_made,
                    metadata=output,
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
                    payload=output,
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


def _collect_streams(output: dict) -> list[StreamURL]:
    seen: set[str] = set()
    streams: list[StreamURL] = []
    for entry in output.get("streaming_urls", []):
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
