"""LangGraph orchestrator: state machine routing classify → extract → enrich."""

from __future__ import annotations

import uuid
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages

from src.models.enums import ExtractionStatus, PageType
from src.models.schemas import ClassificationResult, ExtractionResult, PipelineResult
from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)


# ── Pipeline state ──────────────────────────────────────────────────────────

class PipelineState(TypedDict):
    url: str
    run_id: str
    classification: ClassificationResult | None
    extraction: ExtractionResult | None
    error: str


# ── Node functions ───────────────────────────────────────────────────────────

def classify_node(state: PipelineState, settings: Settings) -> PipelineState:
    from src.agents.classification import ClassificationAgent
    agent = ClassificationAgent(settings)
    result = agent.run(url=state["url"])
    return {**state, "classification": result}


def route_after_classification(state: PipelineState) -> str:
    """Conditional edge: choose the extraction node based on page_type."""
    c = state.get("classification")
    if c is None:
        return "end"
    mapping = {
        PageType.LANDING: "landing_page",
        PageType.HOSTING: "hosting_page",
        PageType.EMBEDDED: "embedded_page",
    }
    return mapping.get(c.page_type, "end")


def landing_page_node(state: PipelineState, settings: Settings) -> PipelineState:
    from src.agents.landing_page import LandingPageAgent
    agent = LandingPageAgent(settings)
    result = agent.run(url=state["url"])
    return {**state, "extraction": result}


def hosting_page_node(state: PipelineState, settings: Settings) -> PipelineState:
    from src.agents.hosting_page import HostingPageAgent
    agent = HostingPageAgent(settings)
    result = agent.run(url=state["url"])
    return {**state, "extraction": result}


def embedded_page_node(state: PipelineState, settings: Settings) -> PipelineState:
    from src.agents.embedded_page import EmbeddedPageAgent
    agent = EmbeddedPageAgent(settings)
    result = agent.run(url=state["url"])
    return {**state, "extraction": result}


# ── Graph construction ───────────────────────────────────────────────────────

def build_graph(settings: Settings) -> Any:
    """Build and compile the LangGraph state machine."""
    import functools

    graph = StateGraph(PipelineState)

    graph.add_node("classify", functools.partial(classify_node, settings=settings))
    graph.add_node("landing_page", functools.partial(landing_page_node, settings=settings))
    graph.add_node("hosting_page", functools.partial(hosting_page_node, settings=settings))
    graph.add_node("embedded_page", functools.partial(embedded_page_node, settings=settings))

    graph.set_entry_point("classify")
    graph.add_conditional_edges(
        "classify",
        route_after_classification,
        {
            "landing_page": "landing_page",
            "hosting_page": "hosting_page",
            "embedded_page": "embedded_page",
            "end": END,
        },
    )
    graph.add_edge("landing_page", END)
    graph.add_edge("hosting_page", END)
    graph.add_edge("embedded_page", END)

    return graph.compile()


# ── Public entry point ───────────────────────────────────────────────────────

def run_pipeline(url: str, settings: Settings) -> PipelineResult:
    """Run the full pipeline and return a PipelineResult."""
    run_id = str(uuid.uuid4())
    logger.info("Pipeline started: run_id=%s url=%s", run_id, url)

    compiled = build_graph(settings)
    final_state = compiled.invoke(
        PipelineState(url=url, run_id=run_id, classification=None, extraction=None, error="")
    )

    classification: ClassificationResult | None = final_state.get("classification")
    extraction: ExtractionResult | None = final_state.get("extraction")

    status = ExtractionStatus.FAILED
    if extraction:
        status = extraction.status

    result = PipelineResult(
        run_id=run_id,
        url=url,
        classification=classification,
        extraction=extraction,
        final_status=status,
        streams=extraction.streams if extraction else [],
        screenshots=extraction.screenshots if extraction else [],
    )
    logger.info("Pipeline finished: run_id=%s status=%s streams=%d", run_id, status, len(result.streams))
    return result
