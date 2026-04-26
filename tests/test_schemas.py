"""Pydantic model validation tests."""

import pytest
from pydantic import ValidationError

from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import (
    ClassificationResult,
    ExtractionResult,
    MatchInfo,
    PipelineResult,
    ServerResult,
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


def test_match_info_defaults_to_stream_extractor():
    match = MatchInfo(url="https://example.com/watch/1")
    assert match.route == "stream_extractor"


def test_server_result_preserves_optional_evidence_fields():
    server = ServerResult(
        label="Server 1",
        embedded_url_source="dom_iframe",
        player_iframe_url="https://embed.example.com/player/1",
        stream_urls=["https://cdn.example.com/master.m3u8"],
        activation_attempts=1,
        player_state="playing",
        visual_confirmation="video playing",
        extraction_method="cdp_network",
        network_diagnostics=[{"url": "https://cdn.example.com/master.m3u8"}],
        iframe_diagnostics=[{"url": "https://embed.example.com/player/1"}],
    )
    assert server.player_iframe_url == "https://embed.example.com/player/1"
    assert server.embedded_url_source == "dom_iframe"
    assert server.network_diagnostics[0]["url"] == "https://cdn.example.com/master.m3u8"
