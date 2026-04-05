"""Classification Agent: LangChain chain + optional bind_tools for low-confidence pages."""

from __future__ import annotations

from pathlib import Path

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import ChatPromptTemplate

from src.agents.base import build_llm
from src.models.schemas import ClassificationResult
from src.models.enums import Confidence, PageType
from src.tools.bridge import JSToolBridge
from src.tools.inspect_tool import InspectTool
from src.tools.screenshot_tool import ScreenshotTool
from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/classification_v1.md")


class ClassificationAgent:
    """Single-shot LLM classification with optional tool calls for low-confidence pages."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self.bridge = JSToolBridge(
            browser_ws_endpoint=settings.browser_ws_endpoint,
            timeout=settings.tool_timeout_seconds,
        )
        self.inspect_tool = InspectTool(bridge=self.bridge)
        self.screenshot_tool = ScreenshotTool(bridge=self.bridge)
        self._system_prompt = PROMPT_PATH.read_text(encoding="utf-8") if PROMPT_PATH.exists() else ""

    def run(self, url: str, html_snippet: str = "", screenshot_url: str = "") -> ClassificationResult:
        """Classify the page type for the given URL."""
        logger.info("Classifying URL: %s", url)

        content_parts: list = [{"type": "text", "text": f"URL: {url}\n\n{html_snippet}"}]
        if screenshot_url:
            content_parts.append({"type": "image_url", "image_url": {"url": screenshot_url}})

        messages = [
            SystemMessage(content=self._system_prompt or "Classify the streaming page type."),
            HumanMessage(content=content_parts),
        ]

        llm_with_tools = self.llm.bind_tools(
            [self.inspect_tool, self.screenshot_tool],
            tool_choice="auto",
        )

        response = llm_with_tools.invoke(messages)
        logger.debug("Classification response: %s", response.content)

        # Parse structured output from response
        try:
            parser = JsonOutputParser(pydantic_object=ClassificationResult)
            result = parser.parse(response.content)
        except Exception:
            # Fallback: best-effort parse
            result = ClassificationResult(
                url=url,
                page_type=PageType.UNKNOWN,
                confidence=Confidence.LOW,
                reasoning=str(response.content),
            )

        logger.info("Classified as %s (confidence: %s)", result.page_type, result.confidence)
        return result
