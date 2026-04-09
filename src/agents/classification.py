"""Classification Agent - single-purpose page type classifier."""

from __future__ import annotations

import json
import re
from pathlib import Path

from src.agents.base import build_llm, run_agent_loop
from src.agents.memory import build_memory_context, remember_agent_run
from src.agents.prompting import build_runtime_context, build_task_brief, compile_agent_prompt
from src.memory.long_term import LongTermMemory
from src.memory.short_term import ShortTermMemory
from src.models.enums import AgentType, Confidence, PageType
from src.models.schemas import ClassificationResult
from src.tools.mcp_client import agent_tools
from src.utils.config import Settings
from src.utils.logging import get_logger
from src.utils.instrumentation import observability_span, set_span_output, using_observability_context
from src.utils.observability import RunObserver

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/classification_v1.md")
_AGENT_CONTRACT = """\
- classify the page as exactly one of: `landing_page`, `host_page`, `embed_video_page`, or `other`
- use live page evidence and tool results before deciding
- respect the output format defined in the base policy
- do not attempt downstream extraction in this step
"""


class ClassificationAgent:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.llm = build_llm(settings)
        self.memory = LongTermMemory(settings.memory_db_path) if settings.memory_enabled else None
        self._system_prompt = (
            PROMPT_PATH.read_text(encoding="utf-8")
            if PROMPT_PATH.exists()
            else _DEFAULT_PROMPT
        )

    async def run(self, url: str, observer: RunObserver | None = None) -> ClassificationResult:
        logger.info("ClassificationAgent: %s", url)
        if observer is not None:
            observer.mark_agent(AgentType.CLASSIFICATION)
            observer.emit("agent_started", f"Classification agent started for {url}")

        with using_observability_context(
            session_id=observer.run_id if observer is not None else "",
            metadata={"agent_type": AgentType.CLASSIFICATION.value, "url": url},
            tags=["classification", "agent"],
        ):
            with observability_span(
                "classification_agent.run",
                kind="agent",
                input_value={"url": url},
                attributes={"owc.agent_type": AgentType.CLASSIFICATION.value},
            ) as span:
                short_memory = ShortTermMemory(k=self.settings.memory_short_window)
                memory_context = build_memory_context(
                    self.memory,
                    url=url,
                    page_type=AgentType.CLASSIFICATION.value,
                    prompt_limit=self.settings.memory_prompt_limit,
                    observer=observer,
                )
                compiled_prompt = compile_agent_prompt(
                    settings=self.settings,
                    agent_id=AgentType.CLASSIFICATION.value,
                    base_policy=self._system_prompt,
                    agent_contract=_AGENT_CONTRACT,
                    task_brief=build_task_brief(
                        url=url,
                        page_type=AgentType.CLASSIFICATION.value,
                        run_goal="Classify the page type from live evidence before any extraction agents are chosen.",
                    ),
                    memory_context=memory_context,
                    working_state=short_memory.working_state(
                        objective="Classify the current page using live evidence.",
                        page_url=url,
                        page_type=AgentType.CLASSIFICATION.value,
                    ),
                    runtime_context=build_runtime_context(
                        tool_profile="classification",
                        max_tool_calls=self.settings.classification_max_tool_calls,
                    ),
                )
                if observer is not None:
                    observer.emit(
                        "prompt_compiled",
                        "Compiled layered prompt for classification agent",
                        details=compiled_prompt.model_dump(exclude={"content"}),
                    )
                async with agent_tools("classification", self.settings, observer=observer) as tools:
                    result = await run_agent_loop(
                        settings=self.settings,
                        llm=self.llm,
                        tools=tools,
                        system_prompt=compiled_prompt.content,
                        initial_message=f"Classify this page: {url}",
                        max_tool_calls=self.settings.classification_max_tool_calls,
                        budget_exhausted_message="Output your classification now using the exact Output Format.",
                        observer=observer,
                        run_name="classification_agent",
                        working_memory=short_memory,
                        prompt_metadata=compiled_prompt.model_dump(exclude={"content"}),
                        turn_context_provider=lambda _state: short_memory.working_state(
                            objective="Classify the current page using live evidence.",
                            page_url=url,
                            page_type=AgentType.CLASSIFICATION.value,
                        ),
                        bootstrap_url=url,
                        bootstrap_context_first=True,
                    )
                parsed = _parse_output(result.final_text, url)
                remember_agent_run(
                    self.memory,
                    url=url,
                    page_type=AgentType.CLASSIFICATION.value,
                    status="success",
                    payload=parsed.model_dump(mode="json"),
                    observer=observer,
                    short_memory=short_memory,
                )
                set_span_output(
                    span,
                    {
                        "page_type": parsed.page_type.value,
                        "confidence": parsed.confidence.value,
                        "tool_calls_used": result.tool_calls_made,
                    },
                )

        logger.info("-> %s (%s)", parsed.page_type, parsed.confidence)
        if observer is not None:
            observer.emit(
                "agent_finished",
                f"Classification decided {parsed.page_type}",
                status="success",
                details={
                    "page_type": parsed.page_type.value,
                    "confidence": parsed.confidence.value,
                    "tool_calls_used": result.tool_calls_made,
                },
            )
        return parsed


_PAGE_TYPE_MAP = {
    "landing_page": PageType.LANDING,
    "host_page": PageType.HOSTING,
    "hosting_page": PageType.HOSTING,
    "embed_video_page": PageType.EMBEDDED,
    "embedded_page": PageType.EMBEDDED,
    "other": PageType.UNKNOWN,
    "unknown": PageType.UNKNOWN,
}
_CONF_MAP = {"high": Confidence.HIGH, "medium": Confidence.MEDIUM, "low": Confidence.LOW}


def _parse_output(text: str, url: str) -> ClassificationResult:
    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            return ClassificationResult(
                url=url,
                page_type=_PAGE_TYPE_MAP.get(str(payload.get("page_type", "")).lower(), PageType.UNKNOWN),
                confidence=_CONF_MAP.get(str(payload.get("confidence", "")).lower(), Confidence.LOW),
                reasoning=str(payload.get("reasoning", "") or text[:500]),
            )
    except json.JSONDecodeError:
        pass

    page_type = PageType.UNKNOWN
    confidence = Confidence.LOW
    reasoning = ""

    meta = re.search(r"METADATA:\s*\npage_type:\s*(\S+)\s*\nconfidence:\s*(\S+)", text, re.I)
    if meta:
        page_type = _PAGE_TYPE_MAP.get(meta.group(1).lower(), PageType.UNKNOWN)
        confidence = _CONF_MAP.get(meta.group(2).lower(), Confidence.LOW)
    else:
        page_type_match = re.search(r"CLASSIFICATION:\s*(\S+)", text, re.I)
        if page_type_match:
            page_type = _PAGE_TYPE_MAP.get(page_type_match.group(1).lower(), PageType.UNKNOWN)
        confidence_match = re.search(r"CONFIDENCE:\s*(\S+)", text, re.I)
        if confidence_match:
            confidence = _CONF_MAP.get(confidence_match.group(1).lower(), Confidence.LOW)

    reasoning_match = re.search(r"REASONING:\s*\n(.*?)(?:\n[A-Z_]+:|$)", text, re.DOTALL | re.I)
    if reasoning_match:
        reasoning = reasoning_match.group(1).strip()

    return ClassificationResult(
        url=url,
        page_type=page_type,
        confidence=confidence,
        reasoning=reasoning or text[:500],
    )


_DEFAULT_PROMPT = """\
You are a web page classifier for illegal streaming sites.
Call inspect first to gather page signals. Use interact when needed to reveal hidden evidence.

Output format:
CLASSIFICATION: [landing_page/host_page/embed_video_page/other]
CONFIDENCE: [high/medium/low]
EVIDENCE:
- signal 1
REASONING:
Why this type fits.
METADATA:
page_type: [landing_page/host_page/embed_video_page/other]
confidence: [high/medium/low]
tools_used: [list]
"""
