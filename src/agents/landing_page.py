"""Landing Page Agent.

MCP profile: 'landing'
Tools visible: inspect, navigate, interact, screenshot  (NO harvest)

Explores catalog pages and discovers hosting page URLs.
"""

from __future__ import annotations

from pathlib import Path

from src.agents.base import build_llm, run_agent_loop
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult
from src.tools.mcp_client import agent_tools
from src.utils.config import Settings
from src.utils.logging import get_logger
from src.utils.observability import RunObserver

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/landing_page_v1.md")


class LandingPageAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self._system_prompt = (
            PROMPT_PATH.read_text(encoding="utf-8")
            if PROMPT_PATH.exists()
            else "Explore the landing page and find all hosting page URLs."
        )

    async def run(self, url: str, observer: RunObserver | None = None) -> ExtractionResult:
        logger.info("LandingPageAgent: %s", url)
        if observer is not None:
            observer.mark_agent(AgentType.LANDING_PAGE)
            observer.emit("agent_started", f"Landing page agent started for {url}")
        async with agent_tools("landing", self.settings) as tools:
            result = await run_agent_loop(
                llm=self.llm,
                tools=tools,
                system_prompt=self._system_prompt,
                initial_message=f"Explore this landing page and find all hosting page URLs.\n\nmainUrl: {url}",
                max_tool_calls=self.settings.landing_page_max_tool_calls,
                budget_exhausted_message="Budget exhausted. Output your final JSON now.",
                observer=observer,
                run_name="landing_page_agent",
            )

        output_json = result.parse_json()
        hosting_pages = output_json.get("hosting_pages", [])

        extraction = ExtractionResult(
            url=url,
            page_type=PageType.LANDING,
            status=ExtractionStatus.SUCCESS if hosting_pages else ExtractionStatus.FAILED,
            agent_type=AgentType.LANDING_PAGE,
            tool_calls_used=result.tool_calls_made,
            metadata=output_json,
        )
        if observer is not None:
            observer.emit(
                "agent_finished",
                f"Landing page agent found {len(hosting_pages)} hosting pages",
                status="success" if hosting_pages else "warning",
                details={"hosting_pages_found": len(hosting_pages)},
            )
        return extraction
