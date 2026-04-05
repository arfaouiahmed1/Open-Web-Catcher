"""Hosting Page Agent: ReAct loop to extract stream URLs from a known hosting page."""

from __future__ import annotations

from pathlib import Path

from langchain.agents import AgentExecutor, create_react_agent
from langchain_core.prompts import PromptTemplate

from src.agents.base import build_llm
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult, StreamURL
from src.tools.bridge import JSToolBridge
from src.tools.harvest_tool import HarvestTool
from src.tools.inspect_tool import InspectTool
from src.tools.interact_tool import InteractTool
from src.tools.navigate_tool import NavigateTool
from src.tools.screenshot_tool import ScreenshotTool
from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/hosting_page_v1.md")


class HostingPageAgent:
    """ReAct agent for hosting pages. Uses OBSERVE→STATE→PLAN reasoning.

    Tools: inspect, interact, navigate, screenshot, harvest.
    Budget: 20 tool calls.
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
            HarvestTool(bridge=self.bridge),
        ]
        prompt_text = PROMPT_PATH.read_text(encoding="utf-8") if PROMPT_PATH.exists() else _DEFAULT_PROMPT
        self.prompt = PromptTemplate.from_template(prompt_text)
        self.max_iterations = settings.hosting_page_max_tool_calls

    def run(self, url: str) -> ExtractionResult:
        logger.info("HostingPageAgent starting on: %s", url)
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
            raw_streams = output.get("streams", [])
            streams = [StreamURL(**s) if isinstance(s, dict) else s for s in raw_streams]
            status = ExtractionStatus.SUCCESS if streams else ExtractionStatus.FAILED
            return ExtractionResult(
                url=url,
                page_type=PageType.HOSTING,
                status=status,
                streams=streams,
                agent_type=AgentType.HOSTING_PAGE,
                metadata={"agent_output": output.get("output", "")},
            )
        except Exception as e:
            logger.exception("HostingPageAgent failed: %s", e)
            return ExtractionResult(
                url=url,
                page_type=PageType.HOSTING,
                status=ExtractionStatus.FAILED,
                agent_type=AgentType.HOSTING_PAGE,
                error_message=str(e),
            )


_DEFAULT_PROMPT = """\
You are the Hosting Page Agent. Your goal is to extract streaming URLs from this video hosting page.
Use OBSERVE→STATE→PLAN reasoning at each step.

URL: {url}

You have access to the following tools:
{tools}

Use the following format:
Thought: OBSERVE what is on the page, STATE the current extraction status, PLAN the next action
Action: the action to take, should be one of [{tool_names}]
Action Input: the input to the action
Observation: the result of the action
... (repeat as needed, budget: 20 calls)
Thought: I have extracted the stream URLs
Final Answer: list of stream URLs found

Begin!
{agent_scratchpad}
"""
