"""tests/models/test_browser_evidence.py

Contract tests for the v2 browser-evidence model additions.

Tests:
- EvidenceRef: all kinds, required fields, defaults, round-trip
- ClassificationResult: evidence field present, backward compat
- MatchInfo: evidence field present, backward compat
- StreamURL: new v2 fields present, defaults preserve old reads
- ServerResult: evidence field present, screenshot_url accepts blobref
- ExtractionResult: evidence field present

Run: uv run pytest tests/models/test_browser_evidence.py -q
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from src.models.classification import ClassificationResult
from src.models.common import (
    AgentType,
    Confidence,
    ExtractionStatus,
    PageType,
)
from src.models.evidence import EvidenceRef
from src.models.hosting import ExtractionResult, ServerResult, StreamURL
from src.models.landing import MatchInfo

# ---------------------------------------------------------------------------
# EvidenceRef
# ---------------------------------------------------------------------------

VALID_KINDS = [
    "screenshot",
    "network_entry",
    "dom_snapshot",
    "manifest_probe",
    "media_sample",
    "page_state",
]


class TestEvidenceRef:
    def _minimal(self, **overrides) -> dict:
        base = dict(
            kind="screenshot",
            tool_call_id="call-abc",
            page_state_id="ps-001",
            ref="blobref:deadbeef01234567",
        )
        base.update(overrides)
        return base

    def test_all_valid_kinds_accepted(self):
        for kind in VALID_KINDS:
            sample_ref = "blobref:x" if kind == "screenshot" else "https://example.com/m.m3u8"
            ref = EvidenceRef(**self._minimal(kind=kind, ref=sample_ref))
            assert ref.kind == kind

    def test_invalid_kind_rejected(self):
        with pytest.raises(ValidationError):
            EvidenceRef(**self._minimal(kind="unknown_kind"))

    def test_required_fields_enforced(self):
        for missing in ["kind", "tool_call_id", "page_state_id", "ref"]:
            data = self._minimal()
            del data[missing]
            with pytest.raises(ValidationError):
                EvidenceRef(**data)

    def test_summary_defaults_empty_string(self):
        ref = EvidenceRef(**self._minimal())
        assert ref.summary == ""

    def test_summary_preserved_when_supplied(self):
        ref = EvidenceRef(**self._minimal(summary="HLS master confirmed HTTP 200"))
        assert ref.summary == "HLS master confirmed HTTP 200"

    def test_captured_at_defaults_to_utc_now(self):
        before = datetime.now(UTC)
        ref = EvidenceRef(**self._minimal())
        after = datetime.now(UTC)
        assert before <= ref.captured_at <= after

    def test_extra_fields_rejected(self):
        with pytest.raises(ValidationError):
            EvidenceRef(**self._minimal(nonexistent_field="x"))

    def test_round_trip_json(self):
        original = EvidenceRef(**self._minimal(summary="test"))
        restored = EvidenceRef.model_validate_json(original.model_dump_json())
        assert restored.kind == original.kind
        assert restored.tool_call_id == original.tool_call_id
        assert restored.page_state_id == original.page_state_id
        assert restored.ref == original.ref
        assert restored.summary == original.summary


# ---------------------------------------------------------------------------
# ClassificationResult — backward compat + evidence field
# ---------------------------------------------------------------------------

class TestClassificationResultEvidence:
    def _minimal(self) -> dict:
        return dict(
            url="https://example.com/",
            page_type=PageType.UNKNOWN,
            confidence=Confidence.LOW,
            reasoning="test",
        )

    def test_evidence_defaults_to_empty_list(self):
        result = ClassificationResult(**self._minimal())
        assert result.evidence == []

    def test_evidence_accepts_list_of_evidence_refs(self):
        ref = EvidenceRef(
            kind="screenshot",
            tool_call_id="call-1",
            page_state_id="ps-1",
            ref="blobref:abc",
        )
        result = ClassificationResult(**self._minimal(), evidence=[ref])
        assert len(result.evidence) == 1
        assert result.evidence[0].kind == "screenshot"

    def test_old_reads_without_evidence_still_parse(self):
        data = self._minimal()
        # Simulate old persisted data — no evidence key
        result = ClassificationResult(**data)
        assert result.evidence == []

    def test_extra_fields_still_rejected(self):
        with pytest.raises(ValidationError):
            ClassificationResult(**self._minimal(), unknown_field="x")


# ---------------------------------------------------------------------------
# MatchInfo — backward compat + evidence field
# ---------------------------------------------------------------------------

class TestMatchInfoEvidence:
    def test_evidence_defaults_to_empty_list(self):
        m = MatchInfo(url="https://example.com/match/1")
        assert m.evidence == []

    def test_evidence_accepts_refs(self):
        ref = EvidenceRef(kind="page_state", tool_call_id="c1", page_state_id="ps-2", ref="ps-2")
        m = MatchInfo(url="https://example.com/match/1", evidence=[ref])
        assert m.evidence[0].kind == "page_state"

    def test_all_old_fields_still_work(self):
        m = MatchInfo(
            url="https://example.com/live/1",
            title="Match Title",
            status="live",
            confidence=85,
            route="stream_extractor",
        )
        assert m.title == "Match Title"
        assert m.status == "live"
        assert m.confidence == 85


# ---------------------------------------------------------------------------
# StreamURL — new v2 fields with backward-compat defaults
# ---------------------------------------------------------------------------

class TestStreamURLV2Fields:
    def test_old_fields_still_parse(self):
        s = StreamURL(url="https://cdn.example.com/stream.m3u8", protocol="hls")
        assert s.protocol == "hls"
        assert s.quality == ""

    def test_verified_defaults_false(self):
        s = StreamURL(url="https://cdn.example.com/stream.m3u8")
        assert s.verified is False

    def test_http_status_defaults_none(self):
        s = StreamURL(url="https://cdn.example.com/stream.m3u8")
        assert s.http_status is None

    def test_content_type_defaults_none(self):
        s = StreamURL(url="https://cdn.example.com/stream.m3u8")
        assert s.content_type is None

    def test_source_layers_defaults_empty(self):
        s = StreamURL(url="https://cdn.example.com/stream.m3u8")
        assert s.source_layers == []

    def test_frame_url_defaults_none(self):
        s = StreamURL(url="https://cdn.example.com/stream.m3u8")
        assert s.frame_url is None

    def test_sample_sha256_defaults_none(self):
        s = StreamURL(url="https://cdn.example.com/stream.m3u8")
        assert s.sample_sha256 is None

    def test_sample_bytes_defaults_none(self):
        s = StreamURL(url="https://cdn.example.com/stream.m3u8")
        assert s.sample_bytes is None

    def test_all_v2_fields_settable(self):
        s = StreamURL(
            url="https://cdn.example.com/stream.m3u8",
            protocol="hls",
            verified=True,
            http_status=200,
            content_type="application/x-mpegURL",
            source_layers=["network_ledger", "dom_scan"],
            frame_url="https://embed.example.com/player",
            sample_sha256="abc" * 21 + "a",  # 64 chars
            sample_bytes=65536,
        )
        assert s.verified is True
        assert s.http_status == 200
        assert s.content_type == "application/x-mpegURL"
        assert s.source_layers == ["network_ledger", "dom_scan"]
        assert s.sample_bytes == 65536

    def test_old_serialized_data_parses_without_new_fields(self):
        """Old persisted rows have no v2 fields; defaults must apply cleanly."""
        data = {"url": "https://cdn.example.com/old.m3u8", "protocol": "hls"}
        s = StreamURL(**data)
        assert s.verified is False
        assert s.http_status is None
        assert s.source_layers == []


# ---------------------------------------------------------------------------
# ServerResult — evidence field
# ---------------------------------------------------------------------------

class TestServerResultEvidence:
    def test_evidence_defaults_to_empty_list(self):
        s = ServerResult(label="server1")
        assert s.evidence == []

    def test_screenshot_url_accepts_blobref(self):
        s = ServerResult(label="server1", screenshot_url="blobref:deadbeef01234567")
        assert s.screenshot_url == "blobref:deadbeef01234567"

    def test_screenshot_url_accepts_legacy_cloudinary(self):
        url = "https://res.cloudinary.com/demo/image/upload/sample.jpg"
        s = ServerResult(label="server1", screenshot_url=url)
        assert s.screenshot_url == url

    def test_old_fields_unchanged(self):
        s = ServerResult(
            label="default",
            status="success",
            playback_confirmed=True,
            m3u8_urls=["https://cdn.example.com/stream.m3u8"],
        )
        assert s.status == "success"
        assert s.playback_confirmed is True
        assert len(s.m3u8_urls) == 1


# ---------------------------------------------------------------------------
# ExtractionResult — evidence field
# ---------------------------------------------------------------------------

class TestExtractionResultEvidence:
    def test_evidence_defaults_to_empty_list(self):
        r = ExtractionResult(
            url="https://example.com/",
            page_type=PageType.HOSTING,
            status=ExtractionStatus.SUCCESS,
            agent_type=AgentType.HOSTING_PAGE,
        )
        assert r.evidence == []

    def test_evidence_accepts_multiple_refs(self):
        refs = [
            EvidenceRef(
                kind="screenshot", tool_call_id=f"c{i}", page_state_id="ps-1", ref=f"blobref:x{i}"
            )
            for i in range(3)
        ]
        r = ExtractionResult(
            url="https://example.com/",
            page_type=PageType.HOSTING,
            status=ExtractionStatus.SUCCESS,
            agent_type=AgentType.HOSTING_PAGE,
            evidence=refs,
        )
        assert len(r.evidence) == 3

    def test_old_reads_parse_without_evidence(self):
        r = ExtractionResult(
            url="https://example.com/",
            page_type=PageType.EMBEDDED,
            status=ExtractionStatus.FAILED,
            agent_type=AgentType.EMBEDDED_PAGE,
        )
        assert r.evidence == []
