"""Streaming role contracts (plan T28) — the five spike assertions.

Covers docs/architecture/streaming-role-contracts-spike.md §3:
(a) timeline overlap — first ``hosting_item_started`` precedes landing
    ``agent_finished``;
(b) no embedded enqueue on a clean hosting success;
(c) cancel during an active queue terminates within one tool call and the
    outcome is cancelled, not FAILED/TIMEOUT;
(d) a duplicate URL enqueued twice processes once;
(e) the restart sweep flips an orphaned running job to
    ``process_restart_orphan``.

All agents are scripted fakes — no live browser or network.
"""

from __future__ import annotations

import asyncio
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from src.agents.errors import RunCancelledError
from src.agents.orchestrator import (
    OrchestratorAgent,
    embedded_page_node,
    hosting_page_node,
    landing_page_node,
)
from src.agents.pools import EMBEDDED_ROLE, HOSTING_ROLE, RunPools
from src.models.common import EventKind
from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import (
    ClassificationResult,
    ExtractionResult,
    MatchInfo,
    ServerResult,
    StreamURL,
)
from src.utils.config import Settings
from src.utils.observability import ObservabilityStatus, RunRegistry, run_registry

ROOT_URL = "https://target.example/listing"
HOSTING_URL = "https://target.example/watch/ajax-groningen"
EMBED_URL = "https://embed.example/player/ajax-groningen"
STREAM_URL = "https://cdn.example.com/hls/master.m3u8"


def _observer(run_id: str):
    return RunRegistry().create(
        run_id=run_id,
        root_actor="orchestrator",
        observability=ObservabilityStatus(
            enabled=True, project="test", default_dataset_name="test-ds"
        ),
    )


def _settings(**overrides: Any) -> Settings:
    return Settings(max_parallel_hosting_pages=2, **overrides)


def _pipeline_state(**overrides: Any) -> dict[str, Any]:
    state: dict[str, Any] = {
        "url": ROOT_URL,
        "run_id": "t28",
        "classification": ClassificationResult(
            url=ROOT_URL, page_type=PageType.LANDING, confidence=Confidence.HIGH
        ),
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "invalid_items": [],
        "validation_report": None,
        "validator_replan_attempts": 0,
        "error": "",
        "gate_no_target": False,
    }
    state.update(overrides)
    return state


def _hosting_result(
    url: str,
    *,
    decision: str,
    streams: tuple[str, ...] = (),
    embedded: tuple[str, ...] = (),
) -> ExtractionResult:
    return ExtractionResult(
        url=url,
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS if streams else ExtractionStatus.PARTIAL,
        agent_type=AgentType.HOSTING_PAGE,
        streams=[StreamURL(url=s, protocol="", source_layer="fake") for s in streams],
        metadata={"decision": decision, "embedded_urls_for_processing": list(embedded)},
    )


def _match(url: str) -> MatchInfo:
    return MatchInfo(url=url, title="Ajax vs Groningen", team1="Ajax", team2="Groningen")


# ── (a) timeline overlap ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_hosting_item_starts_before_landing_agent_finishes(monkeypatch) -> None:
    obs = _observer("t28-overlap")
    pools = RunPools(run_id="t28-overlap", settings=_settings(), observer=obs)
    target_url = HOSTING_URL

    async def fake_landing(self, *, url, observer=None, orchestrator_handoff=""):
        # Simulate a streaming landing producer: the match is discovered and
        # enqueued while the landing agent is still running.
        match = _match(target_url)
        pools.register_match(match)
        pools.enqueue(HOSTING_ROLE, target_url, source="landing")
        await asyncio.sleep(0.25)  # hosting worker runs concurrently
        obs.emit("agent_finished", "landing agent finished", details={"agent": "landing"})
        return ExtractionResult(
            url=url,
            page_type=PageType.LANDING,
            status=ExtractionStatus.SUCCESS,
            agent_type=AgentType.LANDING_PAGE,
            metadata={"hosting_pages": [{"url": target_url}]},
        )

    async def fake_hosting(self, *, url, observer=None, orchestrator_handoff=""):
        await asyncio.sleep(0.01)
        return _hosting_result(url, decision="safe_exit", streams=(STREAM_URL,))

    monkeypatch.setattr("src.agents.landing_page.LandingPageAgent.run", fake_landing)
    monkeypatch.setattr("src.agents.hosting_page.HostingPageAgent.run", fake_hosting)

    try:
        landing_delta = await landing_page_node(
            _pipeline_state(),
            settings=_settings(),
            observer=obs,
            memory=None,
            pools_box=[pools],
        )
        drain_delta = await hosting_page_node(
            _pipeline_state(**landing_delta),
            settings=_settings(),
            observer=obs,
            memory=None,
            pools_box=[pools],
        )
    finally:
        await pools.aclose()

    events = obs.trace().events
    started = [e for e in events if e.kind == EventKind.HOSTING_ITEM_STARTED.value]
    landing_finished = [
        e for e in events if e.kind == EventKind.AGENT_FINISHED.value and e.actor == "orchestrator"
    ]
    assert started, "a hosting item must have started"
    assert landing_finished, "landing agent_finished event missing"
    # The overlap: hosting work began before the landing producer finished.
    assert started[0].seq < landing_finished[0].seq
    # And the early result was not lost by the drainer.
    drained_results = drain_delta["extraction_results"]
    hosting_results = [r for r in drained_results if r.page_type == PageType.HOSTING]
    assert [r.url for r in hosting_results] == [target_url]
    assert hosting_results[0].streams[0].url == STREAM_URL


# ── (b) clean success enqueues nothing ───────────────────────────────────


@pytest.mark.asyncio
async def test_clean_hosting_success_enqueues_nothing(monkeypatch) -> None:
    obs = _observer("t28-clean")
    pools = RunPools(run_id="t28-clean", settings=_settings(), observer=obs)

    async def fake_hosting(self, *, url, observer=None, orchestrator_handoff=""):
        return _hosting_result(url, decision="safe_exit", streams=(STREAM_URL,))

    monkeypatch.setattr("src.agents.hosting_page.HostingPageAgent.run", fake_hosting)

    try:
        result = await hosting_page_node(
            _pipeline_state(pending_hosting_urls=[HOSTING_URL]),
            settings=_settings(),
            observer=obs,
            memory=None,
            pools_box=[pools],
        )
        # Give any (wrongful) trigger a chance to land in the queue.
        await asyncio.sleep(0.05)
        assert pools.embedded_queue.empty()
        assert not pools.has_pending_work(EMBEDDED_ROLE)
    finally:
        await pools.aclose()

    assert result["pending_embedded_urls"] == []
    assert pools.embedded_enqueued_urls == []
    finished = [
        e for e in obs.trace().events if e.kind == EventKind.HOSTING_ITEM_FINISHED.value
    ]
    assert finished and finished[0].details["status"] == "success"


@pytest.mark.asyncio
async def test_explicit_trigger_enqueues_embedded_followup(monkeypatch) -> None:
    obs = _observer("t28-trigger")
    pools = RunPools(run_id="t28-trigger", settings=_settings(), observer=obs)

    async def fake_hosting(self, *, url, observer=None, orchestrator_handoff=""):
        return _hosting_result(url, decision="activation_failed", embedded=(EMBED_URL,))

    async def fake_embedded(self, *, url, observer=None, orchestrator_handoff=""):
        return ExtractionResult(
            url=url,
            page_type=PageType.EMBEDDED,
            status=ExtractionStatus.SUCCESS,
            agent_type=AgentType.EMBEDDED_PAGE,
            streams=[StreamURL(url=STREAM_URL, protocol="", source_layer="embedded")],
            metadata={"decision": "safe_exit"},
        )

    monkeypatch.setattr("src.agents.hosting_page.HostingPageAgent.run", fake_hosting)
    monkeypatch.setattr("src.agents.embedded_page.EmbeddedPageAgent.run", fake_embedded)

    try:
        host_delta = await hosting_page_node(
            _pipeline_state(pending_hosting_urls=[HOSTING_URL]),
            settings=_settings(),
            observer=obs,
            memory=None,
            pools_box=[pools],
        )
        assert host_delta["pending_embedded_urls"] == [EMBED_URL]
        embedded_delta = await embedded_page_node(
            _pipeline_state(extraction_results=host_delta["extraction_results"],
                            pending_embedded_urls=[EMBED_URL]),
            settings=_settings(),
            observer=obs,
            memory=None,
            pools_box=[pools],
        )
    finally:
        await pools.aclose()

    urls = [r.url for r in embedded_delta["extraction_results"]]
    assert HOSTING_URL in urls and EMBED_URL in urls


# ── (c) cancellation terminates cancelled, not FAILED/TIMEOUT ────────────


@pytest.mark.asyncio
async def test_cancel_during_active_queue_terminates_cancelled(monkeypatch) -> None:
    obs = _observer("t28-cancel")
    settings = _settings()
    agent = OrchestratorAgent(settings, observer=obs)

    async def fake_classification(self, url, observer=None, *, instruction_override=None):
        return ClassificationResult(
            url=url, page_type=PageType.HOSTING, confidence=Confidence.HIGH
        )

    async def fake_hosting(self, *, url, observer=None, orchestrator_handoff=""):
        # In-flight "tool loop": aborts as soon as cancel is requested.
        deadline = time.monotonic() + 10
        while not obs.is_cancel_requested():
            if time.monotonic() > deadline:
                raise AssertionError("cancel flag never observed by fake agent")
            await asyncio.sleep(0.005)
        raise RunCancelledError("test cancel")

    monkeypatch.setattr("src.agents.classification.ClassificationAgent.run", fake_classification)
    monkeypatch.setattr("src.agents.hosting_page.HostingPageAgent.run", fake_hosting)

    runner = asyncio.create_task(agent.run(ROOT_URL))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        if any(
            e.kind == EventKind.HOSTING_ITEM_STARTED.value
            for e in obs.trace().events
        ):
            break
        await asyncio.sleep(0.005)
    started_at = time.monotonic()
    assert obs.request_cancel("test cancel")

    with pytest.raises(RunCancelledError):
        await asyncio.wait_for(runner, timeout=5)
    elapsed = time.monotonic() - started_at
    # Within one tool call — nowhere near the workflow/agent deadlines.
    assert elapsed < 4

    finished = [
        e for e in obs.trace().events if e.kind == EventKind.HOSTING_ITEM_FINISHED.value
    ]
    # No laundering: nothing folded into a FAILED/TIMEOUT extraction.
    assert all(
        e.details.get("status") not in {"failed", "timeout"} for e in finished
    )


# ── (d) duplicate URL processes once ─────────────────────────────────────


@pytest.mark.asyncio
async def test_duplicate_url_processes_once(monkeypatch) -> None:
    obs = _observer("t28-dedupe")
    pools = RunPools(run_id="t28-dedupe", settings=_settings(), observer=obs)
    calls: list[str] = []

    async def fake_hosting(self, *, url, observer=None, orchestrator_handoff=""):
        calls.append(url)
        await asyncio.sleep(0.01)
        return _hosting_result(url, decision="safe_exit", streams=(STREAM_URL,))

    monkeypatch.setattr("src.agents.hosting_page.HostingPageAgent.run", fake_hosting)

    try:
        assert pools.enqueue(HOSTING_ROLE, HOSTING_URL, source="a") is True
        assert pools.enqueue(HOSTING_ROLE, HOSTING_URL, source="b") is False
        await pools.wait_until_drained(HOSTING_ROLE)
    finally:
        await pools.aclose()

    assert calls == [HOSTING_URL]
    assert len(pools.results) == 1
    state = pools._roles[HOSTING_ROLE]
    assert state.processed == 1
    assert state.duplicates_suppressed == 1
    drained = [e for e in obs.trace().events if e.kind == EventKind.POOL_DRAINED.value]
    assert drained and drained[0].details["processed"] == 1
    assert drained[0].details["duplicates_suppressed"] == 1


# ── (e) restart-orphan sweep ─────────────────────────────────────────────


@pytest.mark.unit
def test_restart_sweep_marks_process_restart_orphan(
    session_factory, monkeypatch
) -> None:  # noqa: ANN001
    from sqlalchemy import select

    from src.api.app import _recover_background_jobs
    from src.storage.models import BackgroundJobRecord, Base

    bind = session_factory.kw["bind"]
    Base.metadata.create_all(bind=bind)

    run_id = "t28-orphan-run"
    stale_moment = datetime.now(UTC) - timedelta(seconds=600)
    session = session_factory()
    try:
        session.add(
            BackgroundJobRecord(
                job_id="job-1",
                run_id=run_id,
                job_type="workflow",
                status="running",
                url=ROOT_URL,
                actor="tester",
                attempts=0,
                max_attempts=2,
                heartbeat_at=stale_moment,
                started_at=stale_moment,
            )
        )
        session.commit()
    finally:
        session.close()

    # A resident, unfinished trace: the console would spin forever without
    # the synthetic terminal event.
    registry_observer = run_registry.create(
        run_id=run_id,
        root_actor="orchestrator",
        observability=ObservabilityStatus(
            enabled=True, project="test", default_dataset_name="test-ds"
        ),
    )
    registry_observer.emit("pipeline_started", "started")

    monkeypatch.setattr("src.api.app.get_session", session_factory)

    recovered = _recover_background_jobs()
    assert recovered >= 1

    session = session_factory()
    try:
        row = session.execute(
            select(BackgroundJobRecord).where(BackgroundJobRecord.run_id == run_id)
        ).scalar_one()
        assert row.error_text == "process_restart_orphan"
    finally:
        session.close()

    trace = run_registry.get(run_id)
    assert trace is not None and trace.completed
    assert trace.metrics.failure_mode == "process_restart_orphan"
    kinds = [e.kind for e in trace.events]
    assert "pipeline_failed" in kinds


# ── Plan T34: typed notifications ─────────────────────────────────

# Reuse fixtures from the streaming-handoff suite above (_observer, _settings,
# _pipeline_state, _hosting_result, HOSTING_URL, STREAM_URL, EMBED_URL).


@pytest.mark.asyncio
async def test_hosting_page_discovered_emitted_on_enqueue() -> None:
    """RunPools emits ``hosting_page_discovered`` when a hosting target is
    freshly enqueued (deduplicated, so duplicates are silent)."""
    obs = _observer("t34-discover")
    pools = RunPools(run_id="t34-discover", settings=_settings(), observer=obs)
    try:
        first = pools.enqueue(HOSTING_ROLE, HOSTING_URL, source="landing")
        second = pools.enqueue(HOSTING_ROLE, HOSTING_URL, source="dup")
    finally:
        await pools.aclose()

    assert first is True
    assert second is False  # dedupe
    discovered = [e for e in obs.trace().events if e.kind == "hosting_page_discovered"]
    assert len(discovered) == 1
    assert discovered[0].details["url"] == HOSTING_URL
    assert discovered[0].details["source"] == "landing"


@pytest.mark.asyncio
async def test_server_activated_emitted_per_server(monkeypatch) -> None:
    """A worker that recovers servers emits ``server_activated`` per server."""
    obs = _observer("t34-server")
    pools = RunPools(run_id="t34-server", settings=_settings(), observer=obs)

    async def fake_hosting(self, *, url, observer=None, orchestrator_handoff=""):
        return ExtractionResult(
            url=url,
            page_type=PageType.HOSTING,
            status=ExtractionStatus.SUCCESS,
            agent_type=AgentType.HOSTING_PAGE,
            servers=[
                ServerResult(label="default", server_up=True, playback_confirmed=True),
                ServerResult(label="alt-1", server_up=False, down_reason="offline"),
            ],
        )

    monkeypatch.setattr("src.agents.hosting_page.HostingPageAgent.run", fake_hosting)
    try:
        await hosting_page_node(
            _pipeline_state(pending_hosting_urls=[HOSTING_URL]),
            settings=_settings(),
            observer=obs,
            memory=None,
            pools_box=[pools],
        )
        await asyncio.sleep(0.1)
    finally:
        await pools.aclose()

    activated = [e for e in obs.trace().events if e.kind == "server_activated"]
    assert len(activated) == 2
    labels = {e.details["server_label"] for e in activated}
    assert labels == {"default", "alt-1"}
    assert all(e.details["url"] == HOSTING_URL for e in activated)
    default = [e for e in activated if e.details["server_label"] == "default"][0]
    alt = [e for e in activated if e.details["server_label"] == "alt-1"][0]
    assert default.details["server_up"] is True
    assert default.details["playback_confirmed"] is True
    assert alt.details["server_up"] is False
    assert alt.details["down_reason"] == "offline"


@pytest.mark.asyncio
async def test_stream_extracted_emitted_with_quality(monkeypatch) -> None:
    """A worker that recovers streams emits ``stream_extracted`` with quality."""
    obs = _observer("t34-stream")
    pools = RunPools(run_id="t34-stream", settings=_settings(), observer=obs)
    async def fake_hosting(self, *, url, observer=None, orchestrator_handoff=""):
        return _hosting_result(url, decision="safe_exit", streams=(STREAM_URL,))

    monkeypatch.setattr("src.agents.hosting_page.HostingPageAgent.run", fake_hosting)
    try:
        await hosting_page_node(
            _pipeline_state(pending_hosting_urls=[HOSTING_URL]),
            settings=_settings(),
            observer=obs,
            memory=None,
            pools_box=[pools],
        )
        await asyncio.sleep(0.1)
    finally:
        await pools.aclose()

    extracted = [e for e in obs.trace().events if e.kind == "stream_extracted"]
    assert len(extracted) == 1
    assert extracted[0].details["url"] == HOSTING_URL
    assert extracted[0].details["stream_url"] == STREAM_URL
    assert extracted[0].details["protocol"] == "unknown"
    assert extracted[0].details["quality"] == "unknown"
