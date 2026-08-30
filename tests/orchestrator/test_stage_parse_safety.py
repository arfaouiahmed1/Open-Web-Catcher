"""Stage-parse safety unit tests (plan T15 / VAL-C1).

Covers:
- analyze_providers_node survives poisoned provider payloads: valid items are
  processed, malformed items land in ``invalid_items`` with stage/reason/
  preview, a structured skip event is emitted, and the node never raises;
- malformed (non-JSON) payloads take the ``repair_malformed_payload`` seam
  (returns None today — judge wiring lands in task 24) and are recorded as
  skipped instead of crashing or being silently swallowed;
- render_takedown_emails skips a failing per-item draft into the invalid
  sink while keeping the successfully rendered drafts;
- generate_takedown_emails_node never crashes at the final stage and always
  carries ``invalid_items`` through its state update.
"""

from __future__ import annotations

import json

import pytest

from src.agents.orchestrator import (
    analyze_providers_node,
    generate_takedown_emails_node,
    repair_malformed_payload,
)
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.hosting import ExtractionResult, StreamURL
from src.models.judge import ProviderInfo
from src.orchestrator.emailing import TakedownEmailRenderInput, render_takedown_emails
from src.utils.config import Settings
from src.utils.observability import ObservabilityStatus, RunObserver, RunRegistry

URL = "https://target.example/watch/1"
STREAM = "https://cdn.target.example/stream.m3u8"


def _observer() -> RunObserver:
    status = ObservabilityStatus(
        enabled=True,
        project="test",
        default_dataset_name="test-ds",
    )
    return RunRegistry().create(
        run_id="run-t15", root_actor="orchestrator", observability=status
    )


def _extraction_result() -> ExtractionResult:
    return ExtractionResult(
        url=URL,
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.ORCHESTRATOR,
        streams=[StreamURL(url=STREAM)],
    )


def _valid_provider_item() -> dict[str, object]:
    return {
        "stream_url": STREAM,
        "ip": "203.0.113.10",
        "org": "AS64500 ExampleHost",
        "abuse_email": "abuse@examplehost.test",
    }


class _FakeIPInfoTool:
    """Stands in for IPInfoTool; returns a scripted raw payload."""

    def __init__(self, payload: str) -> None:
        self._payload = payload
        self.ipinfo_token = ""

    async def _arun(self, stream_urls: list[str]) -> str:  # noqa: ARG002
        return self._payload


# ── Repair seam ──────────────────────────────────────────────────────────────


@pytest.mark.unit
def test_repair_malformed_payload_seam_returns_none() -> None:
    """Task 24 will wire the judge here; today the seam must return None."""
    assert repair_malformed_payload('{"not": "a list"') is None


# ── analyze_providers_node ───────────────────────────────────────────────────


@pytest.mark.unit
@pytest.mark.asyncio
async def test_poisoned_items_skipped_and_valid_processed(monkeypatch: pytest.MonkeyPatch) -> None:
    """Extra-field poison + non-dict junk are skipped; valid items survive."""
    poisoned = [
        _valid_provider_item(),
        {**_valid_provider_item(), "unexpected_field": "boom"},  # extra="forbid"
        "not-a-dict",
        {"stream_url": STREAM + ".2", "ip": "198.51.100.7"},
    ]
    monkeypatch.setattr(
        "src.agents.orchestrator.IPInfoTool",
        lambda **_: _FakeIPInfoTool(json.dumps(poisoned)),
    )
    observer = _observer()
    result = await analyze_providers_node(
        {"extraction_results": [_extraction_result()], "invalid_items": []},
        settings=Settings(),
        observer=observer,
    )

    providers: list[ProviderInfo] = result["provider_analysis"]
    assert [p.stream_url for p in providers] == [STREAM, STREAM + ".2"]

    invalid = result["invalid_items"]
    assert len(invalid) == 2
    stages = {entry["stage"] for entry in invalid}
    assert stages == {"analyze_providers"}
    assert all(entry["reason"] for entry in invalid)
    assert all(len(entry["item_preview"]) <= 300 for entry in invalid)

    skip_events = [
        e for e in observer.trace().events if e.message == "Stage parse skipped malformed items"
    ]
    assert len(skip_events) == 1
    details = skip_events[0].details
    assert details["skipped_count"] == 2
    assert details["skipped_item_previews"][0]["stage"] == "analyze_providers"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_malformed_json_records_skip_instead_of_crash_or_swallow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Non-JSON payload → seam returns None → structured skip event, no raise."""
    monkeypatch.setattr(
        "src.agents.orchestrator.IPInfoTool",
        lambda **_: _FakeIPInfoTool("<<<not json at all{{"),
    )
    observer = _observer()
    result = await analyze_providers_node(
        {"extraction_results": [_extraction_result()], "invalid_items": []},
        settings=Settings(),
        observer=observer,
    )

    assert result["provider_analysis"] == []
    (entry,) = result["invalid_items"]
    assert entry["stage"] == "analyze_providers"
    assert "not valid JSON" in entry["reason"]
    assert entry["item_preview"].startswith("<<<not json")

    messages = [e.message for e in observer.trace().events]
    assert "Stage parse skipped malformed items" in messages


@pytest.mark.unit
@pytest.mark.asyncio
async def test_clean_payload_emits_no_skip_event(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "src.agents.orchestrator.IPInfoTool",
        lambda **_: _FakeIPInfoTool(json.dumps([_valid_provider_item()])),
    )
    observer = _observer()
    result = await analyze_providers_node(
        {"extraction_results": [_extraction_result()], "invalid_items": []},
        settings=Settings(),
        observer=observer,
    )
    assert len(result["provider_analysis"]) == 1
    assert result["invalid_items"] == []
    assert not any(
        e.message == "Stage parse skipped malformed items" for e in observer.trace().events
    )


# ── Takedown-email render side ───────────────────────────────────────────────


@pytest.mark.unit
def test_render_takedown_emails_invalid_sink_skips_failing_draft(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A per-item render failure is sunk; other drafts still render."""
    params = TakedownEmailRenderInput(
        infringing_url=URL,
        extraction_results=[_extraction_result()],
        provider_analysis=[
            ProviderInfo(stream_url=STREAM, abuse_email="abuse@examplehost.test"),
            ProviderInfo(stream_url=STREAM + ".2", abuse_email="abuse2@examplehost.test"),
        ],
    )
    calls = {"n": 0}
    real_render_subject = __import__(
        "src.orchestrator.emailing", fromlist=["render_subject"]
    ).render_subject

    def flaky_render_subject(context, *, variant, version):  # noqa: ANN001, ARG001
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("template exploded")
        return real_render_subject(context, variant=variant, version=version)

    monkeypatch.setattr("src.orchestrator.emailing.render_subject", flaky_render_subject)

    sink: list[dict[str, object]] = []
    emails = render_takedown_emails(params, invalid_sink=sink)

    # One context per provider; the second render blew up but was skipped.
    assert len(emails) >= 1
    assert all(e.abuse_email != "abuse2@examplehost.test" for e in emails)
    (entry,) = sink
    assert entry["stage"] == "generate_takedown_emails"
    assert "RuntimeError" in entry["reason"]


@pytest.mark.unit
def test_render_takedown_emails_default_behavior_raises_on_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without a sink the historical raising behavior is preserved."""
    params = TakedownEmailRenderInput(
        infringing_url=URL,
        extraction_results=[_extraction_result()],
        provider_analysis=[
            ProviderInfo(stream_url=STREAM, abuse_email="abuse@examplehost.test"),
        ],
    )
    monkeypatch.setattr(
        "src.orchestrator.emailing.render_subject",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no sink")),
    )
    with pytest.raises(RuntimeError, match="no sink"):
        render_takedown_emails(params)


# ── generate_takedown_emails_node ────────────────────────────────────────────


@pytest.mark.unit
@pytest.mark.asyncio
async def test_generate_takedown_emails_never_crashes_final_stage() -> None:
    """Happy path carries an empty invalid_items list through the update."""
    state = {
        "url": URL,
        "extraction_results": [_extraction_result()],
        "provider_analysis": [
            ProviderInfo(stream_url=STREAM, abuse_email="abuse@examplehost.test"),
        ],
        "invalid_items": [],
    }
    result = await generate_takedown_emails_node(state, settings=None, observer=None)
    assert len(result["takedown_emails"]) >= 1
    assert result["invalid_items"] == []


@pytest.mark.unit
@pytest.mark.asyncio
async def test_generate_takedown_emails_collects_prior_invalid_items() -> None:
    """Skip records from earlier stages flow through the final-stage update."""
    prior = [{"stage": "analyze_providers", "reason": "x", "item_preview": "y"}]
    state = {
        "url": URL,
        "extraction_results": [_extraction_result()],
        "provider_analysis": [],
        "invalid_items": prior,
    }
    result = await generate_takedown_emails_node(state, settings=None, observer=None)
    assert result["takedown_emails"] == []
    assert result["invalid_items"] == prior
