"""Validator node tests (plan T24 / VAL-C1/C2, U10, D14).

Covers:
- mandatory reachability probe: HEAD with short-GET fallback, recorded HTTP via
  httpx.MockTransport; unreachable (hallucinated-but-well-formed) URLs are
  flagged and dropped BEFORE the provider stage;
- LLM-as-judge produces a typed JudgeVerdict from a mocked verdict; judge-
  flagged URLs are dropped from the evidence set;
- bounded replan fires exactly once per stage, then the run degrades gracefully
  to analyze_providers;
- conservative fallback when the judge output is unparseable;
- graph wiring: every extraction fan-in edge lands on validate_evidence.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import httpx
import pytest

from src.agents.orchestrator import (
    build_graph,
    route_after_validate_evidence,
    validate_evidence_node,
)
from src.agents.validator import MAX_REPLANS_PER_STAGE, ValidatorAgent
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.hosting import ExtractionResult, StreamURL
from src.models.judge import JudgeVerdict, ValidationReport
from src.utils.config import Settings
from src.utils.observability import ObservabilityStatus, RunObserver, RunRegistry

URL = "https://target.example/watch/1"
GOOD_STREAM = "https://cdn.target.example/live/master.m3u8"
HALLUCINATED_STREAM = "https://fake-cdn.example-host.net/live/master.m3u8"


# ── Fixtures / helpers ───────────────────────────────────────────────────────


def _observer() -> RunObserver:
    status = ObservabilityStatus(
        enabled=True,
        project="test",
        default_dataset_name="test-ds",
    )
    return RunRegistry().create(
        run_id="run-t24", root_actor="orchestrator", observability=status
    )


def _extraction_result(stream_urls: list[str]) -> ExtractionResult:
    return ExtractionResult(
        url=URL,
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.ORCHESTRATOR,
        streams=[StreamURL(url=u) for u in stream_urls],
    )


def _verdict(**overrides: object) -> JudgeVerdict:
    base = {
        "verdict": "pass",
        "evidence_score": 0.9,
        "playback_confidence": 0.85,
        "channel_match": True,
        "reasoning": "reachable streams backed by screenshots",
        "required_fixes": [],
        "flagged_urls": [],
    }
    base.update(overrides)
    return JudgeVerdict(**base)


class _FakeJudgeLLM:
    """Stands in for the LiteLLM chat model; returns a scripted JSON verdict."""

    def __init__(self, payload: str) -> None:
        self._payload = payload
        self.prompts: list[str] = []

    async def ainvoke(self, messages, **kwargs):  # noqa: ANN001, ARG002
        self.prompts.append(str(messages[0].content))
        return SimpleNamespace(content=self._payload)


def _recording_transport(
    *,
    ok_urls: set[str],
) -> tuple[httpx.MockTransport, list[httpx.Request]]:
    """HEAD→200 for ok_urls; everything else raises like an unresolvable host."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if str(request.url) in ok_urls:
            return httpx.Response(200, text="ok")
        raise httpx.ConnectError("DNS resolution failed", request=request)

    return httpx.MockTransport(handler), seen


def _install_validator_mocks(
    monkeypatch: pytest.MonkeyPatch,
    *,
    transport: httpx.MockTransport,
    llm_payload: str | None = None,
    llm: object | None = None,
) -> None:
    """Route validator probes through the recorded transport and fake the LLM."""
    real_client = httpx.AsyncClient

    def client_factory(**kwargs: object) -> httpx.AsyncClient:
        kwargs["transport"] = transport
        return real_client(**kwargs)

    monkeypatch.setattr("src.agents.validator.httpx.AsyncClient", client_factory)

    if llm is None and llm_payload is not None:
        llm = _FakeJudgeLLM(llm_payload)
    if llm is not None:
        monkeypatch.setattr("src.agents.validator.build_llm", lambda **_: llm)


def _state(extraction_results: list[ExtractionResult], *, attempts: int = 0) -> dict:
    return {
        "url": URL,
        "extraction_results": extraction_results,
        "validator_replan_attempts": attempts,
    }


# ── Reachability probe ───────────────────────────────────────────────────────


@pytest.mark.unit
@pytest.mark.asyncio
async def test_probe_reachable_url_records_head_and_latency() -> None:
    transport, _seen = _recording_transport(ok_urls={GOOD_STREAM})
    agent = ValidatorAgent(Settings())

    probes = await agent.probe_reachability([GOOD_STREAM], transport=transport)

    (probe,) = probes
    assert probe.url == GOOD_STREAM
    assert probe.reachable is True
    assert probe.method == "HEAD"
    assert probe.status_code == 200
    assert probe.latency_ms >= 0.0
    assert probe.error == ""


@pytest.mark.unit
@pytest.mark.asyncio
async def test_probe_head_405_falls_back_to_short_get() -> None:
    methods: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        methods.append(request.method)
        if request.method == "HEAD":
            return httpx.Response(405)
        return httpx.Response(200, content=b"x" * 4096)

    agent = ValidatorAgent(Settings())
    probes = await agent.probe_reachability(
        [GOOD_STREAM], transport=httpx.MockTransport(handler)
    )

    (probe,) = probes
    assert probe.reachable is True
    assert probe.method == "GET"
    assert methods == ["HEAD", "GET"]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_probe_unreachable_hallucinated_url_is_flagged() -> None:
    transport, _seen = _recording_transport(ok_urls=set())
    agent = ValidatorAgent(Settings())

    probes = await agent.probe_reachability([HALLUCINATED_STREAM], transport=transport)

    (probe,) = probes
    assert probe.reachable is False
    assert "ConnectError" in probe.error


@pytest.mark.unit
def test_request_replan_budget_is_one_per_stage() -> None:
    agent = ValidatorAgent(Settings())
    first = agent.request_replan(stage="validate_evidence", reason="weak", attempt=0)
    assert first is not None
    assert first.attempt == 1
    assert MAX_REPLANS_PER_STAGE == 1
    assert agent.request_replan(stage="validate_evidence", reason="again", attempt=1) is None


# ── Judge scoring ─────────────────────────────────────────────────────────────


@pytest.mark.unit
@pytest.mark.asyncio
async def test_score_evidence_parses_mocked_verdict_into_judgeverdict() -> None:
    payload = json.dumps(
        {
            "verdict": "pass",
            "evidence_score": 0.88,
            "playback_confidence": 0.7,
            "channel_match": True,
            "reasoning": "ok",
            "required_fixes": [],
            "flagged_urls": [],
        }
    )
    llm = _FakeJudgeLLM(payload)
    agent = ValidatorAgent(Settings())

    verdict = await agent.score_evidence(
        infringing_url=URL,
        stream_records=[{"url": GOOD_STREAM, "protocol": "hls", "channel_name": "SSC"}],
        screenshot_count=2,
        probe_outcomes={GOOD_STREAM: True},
        llm=llm,
    )

    assert isinstance(verdict, JudgeVerdict)
    assert verdict.verdict == "pass"
    assert verdict.evidence_score == pytest.approx(0.88)
    # The judge prompt must carry the probe outcomes (grounding, U10).
    assert "probe_reachable=True" in llm.prompts[0]
    assert GOOD_STREAM in llm.prompts[0]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_score_evidence_unparseable_output_yields_conservative_fallback() -> None:
    agent = ValidatorAgent(Settings())

    verdict = await agent.score_evidence(
        infringing_url=URL,
        stream_records=[],
        screenshot_count=0,
        llm=_FakeJudgeLLM("<not json at all{{"),
    )

    assert verdict.verdict == "replan"
    assert verdict.evidence_score == 0.0
    assert "judge_output_unparseable" in verdict.reasoning


# ── validate_evidence_node ────────────────────────────────────────────────────


@pytest.mark.unit
@pytest.mark.asyncio
async def test_hallucinated_well_formed_stream_dropped_before_provider_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Acceptance (T24): probed-unreachable URL never reaches analyze_providers."""
    transport, seen = _recording_transport(ok_urls={GOOD_STREAM})
    _install_validator_mocks(
        monkeypatch,
        transport=transport,
        llm_payload=json.dumps(_verdict().model_dump()),
    )
    observer = _observer()

    result = await validate_evidence_node(
        _state([_extraction_result([GOOD_STREAM, HALLUCINATED_STREAM])]),
        settings=Settings(),
        observer=observer,
    )
    report: ValidationReport = result["validation_report"]

    # The hallucinated-but-well-formed URL was flagged AND dropped.
    assert report.dropped_streams == [HALLUCINATED_STREAM]
    assert report.kept_streams == [GOOD_STREAM]
    surviving_streams = [
        stream.url for extraction in result["extraction_results"] for stream in extraction.streams
    ]
    assert surviving_streams == [GOOD_STREAM]
    # Probe actually hit both URLs over recorded HTTP before judging.
    probed_hosts = {request.url.host for request in seen}
    assert probed_hosts == {"cdn.target.example", "fake-cdn.example-host.net"}
    assert route_after_validate_evidence({"validation_report": report}) == "analyze_providers"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_judge_flagged_url_dropped_even_when_reachable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    suspicious = "https://mirror-suspicious.example/stream.m3u8"
    payload = _verdict(flagged_urls=[suspicious], evidence_score=0.75).model_dump()
    transport, _seen = _recording_transport(ok_urls={GOOD_STREAM, suspicious})
    _install_validator_mocks(monkeypatch, transport=transport, llm_payload=json.dumps(payload))

    result = await validate_evidence_node(
        _state([_extraction_result([GOOD_STREAM, suspicious])]),
        settings=Settings(),
        observer=None,
    )
    report: ValidationReport = result["validation_report"]

    assert report.dropped_streams == [suspicious]
    assert report.kept_streams == [GOOD_STREAM]
    assert report.passed is True
    assert report.verdict is not None and report.verdict.flagged_urls == [suspicious]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_bounded_replan_fires_exactly_once_then_degrades(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, _seen = _recording_transport(ok_urls={GOOD_STREAM})
    failing = json.dumps(
        _verdict(verdict="fail", evidence_score=0.2, channel_match=False).model_dump()
    )
    _install_validator_mocks(monkeypatch, transport=transport, llm_payload=failing)
    settings = Settings()
    observer = _observer()

    first = await validate_evidence_node(
        _state([_extraction_result([GOOD_STREAM])], attempts=0),
        settings=settings,
        observer=observer,
    )
    report_first: ValidationReport = first["validation_report"]
    assert report_first.passed is False
    assert report_first.replan is not None
    assert report_first.replan.attempt == 1
    assert first["validator_replan_attempts"] == 1
    assert first["pending_hosting_urls"] == [URL]
    assert route_after_validate_evidence({"validation_report": report_first}) == "hosting_page"

    replan_events = [
        e
        for e in observer.trace().events
        if e.message == "Evidence validation failed; bounded replan queued"
    ]
    assert len(replan_events) == 1

    # Second visit: budget spent → no new replan, graceful degrade forward.
    second = await validate_evidence_node(
        _state([_extraction_result([GOOD_STREAM])], attempts=1),
        settings=settings,
        observer=None,
    )
    report_second: ValidationReport = second["validation_report"]
    assert report_second.replan is None
    assert second["validator_replan_attempts"] == 1
    assert second["pending_hosting_urls"] == []
    assert route_after_validate_evidence({"validation_report": report_second}) == (
        "analyze_providers"
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_no_streams_still_produces_report_and_routes_forward(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transport, seen = _recording_transport(ok_urls=set())
    _install_validator_mocks(
        monkeypatch,
        transport=transport,
        llm_payload=json.dumps(_verdict().model_dump()),
    )

    result = await validate_evidence_node(
        # Replan budget already spent: the gate degrades gracefully forward
        # instead of looping back to hosting_page with nothing to probe.
        _state([_extraction_result([])], attempts=1),
        settings=Settings(),
        observer=None,
    )
    report: ValidationReport = result["validation_report"]

    assert seen == []  # nothing to probe, nothing was hit
    assert report.kept_streams == []
    assert route_after_validate_evidence({"validation_report": report}) == "analyze_providers"


# ── Graph wiring ──────────────────────────────────────────────────────────────


@pytest.mark.unit
def test_graph_fans_in_through_validate_evidence() -> None:
    settings = Settings()
    settings.memory_enabled = False
    compiled = build_graph(settings)

    assert "validate_evidence" in compiled.nodes
    edges = {(edge.source, edge.target) for edge in compiled.get_graph().edges}
    for fan_in_source in ("classify", "landing_page", "hosting_page", "embedded_page"):
        assert (fan_in_source, "validate_evidence") in edges, fan_in_source
    assert ("validate_evidence", "analyze_providers") in edges
    assert ("validate_evidence", "hosting_page") in edges
