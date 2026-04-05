"""Landing Page Agent: ReAct loop to explore and discover hosting page links."""

from __future__ import annotations

from pathlib import Path

from langchain.agents import AgentExecutor, create_react_agent
from langchain_core.prompts import PromptTemplate

from src.agents.base import build_llm
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult
from src.tools.bridge import JSToolBridge
from src.tools.inspect_tool import InspectTool
from src.tools.interact_tool import InteractTool
from src.tools.navigate_tool import NavigateTool
from src.tools.screenshot_tool import ScreenshotTool
from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/landing_page_v1.md")


class LandingPageAgent:
    """ReAct agent for landing pages. Explores, clicks, and discovers hosting page URLs.

    Tools available: inspect, interact, navigate, screenshot (no harvest).
    Budget: 50 tool calls.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self.bridge = JSToolBridge(
            browser_ws_endpoint=settings.browser_ws_endpoint,
            timeout=settings.tool_timeout_seconds,
        )
        self.tools = [
            InspectTool(bridge=self.bridge),
            InteractTool(bridge=self.bridge),
            NavigateTool(bridge=self.bridge),
            ScreenshotTool(bridge=self.bridge),
        ]
        prompt_text = PROMPT_PATH.read_text(encoding="utf-8") if PROMPT_PATH.exists() else _DEFAULT_PROMPT
        self.prompt = PromptTemplate.from_template(prompt_text)
        self.max_iterations = settings.landing_page_max_tool_calls

    def run(self, url: str) -> ExtractionResult:
        logger.info("LandingPageAgent starting on: %s", url)
        agent = create_react_agent(self.llm, self.tools, self.prompt)
        executor = AgentExecutor(
            agent=agent,
            tools=self.tools,
            max_iterations=self.max_iterations,
            verbose=True,
            handle_parsing_errors=True,
        )
        try:
            output = executor.invoke({"input": url, "url": url})
            return ExtractionResult(
                url=url,
                page_type=PageType.LANDING,
                status=ExtractionStatus.SUCCESS,
                agent_type=AgentType.LANDING_PAGE,
                metadata={"agent_output": output.get("output", "")},
            )
        except Exception as e:
            logger.exception("LandingPageAgent failed: %s", e)
            return ExtractionResult(
                url=url,
                page_type=PageType.LANDING,
                status=ExtractionStatus.FAILED,
                agent_type=AgentType.LANDING_PAGE,
                error_message=str(e),
            )


_DEFAULT_PROMPT = """\
You are the Landing Page Agent. Your goal is to explore this streaming site landing page
and find the URL(s) of the actual video hosting pages.

URL: {url}

You have access to the following tools:
{tools}

Use the following format:
Thought: what you need to do
Action: the action to take, should be one of [{tool_names}]
Action Input: the input to the action
Observation: the result of the action
... (repeat Thought/Action/Action Input/Observation as needed)
Thought: I now have the hosting page URL(s)
Final Answer: the hosting page URL(s) found

Begin!
{agent_scratchpad}
"""
