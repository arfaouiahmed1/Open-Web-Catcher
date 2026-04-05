"""Embedded Page Agent.

MCP profile: 'embedded'
Tools visible: inspect, interact, harvest, screenshot, navigate

Extracts streams from third-party embedded video players. Specialises in
iframe traversal and coordinate-based clicking when CSS selectors fail
due to cross-origin iframe sandboxing.
"""

from __future__ import annotations

from pathlib import Path

from src.agents.base import build_llm, run_agent_loop
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult, StreamURL
from src.tools.mcp_client import agent_tools
from src.utils.config import Settings
from src.utils.logging import get_logger
from src.utils.observability import RunObserver

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/embedded_page_v1.md")


class EmbeddedPageAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
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
        async with agent_tools("embedded", self.settings) as tools:
            result = await run_agent_loop(
                llm=self.llm,
                tools=tools,
                system_prompt=self._system_prompt,
                initial_message=(
                    f"Extract all stream URLs from this embedded video player page.\n\n"
                    f"mainUrl: {url}\n"
                    f"Embedded_url: {url}"
                ),
                max_tool_calls=self.settings.embedded_page_max_tool_calls,
                budget_exhausted_message="Budget exhausted. Output your final JSON now.",
                observer=observer,
                run_name="embedded_page_agent",
            )

        output = result.parse_json()
        streams = _collect_streams(output)

        successful = output.get("successful_servers", 0)
        status = (
            ExtractionStatus.SUCCESS if streams else
            ExtractionStatus.PARTIAL if successful else
            ExtractionStatus.FAILED
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
            streams.append(StreamURL(url=url, protocol=entry.get("type", ""), source_layer=entry.get("source", "")))
    for server in output.get("servers", []):
        for url in server.get("m3u8_urls", []) + server.get("mpd_urls", []) + server.get("mp4_urls", []):
            if url and url not in seen:
                seen.add(url)
                streams.append(StreamURL(url=url, source_layer=server.get("label", "")))
    return streams
