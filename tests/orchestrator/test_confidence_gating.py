"""Unit tests for classification confidence gating (plan T26 / VAL-H4, VAL-L10).

Covers:
- LOW-confidence classifications retry once inside classify_node, then terminate
  at the no_target stop-path instead of the analyze_providers dead end;
- parse-failure verdicts (confidence_source="fallback" on UNKNOWN) are gated
  differently from genuine UNKNOWN judgments;
- heuristic_default confidences are excluded from gating;
- thresholds come from Settings.
"""

import pytest

from src.agents.classification import _parse_output
from src.agents.orchestrator import (
    _build_pipeline_result,
    _confidence_gate_thresholds,
    classify_node,
    no_target_node,
    route_after_classification,
)
from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import ClassificationResult, ExtractionResult, StreamURL
from src.utils.config import Settings

URL = "https://target.example/watch/1"


def _classification(
    page_type: PageType,
    confidence: Confidence,
    *,
    source: str = "parsed",
    reasoning: str = "",
) -> ClassificationResult:
    return ClassificationResult(
        url=URL,
        page_type=page_type,
        confidence=confidence,
        reasoning=reasoning,
        confidence_source=source,
    )


@pytest.mark.unit
@pytest.mark.parametrize(
    ("page_type", "confidence", "source", "expected"),
    [
        # HIGH/MEDIUM parsed verdicts route normally on page type.
        (PageType.HOSTING, Confidence.HIGH, "parsed", "queue_root_hosting"),
        (PageType.LANDING, Confidence.MEDIUM, "parsed", "landing_page"),
        (PageType.EMBEDDED, Confidence.HIGH, "parsed", "queue_root_embedded"),
        # LOW confidence is gated to the terminal no_target path.
        (PageType.LANDING, Confidence.LOW, "parsed", "no_target"),
        (PageType.HOSTING, Confidence.LOW, "fallback", "no_target"),
        # heuristic_default is excluded from gating: page type alone decides.
        (PageType.LANDING, Confidence.LOW, "heuristic_default", "landing_page"),
        # Genuine UNKNOWN keeps the legacy analyze_providers route...
        (PageType.UNKNOWN, Confidence.MEDIUM, "parsed", "analyze_providers"),
        (PageType.UNKNOWN, Confidence.HIGH, "parsed", "analyze_providers"),
        # ...while a parse-failure marker on UNKNOWN terminates instead.
        (PageType.UNKNOWN, Confidence.LOW, "fallback", "no_target"),
        (PageType.UNKNOWN, Confidence.HIGH, "fallback", "no_target"),
    ],
)
def test_route_after_classification_transition_table(
    page_type: PageType,
    confidence: Confidence,
    source: str,
    expected: str,
) -> None:
    state = {"classification": _classification(page_type, confidence, source=source)}
    assert route_after_classification(state) == expected


@pytest.mark.unit
def test_route_after_classification_missing_classification_legacy_guard() -> None:
    assert route_after_classification({"classification": None}) == "analyze_providers"


@pytest.mark.unit
def test_route_after_classification_embedded_site_shell_fallback_still_applies() -> None:
    state = {
        "classification": _classification(
            PageType.EMBEDDED,
            Confidence.HIGH,
            reasoning="autoplay background video with nav menu and cookie banner",
        )
    }
    assert route_after_classification(state) == "queue_root_hosting"


@pytest.mark.unit
def test_settings_thresholds_are_honored_by_the_real_router() -> None:
    strict = Settings(classification_confidence_gate_low=90)
    medium_landing = {
        "classification": _classification(PageType.LANDING, Confidence.MEDIUM)
    }
    assert route_after_classification(medium_landing) == "landing_page"
    assert route_after_classification(medium_landing, settings=strict) == "no_target"


@pytest.mark.unit
def test_gate_thresholds_clamp_high_below_low() -> None:
    assert _confidence_gate_thresholds(None) == (40, 70)
    assert _confidence_gate_thresholds(Settings(classification_confidence_gate_low=80)) == (80, 80)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_classify_node_retries_once_and_recovers(monkeypatch) -> None:
    calls: list[dict] = []

    async def fake_run(self, url, observer=None, *, instruction_override=None):
        calls.append({"url": url, "instruction_override": instruction_override})
        if len(calls) == 1:
            return _classification(PageType.UNKNOWN, Confidence.LOW, source="fallback")
        return _classification(PageType.HOSTING, Confidence.HIGH)

    monkeypatch.setattr("src.agents.classification.ClassificationAgent.run", fake_run)

    result = await classify_node({"url": URL}, settings=Settings(), observer=None)

    assert len(calls) == 2
    assert calls[0]["instruction_override"] is None
    assert "tiebreak" in (calls[1]["instruction_override"] or "").lower()
    assert result["classification"].page_type == PageType.HOSTING
    assert result["classification"].confidence == Confidence.HIGH
    assert (
        route_after_classification(
            {"classification": result["classification"]}, settings=Settings()
        )
        == "queue_root_hosting"
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_classify_node_low_after_retry_routes_to_no_target(monkeypatch) -> None:
    calls: list[dict] = []

    async def fake_run(self, url, observer=None, *, instruction_override=None):
        calls.append({"instruction_override": instruction_override})
        return _classification(PageType.LANDING, Confidence.LOW)

    monkeypatch.setattr("src.agents.classification.ClassificationAgent.run", fake_run)

    result = await classify_node({"url": URL}, settings=Settings(), observer=None)

    assert len(calls) == 2
    assert result["classification"].confidence == Confidence.LOW
    assert (
        route_after_classification(
            {"classification": result["classification"]}, settings=Settings()
        )
        == "no_target"
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_classify_node_high_confidence_skips_retry(monkeypatch) -> None:
    calls: list[dict] = []

    async def fake_run(self, url, observer=None, *, instruction_override=None):
        calls.append({})
        return _classification(PageType.EMBEDDED, Confidence.HIGH)

    monkeypatch.setattr("src.agents.classification.ClassificationAgent.run", fake_run)

    await classify_node({"url": URL}, settings=Settings(), observer=None)

    assert len(calls) == 1


@pytest.mark.unit
@pytest.mark.asyncio
async def test_no_target_node_marks_state_for_terminal_status() -> None:
    update = await no_target_node(
        {"classification": _classification(PageType.UNKNOWN, Confidence.LOW)}, observer=None
    )
    assert update["gate_no_target"] is True

    state = {
        "run_id": "run-1",
        "url": URL,
        "classification": _classification(PageType.UNKNOWN, Confidence.LOW),
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
        **update,
    }
    assert _build_pipeline_result(state).final_status == ExtractionStatus.NO_TARGET


@pytest.mark.unit
def test_pipeline_result_prefers_streams_over_gate_flag() -> None:
    extraction = ExtractionResult(
        url=URL,
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        streams=[StreamURL(url="https://cdn.example.com/master.m3u8", protocol="hls")],
    )
    state = {
        "run_id": "run-1",
        "url": URL,
        "classification": None,
        "matches": [],
        "extraction_results": [extraction],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
        "gate_no_target": True,
    }
    assert _build_pipeline_result(state).final_status == ExtractionStatus.SUCCESS


@pytest.mark.unit
def test_parse_output_json_contract_is_marked_parsed() -> None:
    text = (
        '{"page_type": "host_page", "confidence": "high", '
        '"reasoning": "player controls visible"}'
    )
    result = _parse_output(text, URL)
    assert result.page_type == PageType.HOSTING
    assert result.confidence_source == "parsed"


@pytest.mark.unit
def test_parse_output_regex_recovery_and_garbage_are_marked_fallback() -> None:
    regex_text = "CLASSIFICATION: landing_page\nCONFIDENCE: high\nREASONING:\ncards"
    recovered = _parse_output(regex_text, URL)
    assert recovered.page_type == PageType.LANDING
    assert recovered.confidence_source == "fallback"

    garbage = _parse_output("the model rambled without any contract markers", URL)
    assert garbage.page_type == PageType.UNKNOWN
    assert garbage.confidence == Confidence.LOW
    assert garbage.confidence_source == "fallback"
