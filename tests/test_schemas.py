"""Pydantic model validation tests."""

import pytest
from pydantic import ValidationError

from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import (
    ClassificationResult,
    ExtractionResult,
    PipelineResult,
    StreamURL,
)


def test_classification_result_valid():
    r = ClassificationResult(
        url="https://example.com",
        page_type=PageType.LANDING,
        confidence=Confidence.HIGH,
        reasoning="Catalog page with many links.",
    )
    assert r.page_type == PageType.LANDING
    assert r.confidence == Confidence.HIGH


def test_classification_result_defaults():
    r = ClassificationResult(url="https://x.com", page_type=PageType.UNKNOWN, confidence=Confidence.LOW)
    assert r.reasoning == ""


def test_stream_url_defaults():
    s = StreamURL(url="https://cdn.example.com/stream.m3u8")
    assert s.protocol == ""
    assert s.quality == ""


def test_extraction_result_streams():
    r = ExtractionResult(
        url="https://example.com",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        streams=[StreamURL(url="https://cdn.example.com/s.m3u8", protocol="hls")],
    )
    assert len(r.streams) == 1
    assert r.streams[0].protocol == "hls"


def test_pipeline_result_no_extraction():
    r = PipelineResult(run_id="abc", url="https://example.com")
    assert r.final_status == ExtractionStatus.FAILED
    assert r.streams == []
