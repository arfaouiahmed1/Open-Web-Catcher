"""Hosting Page Agent.

MCP profile: 'hosting'
Tools visible: inspect, interact, harvest, screenshot, navigate

Extracts m3u8/mpd/mp4 streams from a hosting page, cycling all servers.
"""

from __future__ import annotations

from pathlib import Path

from src.agents.base import build_llm, run_agent_loop
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult, StreamURL
from src.tools.mcp_client import agent_tools
from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/hosting_page_v1.md")


class HostingPageAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self._system_prompt = (
            PROMPT_PATH.read_text(encoding="utf-8")
            if PROMPT_PATH.exists()
            else "Extract all stream URLs from this hosting page."
        )

    async def run(self, url: str) -> ExtractionResult:
        logger.info("HostingPageAgent: %s", url)
        async with agent_tools("hosting", self.settings) as tools:
            result = await run_agent_loop(
                llm=self.llm,
                tools=tools,
                system_prompt=self._system_prompt,
                initial_message=f"Extract all stream URLs from this hosting page.\n\nmainUrl: {url}",
                max_tool_calls=self.settings.hosting_page_max_tool_calls,
                budget_exhausted_message="Budget exhausted. Output your final JSON now.",
            )

        output = result.parse_json()
        streams = _collect_streams(output)
        decision = output.get("decision", "")

        status = (
            ExtractionStatus.SUCCESS if streams else
            ExtractionStatus.PARTIAL if decision in ("needs_embed_agent", "partial_success_needs_embed") else
            ExtractionStatus.FAILED
        )

        return ExtractionResult(
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


def _collect_streams(output: dict) -> list[StreamURL]:
    seen: set[str] = set()
    streams: list[StreamURL] = []
    for entry in output.get("streaming_urls", []):
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
