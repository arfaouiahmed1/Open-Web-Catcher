"""Orchestrator Agent — LLM-driven pipeline coordinator.

Model: gemini-2.5-flash-lite (cheap, fast — only routes and coordinates)
Sub-agents use: gemini-2.5-flash (strong reasoning + vision)

The orchestrator treats every sub-agent AND analysis step as a tool.
It decides the order of calls, handles failures, and produces the final result.

Full tool set:
    classify_page           → ClassificationAgent
    run_landing_agent       → LandingPageAgent
    run_hosting_agent       → HostingPageAgent     (called N times, once per match URL)
    run_embedded_agent      → EmbeddedPageAgent    (called when hosting fails)
    analyze_providers       → IPInfoTool           (called once, after all extractions)
    generate_takedown_emails → EmailTool           (called once, after analyze_providers)

Always follows this order:
    classify → [landing →] hosting(s) → [embedded(s)] → analyze → emails
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from pydantic import Field

from src.agents.base import build_llm, run_agent_loop
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import (
    ClassificationResult,
    ExtractionResult,
    MatchInfo,
    PipelineResult,
    ProviderInfo,
    StreamURL,
    TakedownEmail,
)
from src.tools.email_tool import EmailTool
from src.tools.ipinfo_tool import IPInfoTool
from src.utils.config import Settings
from src.utils.logging import get_logger
from src.utils.observability import RunObserver, get_langsmith_status, run_registry

logger = get_logger(__name__)

PROMPT_PATH = Path("configs/prompts/orchestrator_v1.md")


# ── Agent-as-tool wrappers ────────────────────────────────────────────────────

class _ClassifyTool(BaseTool):
    name: str = "classify_page"
    description: str = (
        "Classify the page type of a URL. "
        "Returns page_type (landing_page / host_page / embed_video_page / other), "
        "confidence, and reasoning. Call this FIRST."
    )
    settings: Settings = Field(exclude=True)
    observer: RunObserver | None = Field(default=None, exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, url: str) -> str:
        raise NotImplementedError("Use async")

    async def _arun(self, url: str) -> str:
        from src.agents.classification import ClassificationAgent
        child = self.observer.child("classification", AgentType.CLASSIFICATION) if self.observer else None
        result = await ClassificationAgent(self.settings).run(url=url, observer=child)
        return result.model_dump_json()


class _LandingTool(BaseTool):
    name: str = "run_landing_agent"
    description: str = (
        "Run the Landing Page Agent on a landing/catalog page. "
        "Discovers all hosting page URLs (match/channel pages with players). "
        "Returns hosting_pages[] with url, title, participants, iframes, route. "
        "Call when classify_page returns 'landing_page'."
    )
    settings: Settings = Field(exclude=True)
    observer: RunObserver | None = Field(default=None, exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, url: str) -> str:
        raise NotImplementedError("Use async")

    async def _arun(self, url: str) -> str:
        from src.agents.landing_page import LandingPageAgent
        child = self.observer.child("landing", AgentType.LANDING_PAGE) if self.observer else None
        result = await LandingPageAgent(self.settings).run(url=url, observer=child)
        return result.model_dump_json()


class _HostingTool(BaseTool):
    name: str = "run_hosting_agent"
    description: str = (
        "Run the Hosting Page Agent on a single hosting page URL. "
        "Extracts m3u8/mpd/mp4 streams and screenshots per server. "
        "Call once per hosting URL. If a server fails, the result contains "
        "embedded_url — pass that to run_embedded_agent."
    )
    settings: Settings = Field(exclude=True)
    observer: RunObserver | None = Field(default=None, exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, url: str) -> str:
        raise NotImplementedError("Use async")

    async def _arun(self, url: str) -> str:
        from src.agents.hosting_page import HostingPageAgent
        child = self.observer.child("hosting", AgentType.HOSTING_PAGE) if self.observer else None
        result = await HostingPageAgent(self.settings).run(url=url, observer=child)
        return result.model_dump_json()


class _EmbeddedTool(BaseTool):
    name: str = "run_embedded_agent"
    description: str = (
        "Run the Embedded Page Agent on an embedded player URL (iframe src). "
        "Use when: (a) run_hosting_agent returns needs_embed_agent for a server, "
        "or (b) classify_page returns 'embed_video_page'. "
        "Returns m3u8/mpd/mp4 streams and screenshots."
    )
    settings: Settings = Field(exclude=True)
    observer: RunObserver | None = Field(default=None, exclude=True)

    class Config:
        arbitrary_types_allowed = True

    def _run(self, url: str) -> str:
        raise NotImplementedError("Use async")

    async def _arun(self, url: str) -> str:
        from src.agents.embedded_page import EmbeddedPageAgent
        child = self.observer.child("embedded", AgentType.EMBEDDED_PAGE) if self.observer else None
        result = await EmbeddedPageAgent(self.settings).run(url=url, observer=child)
        return result.model_dump_json()


# ── Orchestrator ──────────────────────────────────────────────────────────────

class OrchestratorAgent:
    """LLM orchestrator that coordinates the full extraction pipeline.

    Uses gemini-2.5-flash-lite for routing/coordination decisions.
    Sub-agents use gemini-2.5-flash for tool-calling loops + vision.
    """

    def __init__(self, settings: Settings, observer: RunObserver | None = None) -> None:
        self.settings = settings
        self.observer = observer
        self.llm = build_llm(settings, model_override=settings.orchestrator_model)
        self.tools: list[BaseTool] = [
            _ClassifyTool(settings=settings, observer=observer),
            _LandingTool(settings=settings, observer=observer),
            _HostingTool(settings=settings, observer=observer),
            _EmbeddedTool(settings=settings, observer=observer),
            IPInfoTool(ipinfo_token=settings.ipinfo_token),
            EmailTool(),
        ]
        self._system_prompt = (
            PROMPT_PATH.read_text(encoding="utf-8")
            if PROMPT_PATH.exists()
            else _DEFAULT_SYSTEM_PROMPT
        )

    async def run(self, url: str) -> PipelineResult:
        run_id = self.observer.run_id if self.observer is not None else str(uuid.uuid4())
        logger.info("Pipeline started: run_id=%s url=%s", run_id, url)
        if self.observer is not None:
            self.observer.set_url(url)
            self.observer.mark_agent(AgentType.ORCHESTRATOR)
            self.observer.emit("pipeline_started", f"Pipeline started for {url}")
        try:
            loop_result = await run_agent_loop(
                llm=self.llm,
                tools=self.tools,
                system_prompt=self._system_prompt,
                initial_message=f"Process this URL through the full extraction pipeline:\n\n{url}",
                max_tool_calls=self.settings.orchestrator_max_tool_calls,
                budget_exhausted_message=(
                    "Budget exhausted. If you haven't already, call analyze_providers "
                    "and generate_takedown_emails with what you have, then stop."
                ),
                observer=self.observer,
                run_name="orchestrator_agent",
            )

            result = _build_pipeline_result(
                run_id,
                url,
                loop_result.messages,
                metrics=self.observer.trace().metrics if self.observer else None,
            )
            if self.observer is not None:
                failure_mode = "" if result.final_status == ExtractionStatus.SUCCESS else result.final_status.value
                self.observer.emit(
                    "pipeline_finished",
                    f"Pipeline finished with status {result.final_status}",
                    status="success" if result.final_status == ExtractionStatus.SUCCESS else "warning",
                    details={
                        "streams_found": len(result.all_streams),
                        "emails_generated": len(result.takedown_emails),
                    },
                )
                self.observer.finish(
                    success=result.final_status == ExtractionStatus.SUCCESS,
                    failure_mode=failure_mode,
                )
                result.metrics = self.observer.trace().metrics
            logger.info(
                "Pipeline finished: run_id=%s status=%s streams=%d emails=%d",
                run_id, result.final_status, len(result.all_streams), len(result.takedown_emails),
            )
            return result
        except Exception as exc:
            if self.observer is not None:
                self.observer.emit("pipeline_failed", str(exc), status="error")
                self.observer.finish(success=False, failure_mode=type(exc).__name__)
            raise


# ── Public entry point ────────────────────────────────────────────────────────

async def run_pipeline(
    url: str,
    settings: Settings,
    observer: RunObserver | None = None,
) -> PipelineResult:
    if observer is None:
        observer = run_registry.create(
            run_id=str(uuid.uuid4()),
            root_actor="orchestrator",
            langsmith=get_langsmith_status(settings),
        )
    return await OrchestratorAgent(settings, observer=observer).run(url)


# ── Result builder ────────────────────────────────────────────────────────────

def _build_pipeline_result(
    run_id: str,
    url: str,
    messages: list,
    metrics: Any | None = None,
) -> PipelineResult:
    """Reconstruct a PipelineResult by replaying all ToolMessage outputs."""
    classification: ClassificationResult | None = None
    matches: list[MatchInfo] = []
    extraction_results: list[ExtractionResult] = []
    provider_analysis: list[ProviderInfo] = []
    takedown_emails: list[TakedownEmail] = []
    all_streams: list[StreamURL] = []
    all_screenshots: list[str] = []
    seen_stream_urls: set[str] = set()

    for msg in messages:
        if not isinstance(msg, ToolMessage):
            continue
        try:
            payload = json.loads(msg.content)
        except (json.JSONDecodeError, TypeError):
            continue

        if isinstance(payload, list):
            if payload and "stream_url" in payload[0]:
                for p in payload:
                    try:
                        provider_analysis.append(ProviderInfo(**p))
                    except Exception:
                        pass
            elif payload and "subject" in payload[0]:
                for e in payload:
                    try:
                        takedown_emails.append(TakedownEmail(**e))
                    except Exception:
                        pass
            continue

        if not isinstance(payload, dict):
            continue

        if "page_type" in payload and "confidence" in payload and "reasoning" in payload:
            try:
                classification = ClassificationResult(**payload)
            except Exception:
                pass

        elif "hosting_pages" in payload.get("metadata", {}):
            for hp in payload["metadata"].get("hosting_pages", []):
                try:
                    matches.append(MatchInfo(**{
                        k: hp[k] for k in MatchInfo.model_fields if k in hp
                    }))
                except Exception:
                    pass

        elif "servers" in payload.get("metadata", {}):
            _collect_extraction(
                payload=payload,
                extraction_results=extraction_results,
                all_streams=all_streams,
                all_screenshots=all_screenshots,
                seen_stream_urls=seen_stream_urls,
                fallback_url=url,
            )

    final_status = (
        ExtractionStatus.SUCCESS if all_streams
        else ExtractionStatus.PARTIAL if extraction_results
        else ExtractionStatus.FAILED
    )

    return PipelineResult(
        run_id=run_id,
        url=url,
        classification=classification,
        matches=matches,
        extraction_results=extraction_results,
        final_status=final_status,
        all_streams=all_streams,
        all_screenshots=list(dict.fromkeys(all_screenshots)),
        provider_analysis=provider_analysis,
        takedown_emails=takedown_emails,
        metrics=metrics,
    )


def _collect_extraction(
    payload: dict,
    extraction_results: list[ExtractionResult],
    all_streams: list[StreamURL],
    all_screenshots: list[str],
    seen_stream_urls: set[str],
    fallback_url: str,
) -> None:
    source_url = payload.get("url", fallback_url)
    page_type_str = payload.get("page_type", "hosting_page")
    page_type = PageType(page_type_str) if page_type_str in PageType._value2member_map_ else PageType.HOSTING
    agent_type = AgentType(payload.get("agent_type", AgentType.HOSTING_PAGE))

    streams: list[StreamURL] = []
    screenshots: list[str] = []

    for server in payload.get("metadata", {}).get("servers", []):
        for su in server.get("m3u8_urls", []) + server.get("mpd_urls", []) + server.get("mp4_urls", []):
            if su and su not in seen_stream_urls:
                seen_stream_urls.add(su)
                s = StreamURL(url=su, source_layer=server.get("label", ""))
                streams.append(s)
                all_streams.append(s)
        shot = server.get("screenshot_url")
        if shot:
            screenshots.append(shot)
            all_screenshots.append(shot)

    status_str = payload.get("status", "failed")
    status = ExtractionStatus(status_str) if status_str in ExtractionStatus._value2member_map_ else ExtractionStatus.FAILED

    extraction_results.append(ExtractionResult(
        url=source_url,
        page_type=page_type,
        status=status,
        streams=streams,
        screenshots=screenshots,
        agent_type=agent_type,
        tool_calls_used=payload.get("tool_calls_used", 0),
        metadata=payload.get("metadata", {}),
    ))


# ── Default prompt ────────────────────────────────────────────────────────────

_DEFAULT_SYSTEM_PROMPT = """\
You are the Orchestrator. Use gemini-2.5-flash-lite to coordinate the full
illegal streaming site extraction pipeline. You have 6 tools:

  classify_page           — always call this FIRST
  run_landing_agent       — call if classify_page returns landing_page
  run_hosting_agent       — call for each hosting URL (once per match/channel)
  run_embedded_agent      — call if hosting agent fails or page is embed_video_page
  analyze_providers       — call AFTER all extractions, pass all stream URLs found
  generate_takedown_emails — call AFTER analyze_providers

WORKFLOW:
1. classify_page(url)
2. If landing_page → run_landing_agent(url) → get hosting_pages list
3. For each hosting URL in the list → run_hosting_agent(url)
4. For any server with embedded_url → run_embedded_agent(embedded_url)
5. If host_page → run_hosting_agent(url) directly
6. If embed_video_page → run_embedded_agent(url) directly
7. Collect ALL stream URLs from steps 3-6
8. analyze_providers(stream_urls=[...all streams...])
9. generate_takedown_emails(
       infringing_url=<original url>,
       provider_analysis=<output from analyze_providers>,
       extraction_results=[<all server+stream+screenshot data>]
   )

RULES:
- Process ALL hosting URLs from the landing agent, not just the first one.
- If a hosting page fails entirely, move to the next — don't stop.
- Always call analyze_providers and generate_takedown_emails at the end.
- Do not skip steps even if earlier steps had partial failures.
"""
