"""Landing Page Agent."""

from __future__ import annotations

from pathlib import Path

from src.agents.base import build_llm, run_agent_loop
from src.agents.memory import build_memory_context, remember_agent_run
from src.agents.prompting import build_runtime_context, build_task_brief, compile_agent_prompt
from src.memory.long_term import LongTermMemory
from src.memory.short_term import ShortTermMemory
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult
from src.tools.mcp_client import agent_tools
from src.utils.config import Settings
from src.utils.logging import get_logger
from src.utils.instrumentation import observability_span, set_span_output, using_observability_context
from src.utils.observability import RunObserver

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/landing_page_v1.md")
_AGENT_CONTRACT = """\
- find and return hosting page URLs from the landing page
- use navigation and page-inspection tools as needed, but stay within budget
- respect the final JSON/output format defined in the base policy
- do not fabricate hosting links; only return verified live-page findings
"""


class LandingPageAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self.memory = LongTermMemory(settings.memory_db_path) if settings.memory_enabled else None
        self._system_prompt = (
            PROMPT_PATH.read_text(encoding="utf-8")
            if PROMPT_PATH.exists()
            else "Explore the landing page and find all hosting page URLs."
        )

    async def run(
        self,
        url: str,
        observer: RunObserver | None = None,
        orchestrator_handoff: str = "",
    ) -> ExtractionResult:
        logger.info("LandingPageAgent: %s", url)
        if observer is not None:
            observer.mark_agent(AgentType.LANDING_PAGE)
            observer.emit("agent_started", f"Landing page agent started for {url}")
            if orchestrator_handoff.strip():
                observer.emit(
                    "orchestrator_handoff_received",
                    "Landing agent received orchestrator guidance",
                    details={"handoff_preview": orchestrator_handoff[:800]},
                )

        with using_observability_context(
            session_id=observer.run_id if observer is not None else "",
            metadata={"agent_type": AgentType.LANDING_PAGE.value, "url": url},
            tags=["landing", "agent"],
        ):
            with observability_span(
                "landing_page_agent.run",
                kind="agent",
                input_value={"url": url},
                attributes={"owc.agent_type": AgentType.LANDING_PAGE.value},
            ) as span:
                short_memory = ShortTermMemory(
                    k=self.settings.memory_short_window,
                    page_type=AgentType.LANDING_PAGE.value,
                )
                memory_context = build_memory_context(
                    self.memory,
                    url=url,
                    page_type=AgentType.LANDING_PAGE.value,
                    prompt_limit=self.settings.memory_prompt_limit,
                    observer=observer,
                )
                compiled_prompt = compile_agent_prompt(
                    settings=self.settings,
                    agent_id=AgentType.LANDING_PAGE.value,
                    base_policy=self._system_prompt,
                    agent_contract=_AGENT_CONTRACT,
                    task_brief=build_task_brief(
                        url=url,
                        page_type=AgentType.LANDING_PAGE.value,
                        run_goal="Explore the landing page and identify hosting-page URLs that should be passed downstream.",
                        extras={
                            "orchestrator_handoff": orchestrator_handoff[:600] if orchestrator_handoff else "",
                        },
                    ),
                    memory_context=memory_context,
                    working_state=short_memory.working_state(
                        objective="Find hosting page URLs on the landing page.",
                        page_url=url,
                        page_type=AgentType.LANDING_PAGE.value,
                    ),
                    runtime_context=build_runtime_context(
                        tool_profile="landing",
                        max_tool_calls=self.settings.landing_page_max_tool_calls,
                    ),
                )
                if observer is not None:
                    observer.emit(
                        "prompt_compiled",
                        "Compiled layered prompt for landing page agent",
                        details=compiled_prompt.model_dump(exclude={"content"}),
                    )
                initial_message = f"Explore this landing page and find all hosting page URLs.\n\nmainUrl: {url}"
                if orchestrator_handoff.strip():
                    initial_message += (
                        "\n\nORCHESTRATOR HANDOFF\n"
                        f"{orchestrator_handoff}\n"
                        "Use this context as guidance and verify all findings with live tool evidence."
                    )
                async with agent_tools("landing", self.settings, observer=observer) as tools:
                    result = await run_agent_loop(
                        settings=self.settings,
                        llm=self.llm,
                        tools=tools,
                        system_prompt=compiled_prompt.content,
                        initial_message=initial_message,
                        max_tool_calls=self.settings.landing_page_max_tool_calls,
                        budget_exhausted_message="Budget exhausted. Output your final JSON now.",
                        observer=observer,
                        run_name="landing_page_agent",
                        working_memory=short_memory,
                        prompt_metadata=compiled_prompt.model_dump(exclude={"content"}),
                        turn_context_provider=lambda _state: short_memory.working_state(
                            objective="Find hosting page URLs on the landing page.",
                            page_url=url,
                            page_type=AgentType.LANDING_PAGE.value,
                        ),
                        bootstrap_url=url,
                        bootstrap_context_first=True,
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
                set_span_output(
                    span,
                    {
                        "hosting_pages_found": len(hosting_pages),
                        "status": extraction.status.value,
                        "tool_calls_used": result.tool_calls_made,
                    },
                )
                remember_agent_run(
                    self.memory,
                    url=url,
                    page_type=AgentType.LANDING_PAGE.value,
                    status=extraction.status.value,
                    payload=output_json,
                    observer=observer,
                    short_memory=short_memory,
                )

        if observer is not None:
            observer.emit(
                "agent_finished",
                f"Landing page agent found {len(hosting_pages)} hosting pages",
                status="success" if hosting_pages else "warning",
                details={"hosting_pages_found": len(hosting_pages)},
            )
        return extraction
