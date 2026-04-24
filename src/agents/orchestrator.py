"""LangGraph orchestrator for the full extraction pipeline."""

from __future__ import annotations

import asyncio
import json
import uuid
from functools import partial
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from src.memory.long_term import LongTermMemory
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
from src.utils.instrumentation import observability_span, set_span_output, using_observability_context
from src.utils.observability import RunObserver, get_observability_status, run_registry

logger = get_logger(__name__)


class HandoffContext(TypedDict, total=False):
    """Structured context passed from orchestrator to each child agent.

    All fields are optional so callers only populate what they have.
    Use ``render_handoff()`` to convert to a prompt string.
    """
    root_url: str
    target_url: str
    page_type: str
    classification_reasoning: str
    candidate_title: str
    candidate_participants: str
    landing_route: str
    landing_iframes: list[str]
    source_hosting_url: str
    source_hosting_status: str
    source_hosting_decision: str
    source_streams_found: int
    focus: str
    memory_hints: str


def render_handoff(ctx: HandoffContext) -> str:
    """Serialize HandoffContext to a human-readable prompt string."""
    lines = ["ORCHESTRATOR HANDOFF"]
    if ctx.get("root_url"):
        lines.append(f"- root url: {ctx['root_url']}")
    if ctx.get("target_url") and ctx.get("target_url") != ctx.get("root_url"):
        lines.append(f"- target url: {ctx['target_url']}")
    if ctx.get("page_type"):
        lines.append(f"- upstream classification: {ctx['page_type']}")
    if ctx.get("classification_reasoning"):
        lines.append(f"- classification reasoning: {_truncate(ctx['classification_reasoning'])}")
    if ctx.get("candidate_title"):
        lines.append(f"- candidate title: {_truncate(ctx['candidate_title'], max_chars=180)}")
    if ctx.get("candidate_participants"):
        lines.append(f"- participants: {_truncate(ctx['candidate_participants'], max_chars=180)}")
    if ctx.get("landing_route"):
        lines.append(f"- landing suggested route: {ctx['landing_route']}")
    if ctx.get("landing_iframes"):
        lines.append(f"- landing iframes to watch: {', '.join(ctx['landing_iframes'][:4])}")
    if ctx.get("source_hosting_url"):
        lines.append(f"- source hosting page: {ctx['source_hosting_url']}")
    if ctx.get("source_hosting_status"):
        lines.append(f"- source hosting status: {ctx['source_hosting_status']}")
    if ctx.get("source_hosting_decision"):
        lines.append(f"- source hosting decision: {ctx['source_hosting_decision']}")
    if ctx.get("source_streams_found"):
        lines.append(f"- source hosting already found streams: {ctx['source_streams_found']}")
    if ctx.get("focus"):
        lines.append(f"- focus: {ctx['focus']}")
    if ctx.get("memory_hints"):
        lines.append("- memory check: prior hints found for this domain; use as soft guidance")
        lines.append(_truncate(ctx["memory_hints"], max_chars=1200))
    return "\n".join(lines)


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
    for server in extraction.servers:
        if server.embedded_url:
            urls.append(server.embedded_url)
    for server in extraction.metadata.get("servers", []):
        embedded_url = server.get("embedded_url")
        if embedded_url:
            urls.append(embedded_url)
    return _dedupe_urls(urls)


def _truncate(value: Any, *, max_chars: int = 700) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    return text if len(text) <= max_chars else f"{text[: max_chars - 3]}..."


def _memory_hint(memory: LongTermMemory | None, *, url: str, page_type: str, limit: int = 3) -> str:
    if memory is None:
        return ""
    try:
        return memory.build_prompt_context(url=url, page_type=page_type, limit=limit)
    except Exception:
        return ""


def _match_for_url(matches: list[MatchInfo], target_url: str) -> MatchInfo | None:
    target = str(target_url or "").strip()
    if not target:
        return None
    for item in matches:
        if item.url == target:
            return item
    return None


def _latest_hosting_context_for_embedded(
    extraction_results: list[ExtractionResult],
    *,
    embedded_url: str,
) -> ExtractionResult | None:
    target = str(embedded_url or "").strip()
    if not target:
        return None
    for extraction in reversed(extraction_results):
        if extraction.page_type != PageType.HOSTING:
            continue
        if target in _collect_embedded_urls(extraction):
            return extraction
    return None


def _requires_embedded_followup(extraction: ExtractionResult) -> bool:
    decision = str(extraction.metadata.get("decision", "") or "").strip().lower()
    if decision in {"needs_embed_agent", "partial_success_needs_embed"}:
        return True
    if extraction.status != ExtractionStatus.SUCCESS:
        return True
    return not extraction.streams and bool(_collect_embedded_urls(extraction))


def _build_landing_handoff(
    state: PipelineState,
    *,
    memory_hint_text: str,
) -> str:
    classification = state.get("classification")
    ctx: HandoffContext = {
        "root_url": state["url"],
        "page_type": classification.page_type.value if classification is not None else "unknown",
        "classification_reasoning": classification.reasoning if classification is not None else "",
        "focus": "return clean hosting candidates (with route + iframe hints) and avoid duplicates",
        "memory_hints": memory_hint_text,
    }
    return render_handoff(ctx)


def _build_hosting_handoff(
    state: PipelineState,
    *,
    target_url: str,
    memory_hint_text: str,
) -> str:
    classification = state.get("classification")
    match = _match_for_url(state.get("matches", []), target_url)
    ctx: HandoffContext = {
        "root_url": state["url"],
        "target_url": target_url,
        "page_type": classification.page_type.value if classification is not None else "",
        "classification_reasoning": classification.reasoning if classification is not None else "",
        "focus": "verify direct m3u8/mpd/mp4 first; look out for server switch tabs, player iframe URLs, cloudinary screenshots, and clean server labels; return embedded handoff only when needed",
        "memory_hints": memory_hint_text,
    }
    if match is not None:
        ctx["candidate_title"] = match.title or ""
        ctx["candidate_participants"] = match.participants or ""
        ctx["landing_route"] = match.route or ""
        ctx["landing_iframes"] = _dedupe_urls(match.iframes)[:4] if match.iframes else []
    return render_handoff(ctx)


def _build_embedded_handoff(
    state: PipelineState,
    *,
    target_url: str,
    memory_hint_text: str,
) -> str:
    source_hosting = _latest_hosting_context_for_embedded(state.get("extraction_results", []), embedded_url=target_url)
    ctx: HandoffContext = {
        "root_url": state["url"],
        "target_url": target_url,
        "focus": "recover stream URLs from the embedded player; look out for iframe-local controls, activated server tabs, and screenshot evidence; keep server artifacts clean",
        "memory_hints": memory_hint_text,
    }
    if source_hosting is not None:
        ctx["source_hosting_url"] = source_hosting.url
        ctx["source_hosting_status"] = source_hosting.status.value
        ctx["source_hosting_decision"] = str(source_hosting.metadata.get("decision", "") or "").strip()
        ctx["source_streams_found"] = len(source_hosting.streams)
    return render_handoff(ctx)


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
    memory: LongTermMemory | None = None,
) -> dict[str, Any]:
    from src.agents.landing_page import LandingPageAgent
    from src.agents.hosting_page import HostingPageAgent

    landing_child = observer.child("landing", AgentType.LANDING_PAGE) if observer else None
    hosting_child = observer.child("hosting", AgentType.HOSTING_PAGE) if observer else None

    landing_memory_hint = _memory_hint(
        memory,
        url=state["url"],
        page_type=AgentType.LANDING_PAGE.value,
    )
    landing_handoff = _build_landing_handoff(state, memory_hint_text=landing_memory_hint)

    root_hosting_memory_hint = _memory_hint(
        memory,
        url=state["url"],
        page_type=AgentType.HOSTING_PAGE.value,
    )
    root_hosting_handoff = _build_hosting_handoff(
        state,
        target_url=state["url"],
        memory_hint_text=root_hosting_memory_hint,
    )

    landing_task = LandingPageAgent(settings).run(
        url=state["url"],
        observer=landing_child,
        orchestrator_handoff=landing_handoff,
    )
    root_hosting_task = HostingPageAgent(settings).run(
        url=state["url"],
        observer=hosting_child,
        orchestrator_handoff=root_hosting_handoff,
    )
    landing_outcome, root_hosting_outcome = await asyncio.gather(
        landing_task,
        root_hosting_task,
        return_exceptions=True,
    )

    hosting_pages: list[dict[str, Any]] = []
    if isinstance(landing_outcome, Exception):
        logger.warning("Landing page agent failed for %s: %s", state["url"], landing_outcome)
    else:
        hosting_pages = landing_outcome.metadata.get("hosting_pages", [])

    matches: list[MatchInfo] = []
    for page in hosting_pages:
        if not isinstance(page, dict) or not page.get("url"):
            continue
        try:
            matches.append(MatchInfo(**page))
        except Exception:
            logger.warning("Skipping malformed landing-page match payload: %s", page)

    pending_hosting_urls = _dedupe_urls([match.url for match in matches if match.url != state["url"]])

    extraction_results = list(state["extraction_results"])
    pending_embedded_urls = list(state["pending_embedded_urls"])

    if isinstance(root_hosting_outcome, Exception):
        logger.warning("Root hosting probe failed for %s: %s", state["url"], root_hosting_outcome)
        root_extraction = ExtractionResult(
            url=state["url"],
            page_type=PageType.HOSTING,
            status=ExtractionStatus.FAILED,
            agent_type=AgentType.HOSTING_PAGE,
            error_message=str(root_hosting_outcome),
            metadata={"orchestrator_error": type(root_hosting_outcome).__name__},
        )
    else:
        root_extraction = root_hosting_outcome

    extraction_results.append(root_extraction)
    embedded_candidates = _collect_embedded_urls(root_extraction)
    needs_embed_followup = _requires_embedded_followup(root_extraction)
    if needs_embed_followup and not embedded_candidates:
        embedded_candidates = [state["url"]]
    if needs_embed_followup:
        pending_embedded_urls = _dedupe_urls([*pending_embedded_urls, *embedded_candidates])

    return {
        "matches": matches,
        "pending_hosting_urls": pending_hosting_urls,
        "pending_embedded_urls": pending_embedded_urls,
        "extraction_results": extraction_results,
    }


async def hosting_page_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
    memory: LongTermMemory | None = None,
) -> dict[str, Any]:
    from src.agents.hosting_page import HostingPageAgent

    if not state["pending_hosting_urls"]:
        return {}

    target_urls = _dedupe_urls(state["pending_hosting_urls"])
    tasks = []
    for target_url in target_urls:
        child = observer.child("hosting", AgentType.HOSTING_PAGE) if observer else None
        hosting_memory_hint = _memory_hint(
            memory,
            url=target_url,
            page_type=AgentType.HOSTING_PAGE.value,
        )
        handoff = _build_hosting_handoff(
            state,
            target_url=target_url,
            memory_hint_text=hosting_memory_hint,
        )
        tasks.append(
            HostingPageAgent(settings).run(
                url=target_url,
                observer=child,
                orchestrator_handoff=handoff,
            )
        )

    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    extraction_results = list(state["extraction_results"])
    pending_embedded_urls = list(state["pending_embedded_urls"])

    for target_url, outcome in zip(target_urls, outcomes, strict=False):
        if isinstance(outcome, Exception):
            logger.warning("Hosting page agent failed for %s: %s", target_url, outcome)
            extraction = ExtractionResult(
                url=target_url,
                page_type=PageType.HOSTING,
                status=ExtractionStatus.FAILED,
                agent_type=AgentType.HOSTING_PAGE,
                error_message=str(outcome),
                metadata={"orchestrator_error": type(outcome).__name__},
            )
        else:
            extraction = outcome

        extraction_results.append(extraction)

        embedded_candidates = _collect_embedded_urls(extraction)
        needs_embed_followup = _requires_embedded_followup(extraction)
        if needs_embed_followup and not embedded_candidates:
            embedded_candidates = [target_url]
        if needs_embed_followup:
            pending_embedded_urls = _dedupe_urls([*pending_embedded_urls, *embedded_candidates])

    return {
        "pending_hosting_urls": [],
        "pending_embedded_urls": pending_embedded_urls,
        "extraction_results": extraction_results,
    }


async def embedded_page_node(
    state: PipelineState,
    *,
    settings: Settings,
    observer: RunObserver | None = None,
    memory: LongTermMemory | None = None,
) -> dict[str, Any]:
    from src.agents.embedded_page import EmbeddedPageAgent

    if not state["pending_embedded_urls"]:
        return {}

    target_urls = _dedupe_urls(state["pending_embedded_urls"])
    tasks = []
    for target_url in target_urls:
        child = observer.child("embedded", AgentType.EMBEDDED_PAGE) if observer else None
        embedded_memory_hint = _memory_hint(
            memory,
            url=target_url,
            page_type=AgentType.EMBEDDED_PAGE.value,
        )
        handoff = _build_embedded_handoff(
            state,
            target_url=target_url,
            memory_hint_text=embedded_memory_hint,
        )
        tasks.append(
            EmbeddedPageAgent(settings).run(
                url=target_url,
                observer=child,
                orchestrator_handoff=handoff,
            )
        )

    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    extraction_results = list(state["extraction_results"])
    for target_url, outcome in zip(target_urls, outcomes, strict=False):
        if isinstance(outcome, Exception):
            logger.warning("Embedded page agent failed for %s: %s", target_url, outcome)
            extraction = ExtractionResult(
                url=target_url,
                page_type=PageType.EMBEDDED,
                status=ExtractionStatus.FAILED,
                agent_type=AgentType.EMBEDDED_PAGE,
                error_message=str(outcome),
                metadata={"orchestrator_error": type(outcome).__name__},
            )
        else:
            extraction = outcome
        extraction_results.append(extraction)

    return {
        "pending_embedded_urls": [],
        "extraction_results": extraction_results,
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
        return "landing_page"
    if classification.page_type == PageType.LANDING:
        return "landing_page"
    if classification.page_type == PageType.HOSTING:
        return "queue_root_hosting"
    if classification.page_type == PageType.EMBEDDED:
        return "queue_root_embedded"
    return "landing_page"


def route_after_landing(state: PipelineState) -> str:
    if state["pending_hosting_urls"]:
        return "hosting_page"
    if state["pending_embedded_urls"]:
        return "embedded_page"
    return "analyze_providers"


def route_after_hosting(state: PipelineState) -> str:
    if state["pending_embedded_urls"] and state["extraction_results"]:
        latest = state["extraction_results"][-1]
        if latest.page_type == PageType.HOSTING and _requires_embedded_followup(latest):
            return "embedded_page"
    if state["pending_hosting_urls"]:
        return "hosting_page"
    if state["pending_embedded_urls"]:
        return "embedded_page"
    return "analyze_providers"


def route_after_embedded(state: PipelineState) -> str:
    return "embedded_page" if state["pending_embedded_urls"] else "analyze_providers"


def build_graph(settings: Settings, observer: RunObserver | None = None):
    """Build the deterministic LangGraph orchestration graph."""
    memory = LongTermMemory(settings.memory_db_path) if settings.memory_enabled else None
    graph = StateGraph(PipelineState)
    graph.add_node("classify", partial(classify_node, settings=settings, observer=observer))
    graph.add_node("queue_root_hosting", queue_root_hosting_node)
    graph.add_node("queue_root_embedded", queue_root_embedded_node)
    graph.add_node(
        "landing_page",
        partial(landing_page_node, settings=settings, observer=observer, memory=memory),
    )
    graph.add_node(
        "hosting_page",
        partial(hosting_page_node, settings=settings, observer=observer, memory=memory),
    )
    graph.add_node(
        "embedded_page",
        partial(embedded_page_node, settings=settings, observer=observer, memory=memory),
    )
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
            with using_observability_context(
                session_id=self.observer.run_id if self.observer is not None else "",
                metadata={"agent_type": AgentType.ORCHESTRATOR.value, "url": url},
                tags=["orchestrator", "pipeline", "langgraph"],
            ):
                with observability_span(
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
            observability=get_observability_status(settings),
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
        for server in extraction.servers:
            for url in server.m3u8_urls + server.mpd_urls + server.mp4_urls:
                if url and url not in seen:
                    seen.add(url)
                    streams.append(StreamURL(url=url, source_layer=server.label))
        # Backward-compatible fallback for legacy payloads that only kept servers in metadata.
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
        for server in extraction.servers:
            if server.screenshot_url:
                screenshots.append(server.screenshot_url)
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
