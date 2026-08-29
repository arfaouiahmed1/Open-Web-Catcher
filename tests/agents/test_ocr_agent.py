"""Unit tests for the OCR agent skeleton (plan T16 / U17).

Covers:
- pluggable ChannelEmbeddingIndex seam: stub-index matches flow through the
  merge logic (never hardcoded);
- seed-list token matching from OCR text;
- noisy-or confidence merge for agreeing/disagreeing evidence;
- graceful degradation when pytesseract/Pillow are missing (explicit
  ImportError simulation), when the screenshot cannot be loaded, and when
  nothing clears ocr_min_confidence;
- ocr_enabled=False short-circuit;
- orchestrator classify_node wiring: metadata enrichment + failure tolerance.
"""

import base64
import sys
from typing import Any

import pytest

from src.agents.ocr_agent import (
    ChannelEmbeddingIndex,
    OcrAgent,
    StubEmbeddingIndex,
    merge_candidates,
)
from src.agents.orchestrator import classify_node, route_after_classification
from src.models.enums import Confidence, ExtractionStatus, PageType, AgentType
from src.models.schemas import ClassificationResult, ExtractionResult, OcrResult
from src.utils.config import Settings

URL = "https://target.example/watch/1"
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
)


class RecordingIndex:
    """Stub embedding index returning canned matches and recording calls."""

    def __init__(self, matches: list[tuple[str, float]]) -> None:
        self.matches = matches
        self.embeddings_seen: list[list[float]] = []

    def find_matches(self, image_embedding: list[float]) -> list[tuple[str, float]]:
        self.embeddings_seen.append(image_embedding)
        return self.matches


class FakeObserver:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    def emit(self, event: str, message: str, **kwargs: Any) -> None:
        self.events.append({"event": event, "message": message, **kwargs})


def _classification(
    page_type: PageType = PageType.HOSTING,
    confidence: Confidence = Confidence.HIGH,
) -> ClassificationResult:
    return ClassificationResult(
        url=URL, page_type=page_type, confidence=confidence, confidence_source="parsed"
    )


def _local_screenshot(tmp_path, name: str = "shot.png") -> str:
    path = tmp_path / name
    path.write_bytes(PNG_1X1)
    return str(path)


@pytest.mark.unit
def test_stub_index_satisfies_channel_embedding_protocol() -> None:
    assert isinstance(StubEmbeddingIndex(), ChannelEmbeddingIndex)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_stub_index_match_flows_through_merge(tmp_path, monkeypatch) -> None:
    # No pytesseract available in this environment path: block both optional deps.
    monkeypatch.setitem(sys.modules, "pytesseract", None)
    monkeypatch.setitem(sys.modules, "PIL", None)
    index = RecordingIndex([("Sky Sports Main Event", 0.62)])
    agent = OcrAgent(Settings(), embedding_index=index, seed_path=tmp_path / "absent.json")
    observer = FakeObserver()

    result = await agent.run(_local_screenshot(tmp_path), observer=observer)

    assert isinstance(result, OcrResult)
    assert result.channel_label == "Sky Sports Main Event"
    assert result.candidates == ["Sky Sports Main Event"]
    assert result.confidence == pytest.approx(0.62)
    assert result.method == "ocr"
    assert result.ocr_text == ""
    assert index.embeddings_seen == [[]]  # placeholder encoder without Pillow
    events = [event["event"] for event in observer.events]
    assert events == ["agent_started", "agent_finished"]


@pytest.mark.unit
@pytest.mark.asyncio
async def test_seed_token_match_from_ocr_text(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "src.agents.ocr_agent._ocr_text", lambda _bytes: "LIVE NOW beIN SPORTS 1 HD"
    )
    agent = OcrAgent(Settings(), embedding_index=StubEmbeddingIndex())

    result = await agent.run(_local_screenshot(tmp_path))

    assert result.channel_label == "beIN Sports 1"
    assert result.candidates == ["beIN Sports 1"]
    assert result.confidence == pytest.approx(0.75)
    assert "bein sports 1" in result.ocr_text.lower()


@pytest.mark.unit
def test_merge_candidates_noisy_or_boosts_agreement_keeps_disagreement_max() -> None:
    merged = dict(
        merge_candidates({"DAZN": 0.75}, [("DAZN", 0.60), ("ESPN", 0.40)])
    )
    assert merged["DAZN"] == pytest.approx(0.9)  # 1 - 0.25*0.4
    assert merged["ESPN"] == pytest.approx(0.40)
    scores = [score for _label, score in merge_candidates({"A": 0.5}, [("B", 0.9)])]
    assert scores == sorted(scores, reverse=True)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_agreeing_sources_boost_confidence_above_each_alone(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "src.agents.ocr_agent._ocr_text", lambda _bytes: "welcome to DAZN"
    )
    agent = OcrAgent(
        Settings(), embedding_index=RecordingIndex([("DAZN", 0.60)])
    )

    result = await agent.run(_local_screenshot(tmp_path))

    assert result.channel_label == "DAZN"
    assert result.confidence == pytest.approx(0.9)
    assert result.confidence > 0.75


@pytest.mark.unit
@pytest.mark.asyncio
async def test_pytesseract_import_error_degrades_to_empty_text_without_failure(
    tmp_path, monkeypatch
) -> None:
    monkeypatch.setitem(sys.modules, "pytesseract", None)
    monkeypatch.setitem(sys.modules, "PIL", None)
    agent = OcrAgent(Settings(), embedding_index=StubEmbeddingIndex())

    result = await agent.run(_local_screenshot(tmp_path))

    assert result.ocr_text == ""
    assert result.channel_label == ""
    assert result.candidates == []
    assert result.confidence == 0.0


@pytest.mark.unit
@pytest.mark.asyncio
async def test_unloadable_screenshot_ref_degrades_gracefully(tmp_path) -> None:
    agent = OcrAgent(Settings())
    missing = await agent.run(str(tmp_path / "does-not-exist.png"))
    empty = await agent.run("")
    assert missing.channel_label == "" and missing.confidence == 0.0
    assert empty.channel_label == "" and empty.source_screenshot_url == ""


@pytest.mark.unit
@pytest.mark.asyncio
async def test_min_confidence_threshold_filters_weak_matches(tmp_path, monkeypatch) -> None:
    monkeypatch.setitem(sys.modules, "pytesseract", None)
    monkeypatch.setitem(sys.modules, "PIL", None)
    agent = OcrAgent(
        Settings(ocr_min_confidence=0.9),
        embedding_index=RecordingIndex([("ESPN", 0.5)]),
        seed_path=tmp_path / "absent.json",
    )

    result = await agent.run(_local_screenshot(tmp_path))

    assert result.candidates == []
    assert result.channel_label == ""
    assert result.confidence == 0.0


@pytest.mark.unit
@pytest.mark.asyncio
async def test_ocr_enabled_false_short_circuits_before_image_load(tmp_path) -> None:
    index = RecordingIndex([("DAZN", 0.99)])
    agent = OcrAgent(Settings(ocr_enabled=False), embedding_index=index)

    result = await agent.run(_local_screenshot(tmp_path))

    assert result == OcrResult(source_screenshot_url=result.source_screenshot_url)
    assert index.embeddings_seen == []


@pytest.mark.unit
@pytest.mark.asyncio
async def test_classify_node_enriches_classification_metadata_with_ocr(monkeypatch) -> None:
    async def fake_run(self, url, observer=None, *, instruction_override=None):
        return _classification()

    async def fake_ocr_run(self, screenshot_ref, observer=None):
        return OcrResult(
            channel_label="SSC Sport",
            candidates=["SSC Sport"],
            confidence=0.81,
            source_screenshot_url=screenshot_ref,
            ocr_text="ssc sport 1",
        )

    monkeypatch.setattr("src.agents.classification.ClassificationAgent.run", fake_run)
    monkeypatch.setattr("src.agents.ocr_agent.OcrAgent.run", fake_ocr_run)

    state = {
        "url": URL,
        "extraction_results": [
            ExtractionResult(
                url=URL,
                page_type=PageType.HOSTING,
                status=ExtractionStatus.SUCCESS,
                agent_type=AgentType.HOSTING_PAGE,
                screenshots=["https://res.cloudinary.example/demo/shot.png"],
            )
        ],
    }
    update = await classify_node(state, settings=Settings(), observer=None)

    assert update["classification"].metadata["ocr"]["channel_label"] == "SSC Sport"
    assert update["classification"].metadata["ocr"]["confidence"] == pytest.approx(0.81)
    assert route_after_classification({"classification": update["classification"]}) == (
        "queue_root_hosting"
    )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_classify_node_survives_ocr_failure(monkeypatch) -> None:
    async def fake_run(self, url, observer=None, *, instruction_override=None):
        return _classification()

    async def exploding_ocr_run(self, screenshot_ref, observer=None):
        raise RuntimeError("embedding backend down")

    monkeypatch.setattr("src.agents.classification.ClassificationAgent.run", fake_run)
    monkeypatch.setattr("src.agents.ocr_agent.OcrAgent.run", exploding_ocr_run)

    state = {
        "url": URL,
        "extraction_results": [
            ExtractionResult(
                url=URL,
                page_type=PageType.HOSTING,
                status=ExtractionStatus.SUCCESS,
                agent_type=AgentType.HOSTING_PAGE,
                screenshots=["https://res.cloudinary.example/demo/shot.png"],
            )
        ],
    }

    update = await classify_node(state, settings=Settings(), observer=None)

    assert "ocr" not in update["classification"].metadata
    assert update["classification"].page_type == PageType.HOSTING
    assert update["error"] == ""


@pytest.mark.unit
@pytest.mark.asyncio
async def test_classify_node_skips_ocr_when_disabled_or_no_screenshots(monkeypatch) -> None:
    async def fake_run(self, url, observer=None, *, instruction_override=None):
        return _classification()

    constructed: list[Any] = []

    def failing_factory(settings, **kwargs):
        constructed.append(settings)
        raise AssertionError("OcrAgent must not be constructed")

    monkeypatch.setattr("src.agents.classification.ClassificationAgent.run", fake_run)
    monkeypatch.setattr("src.agents.ocr_agent.OcrAgent", failing_factory)

    disabled = await classify_node(
        {"url": URL, "extraction_results": []},
        settings=Settings(ocr_enabled=True),
        observer=None,
    )
    off = await classify_node(
        {
            "url": URL,
            "extraction_results": [
                ExtractionResult(
                    url=URL,
                    page_type=PageType.HOSTING,
                    status=ExtractionStatus.SUCCESS,
                    agent_type=AgentType.HOSTING_PAGE,
                    screenshots=["https://res.cloudinary.example/demo/shot.png"],
                )
            ],
        },
        settings=Settings(ocr_enabled=False),
        observer=None,
    )

    assert constructed == []
    assert "ocr" not in disabled["classification"].metadata
    assert "ocr" not in off["classification"].metadata
