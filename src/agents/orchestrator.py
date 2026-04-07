"""LangGraph orchestrator for the full extraction pipeline."""

from __future__ import annotations

import json
import uuid
from functools import partial
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

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
from src.utils.observability import RunObserver, get_tracing_status, run_registry
from src.utils.phoenix import phoenix_span, set_span_output, using_phoenix_attributes

logger = get_logger(__name__)


class PipelineState(TypedDict):
    url: str
    run_id: str
    classification: ClassificationResult | None
    matches: list[MatchInfo]
    extraction_results: list[ExtractionResult]
    pending_hosting_urls: list[str]
    pending_embedded_urls: list[str]
    provider_analysis: list[ProviderInfo]
    takedown_emails: list[TakedownEmail]
    error: str


def _dedupe_urls(urls: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for url in urls:
        if url and url not in seen:
            seen.add(url)
            result.append(url)
    return result


def _collect_embedded_urls(extraction: ExtractionResult) -> list[str]:
    urls = list(extraction.embedded_urls)
    for server in extraction.metadata.get("servers", []):
        embedded_url = server.get("embedded_url")
        if embedded_url:
            urls.append(embedded_url)
    return _dedupe_urls(urls)


async def classify_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    from src.agents.classification import ClassificationAgent

    child = observer.child("classification", AgentType.CLASSIFICATION) if observer else None
    result = await ClassificationAgent(settings).run(url=state["url"], observer=child)
    return {"classification": result, "error": ""}


async def queue_root_hosting_node(state: PipelineState) -> dict[str, Any]:
    return {"pending_hosting_urls": _dedupe_urls([*state["pending_hosting_urls"], state["url"]])}


async def queue_root_embedded_node(state: PipelineState) -> dict[str, Any]:
    return {"pending_embedded_urls": _dedupe_urls([*state["pending_embedded_urls"], state["url"]])}


async def landing_page_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    from src.agents.landing_page import LandingPageAgent

    child = observer.child("landing", AgentType.LANDING_PAGE) if observer else None
    extraction = await LandingPageAgent(settings).run(url=state["url"], observer=child)
    hosting_pages = extraction.metadata.get("hosting_pages", [])
    matches: list[MatchInfo] = []
    for page in hosting_pages:
        if not isinstance(page, dict) or not page.get("url"):
            continue
        try:
            matches.append(MatchInfo(**page))
        except Exception:
            logger.warning("Skipping malformed landing-page match payload: %s", page)
    pending_hosting_urls = _dedupe_urls([match.url for match in matches])
    return {
        "matches": matches,
        "pending_hosting_urls": pending_hosting_urls,
    }


async def hosting_page_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    from src.agents.hosting_page import HostingPageAgent

    if not state["pending_hosting_urls"]:
        return {}

    target_url = state["pending_hosting_urls"][0]
    remaining_hosting_urls = state["pending_hosting_urls"][1:]
    child = observer.child("hosting", AgentType.HOSTING_PAGE) if observer else None
    extraction = await HostingPageAgent(settings).run(url=target_url, observer=child)
    pending_embedded_urls = _dedupe_urls(
        [*state["pending_embedded_urls"], *_collect_embedded_urls(extraction)]
    )
    return {
        "pending_hosting_urls": remaining_hosting_urls,
        "pending_embedded_urls": pending_embedded_urls,
        "extraction_results": [*state["extraction_results"], extraction],
    }


async def embedded_page_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
) -> dict[str, Any]:
    from src.agents.embedded_page import EmbeddedPageAgent

    if not state["pending_embedded_urls"]:
        return {}

    target_url = state["pending_embedded_urls"][0]
    remaining_embedded_urls = state["pending_embedded_urls"][1:]
    child = observer.child("embedded", AgentType.EMBEDDED_PAGE) if observer else None
    extraction = await EmbeddedPageAgent(settings).run(url=target_url, observer=child)
    return {
        "pending_embedded_urls": remaining_embedded_urls,
        "extraction_results": [*state["extraction_results"], extraction],
    }


async def analyze_providers_node(
    state: PipelineState,
    *,
    settings: Settings,
) -> dict[str, Any]:
    stream_urls = [stream.url for stream in _collect_all_streams(state["extraction_results"])]
    payload = await IPInfoTool(ipinfo_token=settings.ipinfo_token)._arun(stream_urls=stream_urls)
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        parsed = []
    providers = [ProviderInfo(**item) for item in parsed if isinstance(item, dict)]
    return {"provider_analysis": providers}


async def generate_takedown_emails_node(state: PipelineState) -> dict[str, Any]:
    payload = await EmailTool()._arun(
        infringing_url=state["url"],
        provider_analysis=[provider.model_dump(mode="json") for provider in state["provider_analysis"]],
        extraction_results=[result.model_dump(mode="json") for result in state["extraction_results"]],
    )
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        parsed = []
    emails = [TakedownEmail(**item) for item in parsed if isinstance(item, dict)]
    return {"takedown_emails": emails}


def route_after_classification(state: PipelineState) -> str:
    classification = state["classification"]
    if classification is None:
        return "analyze_providers"
    if classification.page_type == PageType.LANDING:
        return "landing_page"
    if classification.page_type == PageType.HOSTING:
        return "queue_root_hosting"
    if classification.page_type == PageType.EMBEDDED:
        return "queue_root_embedded"
    return "analyze_providers"


def route_after_landing(state: PipelineState) -> str:
    return "hosting_page" if state["pending_hosting_urls"] else "analyze_providers"


def route_after_hosting(state: PipelineState) -> str:
    if state["pending_hosting_urls"]:
        return "hosting_page"
    if state["pending_embedded_urls"]:
        return "embedded_page"
    return "analyze_providers"


def route_after_embedded(state: PipelineState) -> str:
    return "embedded_page" if state["pending_embedded_urls"] else "analyze_providers"


def build_graph(settings: Settings, observer: RunObserver | None = None):
    """Build the deterministic LangGraph orchestration graph."""
    graph = StateGraph(PipelineState)
    graph.add_node("classify", partial(classify_node, settings=settings, observer=observer))
    graph.add_node("queue_root_hosting", queue_root_hosting_node)
    graph.add_node("queue_root_embedded", queue_root_embedded_node)
    graph.add_node("landing_page", partial(landing_page_node, settings=settings, observer=observer))
    graph.add_node("hosting_page", partial(hosting_page_node, settings=settings, observer=observer))
    graph.add_node("embedded_page", partial(embedded_page_node, settings=settings, observer=observer))
    graph.add_node("analyze_providers", partial(analyze_providers_node, settings=settings))
    graph.add_node("generate_takedown_emails", generate_takedown_emails_node)

    graph.add_edge(START, "classify")
    graph.add_conditional_edges(
        "classify",
        route_after_classification,
        {
            "landing_page": "landing_page",
            "queue_root_hosting": "queue_root_hosting",
            "queue_root_embedded": "queue_root_embedded",
            "analyze_providers": "analyze_providers",
        },
    )
    graph.add_conditional_edges(
        "landing_page",
        route_after_landing,
        {"hosting_page": "hosting_page", "analyze_providers": "analyze_providers"},
    )
    graph.add_edge("queue_root_hosting", "hosting_page")
    graph.add_conditional_edges(
        "hosting_page",
        route_after_hosting,
        {
            "hosting_page": "hosting_page",
            "embedded_page": "embedded_page",
            "analyze_providers": "analyze_providers",
        },
    )
    graph.add_edge("queue_root_embedded", "embedded_page")
    graph.add_conditional_edges(
        "embedded_page",
        route_after_embedded,
        {"embedded_page": "embedded_page", "analyze_providers": "analyze_providers"},
    )
    graph.add_edge("analyze_providers", "generate_takedown_emails")
    graph.add_edge("generate_takedown_emails", END)
    return graph.compile()


class OrchestratorAgent:
    """LangGraph orchestrator wrapper."""

    def __init__(self, settings: Settings, observer: RunObserver | None = None) -> None:
        self.settings = settings
        self.observer = observer
        self.graph = build_graph(settings, observer=observer)

    async def run(self, url: str) -> PipelineResult:
        run_id = self.observer.run_id if self.observer is not None else str(uuid.uuid4())
        logger.info("Pipeline started: run_id=%s url=%s", run_id, url)
        if self.observer is not None:
            self.observer.set_url(url)
            self.observer.mark_agent(AgentType.ORCHESTRATOR)
            self.observer.emit("pipeline_started", f"Pipeline started for {url}")

        initial_state: PipelineState = {
            "url": url,
            "run_id": run_id,
            "classification": None,
            "matches": [],
            "extraction_results": [],
            "pending_hosting_urls": [],
            "pending_embedded_urls": [],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        }

        try:
            with using_phoenix_attributes(
                session_id=self.observer.run_id if self.observer is not None else "",
                metadata={"agent_type": AgentType.ORCHESTRATOR.value, "url": url},
                tags=["orchestrator", "pipeline", "langgraph"],
            ):
                with phoenix_span(
                    "orchestrator_agent.run",
                    kind="agent",
                    input_value={"url": url},
                    attributes={
                        "owc.agent_type": AgentType.ORCHESTRATOR.value,
                        "owc.runtime": "langgraph",
                    },
                ) as span:
                    final_state = await self.graph.ainvoke(initial_state)
                    result = _build_pipeline_result(final_state, self.observer.trace().metrics if self.observer else None)
                    set_span_output(
                        span,
                        {
                            "final_status": result.final_status.value,
                            "streams_found": len(result.all_streams),
                            "emails_generated": len(result.takedown_emails),
                            "provider_analyses": len(result.provider_analysis),
                        },
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
                run_id,
                result.final_status,
                len(result.all_streams),
                len(result.takedown_emails),
            )
            return result
        except Exception as exc:
            if self.observer is not None:
                self.observer.emit("pipeline_failed", str(exc), status="error")
                self.observer.finish(success=False, failure_mode=type(exc).__name__)
            raise


async def run_pipeline(
    url: str,
    settings: Settings,
    observer: RunObserver | None = None,
) -> PipelineResult:
    if observer is None:
        observer = run_registry.create(
            run_id=str(uuid.uuid4()),
            root_actor="orchestrator",
            tracing=get_tracing_status(settings),
        )
    return await OrchestratorAgent(settings, observer=observer).run(url)


def _collect_all_streams(extraction_results: list[ExtractionResult]) -> list[StreamURL]:
    seen: set[str] = set()
    streams: list[StreamURL] = []
    for extraction in extraction_results:
        for stream in extraction.streams:
            if stream.url and stream.url not in seen:
                seen.add(stream.url)
                streams.append(stream)
        for server in extraction.metadata.get("servers", []):
            for url in server.get("m3u8_urls", []) + server.get("mpd_urls", []) + server.get("mp4_urls", []):
                if url and url not in seen:
                    seen.add(url)
                    streams.append(StreamURL(url=url, source_layer=server.get("label", "")))
    return streams


def _collect_all_screenshots(extraction_results: list[ExtractionResult]) -> list[str]:
    screenshots: list[str] = []
    for extraction in extraction_results:
        screenshots.extend(extraction.screenshots)
        for server in extraction.metadata.get("servers", []):
            screenshot_url = server.get("screenshot_url")
            if screenshot_url:
                screenshots.append(screenshot_url)
    return _dedupe_urls(screenshots)


def _build_pipeline_result(state: PipelineState, metrics: Any | None = None) -> PipelineResult:
    all_streams = _collect_all_streams(state["extraction_results"])
    final_status = (
        ExtractionStatus.SUCCESS
        if all_streams
        else ExtractionStatus.PARTIAL
        if state["extraction_results"]
        else ExtractionStatus.FAILED
    )

    return PipelineResult(
        run_id=state["run_id"],
        url=state["url"],
        classification=state["classification"],
        matches=state["matches"],
        extraction_results=state["extraction_results"],
        final_status=final_status,
        all_streams=all_streams,
        all_screenshots=_collect_all_screenshots(state["extraction_results"]),
        provider_analysis=state["provider_analysis"],
        takedown_emails=state["takedown_emails"],
        metrics=metrics,
    )
