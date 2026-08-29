import asyncio
import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.messages import AIMessage

import src.api.app as api_app
from src.agents.base import run_agent_loop
from src.agents.embedded_page import EmbeddedPageAgent
from src.agents.errors import RunCancelledError
from src.agents.hosting_page import HostingPageAgent
from src.agents.orchestrator import (
    OrchestratorAgent,
    classify_node,
    embedded_page_node,
    hosting_page_node,
    landing_page_node,
)
from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import ClassificationResult, ExtractionResult, PipelineResult
from src.utils.config import Settings
from src.utils.observability import get_observability_status, run_registry

URL = "https://target.example/watch/1"


def _observer(actor: str = "orchestrator"):
    return run_registry.create(
        run_id=f"cancel-{uuid.uuid4()}",
        root_actor=actor,
        observability=get_observability_status(Settings()),
    )


def _pipeline_state(page_type: PageType, *, pending_key: str = "") -> dict[str, Any]:
    state: dict[str, Any] = {
        "url": URL,
        "run_id": "run-1",
        "classification": ClassificationResult(
            url=URL,
            page_type=page_type,
            confidence=Confidence.HIGH,
            confidence_source="parsed",
        ),
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
        "gate_no_target": False,
    }
    if pending_key:
        state[pending_key] = [URL]
    return state


@pytest.mark.unit
@pytest.mark.asyncio
async def test_classification_cancellation_bypasses_fallback(monkeypatch) -> None:
    async def cancel(self, url, observer=None, *, instruction_override=None):
        raise RunCancelledError("classification cancelled")

    monkeypatch.setattr("src.agents.classification.ClassificationAgent.run", cancel)

    with pytest.raises(RunCancelledError, match="classification cancelled"):
        await classify_node({"url": URL}, settings=Settings(), observer=None)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_ocr_cancellation_bypasses_optional_enrichment_handler(monkeypatch) -> None:
    async def classify(self, url, observer=None, *, instruction_override=None):
        return ClassificationResult(
            url=url,
            page_type=PageType.HOSTING,
            confidence=Confidence.HIGH,
            confidence_source="parsed",
        )

    async def cancel_ocr(self, screenshot_ref, observer=None):
        raise RunCancelledError("ocr cancelled")

    monkeypatch.setattr("src.agents.classification.ClassificationAgent.run", classify)
    monkeypatch.setattr("src.agents.ocr_agent.OcrAgent.run", cancel_ocr)
    state = _pipeline_state(PageType.HOSTING)
    state["extraction_results"] = [
        ExtractionResult(
            url=URL,
            page_type=PageType.HOSTING,
            status=ExtractionStatus.SUCCESS,
            agent_type=AgentType.HOSTING_PAGE,
            screenshots=["shot.png"],
        )
    ]

    with pytest.raises(RunCancelledError, match="ocr cancelled"):
        await classify_node(state, settings=Settings(), observer=None)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_landing_cancellation_bypasses_failure_result(monkeypatch) -> None:
    async def cancel(self, *, url, observer=None, orchestrator_handoff=""):
        raise RunCancelledError("landing cancelled")

    monkeypatch.setattr("src.agents.landing_page.LandingPageAgent.run", cancel)

    with pytest.raises(RunCancelledError, match="landing cancelled"):
        await landing_page_node(
            _pipeline_state(PageType.LANDING),
            settings=Settings(),
            observer=None,
            memory=None,
        )


@pytest.mark.unit
@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("node", "agent_class", "page_type", "pending_key", "cancel_before_dispatch"),
    [
        (hosting_page_node, HostingPageAgent, PageType.HOSTING, "pending_hosting_urls", False),
        (embedded_page_node, EmbeddedPageAgent, PageType.EMBEDDED, "pending_embedded_urls", False),
        (hosting_page_node, HostingPageAgent, PageType.HOSTING, "pending_hosting_urls", True),
        (embedded_page_node, EmbeddedPageAgent, PageType.EMBEDDED, "pending_embedded_urls", True),
    ],
)
async def test_child_cancellation_bypasses_gather_folding(
    monkeypatch,
    node,
    agent_class,
    page_type: PageType,
    pending_key: str,
    cancel_before_dispatch: bool,
) -> None:
    async def cancel(self, *, url, observer=None, orchestrator_handoff=""):
        if cancel_before_dispatch:
            raise AssertionError("child dispatched after cancellation")
        raise RunCancelledError(f"{page_type.value} cancelled")

    monkeypatch.setattr(agent_class, "run", cancel)
    observer = _observer() if cancel_before_dispatch else None
    if observer is not None:
        observer.request_cancel("cancelled before child dispatch")

    with pytest.raises(RunCancelledError, match="cancelled"):
        await node(
            _pipeline_state(page_type, pending_key=pending_key),
            settings=Settings(),
            observer=observer,
            memory=None,
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_orchestrator_cancellation_bypasses_pipeline_failure_handler() -> None:
    observer = _observer()
    observer.request_cancel("cancel orchestration")

    class CancelGraph:
        async def astream(self, state):
            raise RunCancelledError("cancel orchestration")
            yield  # pragma: no cover - makes this an async generator

    agent = object.__new__(OrchestratorAgent)
    agent.settings = Settings(memory_enabled=False)
    agent.observer = observer
    agent.graph = CancelGraph()

    with pytest.raises(RunCancelledError, match="cancel orchestration"):
        await agent.run(URL)

    trace = observer.trace()
    assert trace.completed is False
    assert "pipeline_failed" not in [event.kind for event in trace.events]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_tool_batch_checks_cancellation_before_each_call() -> None:
    observer = _observer("hosting")
    tool_calls: list[str] = []

    class FakeLlm:
        model = "gemini-2.5-flash"

        def bind_tools(self, tools):
            return self

        async def ainvoke(self, messages, **kwargs):
            return AIMessage(
                content="",
                tool_calls=[
                    {"name": "cancel", "args": {}, "id": "call-1", "type": "tool_call"},
                    {"name": "must_not_run", "args": {}, "id": "call-2", "type": "tool_call"},
                ],
            )

    class FakeTool:
        def __init__(self, name: str) -> None:
            self.name = name

        async def ainvoke(self, args):
            tool_calls.append(self.name)
            if self.name == "cancel":
                observer.request_cancel("cancel after first tool")
            return {"ok": True}

    with pytest.raises(RunCancelledError, match="cancel after first tool"):
        await run_agent_loop(
            Settings(context_continuation_enabled=False),
            FakeLlm(),
            [FakeTool("cancel"), FakeTool("must_not_run")],
            "system",
            "task",
            observer=observer,
        )

    assert tool_calls == ["cancel"]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_worker_tracks_claimed_job_before_execution(monkeypatch) -> None:
    run_id = f"worker-{uuid.uuid4()}"
    started = asyncio.Event()
    jobs = iter([{"run_id": run_id}, None])

    async def execute(job):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(
        api_app,
        "get_settings",
        lambda: SimpleNamespace(background_job_concurrency=1),
    )
    monkeypatch.setattr(api_app, "_claim_background_job", lambda: next(jobs))
    monkeypatch.setattr(api_app, "_execute_background_job", execute)
    worker = asyncio.create_task(api_app._background_worker_loop())
    try:
        await asyncio.wait_for(started.wait(), timeout=1)
        assert api_app._active_run_tasks[run_id] is not worker
    finally:
        worker.cancel()
        await worker
        api_app._active_run_tasks.pop(run_id, None)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_cooperative_workflow_cancellation_finishes_as_cancelled(monkeypatch) -> None:
    started = asyncio.Event()
    run_id = f"workflow-{uuid.uuid4()}"

    async def run_pipeline(*, url, settings, observer):
        started.set()
        while not observer.is_cancel_requested():
            await asyncio.sleep(0)
        return PipelineResult(
            run_id=observer.run_id,
            url=url,
            final_status=ExtractionStatus.SUCCESS,
        )

    monkeypatch.setattr("src.agents.orchestrator.run_pipeline", run_pipeline)
    monkeypatch.setattr(api_app, "_persist_trace_snapshot", lambda *args, **kwargs: None)
    task = asyncio.create_task(api_app._background_workflow(run_id, URL))
    await asyncio.wait_for(started.wait(), timeout=1)

    assert run_registry.request_cancel(run_id, reason="operator cancelled") is True
    execution = await asyncio.wait_for(task, timeout=1)
    trace = run_registry.get(run_id)

    assert execution["cancelled"] is True
    assert trace is not None and trace.completed is True
    assert trace.metrics is not None and trace.metrics.failure_mode == "cancelled"
    assert api_app._active_trace_row(trace)["status"] == "cancelled"
    assert "pipeline_finished" not in [event.kind for event in trace.events]
