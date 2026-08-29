"""Template regression tests for takedown-email rendering (plan task 29, batch W7).

Golden-file contract
====================

Rendered subject/body are compared against checked-in golden files under
``configs/email_templates/__golden__/``. Byte-for-byte fidelity is required
modulo the normalizations declared here (declared up-front per task 29):

1. ``Abuse date: <ISO-8601 timestamp>`` is tokenized to ``Abuse date:
   <GENERATED_AT>`` — the render clock is wall-clock and non-deterministic;
   everything else about the line must match exactly.
2. Trailing whitespace on each line is stripped (template block tags may not
   leave stray trailing spaces; prose never ends a line with spaces).
3. Leading/trailing blank lines of the whole document are collapsed.

Any other difference — wording, punctuation, evidence-line ordering, blank
lines between paragraphs — fails the test.

Characterization provenance: the golden files were captured from the
pre-refactor inline implementation in ``src/agents/email_generator.py``
(RED phase of task 29). The owned module ``src/orchestrator/emailing.py``
must reproduce them exactly, and the legacy entrypoint must stay equivalent
to the owned module.
"""

from __future__ import annotations

import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from jinja2 import UndefinedError
from pydantic import ValidationError

from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import (
    ExtractionResult,
    ProviderInfo,
    ServerResult,
    StreamURL,
    TakedownEmail,
)
from src.orchestrator.emailing import (
    TakedownEmailRenderInput,
    build_email_contexts,
    render_body,
    render_subject,
    render_takedown_emails,
    select_template_variant,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_DIR = REPO_ROOT / "configs" / "email_templates" / "__golden__"

_ABUSE_DATE_RE = re.compile(r"^Abuse date: .*$", re.MULTILINE)


def _normalize(text: str) -> str:
    """Apply the declared golden normalizations (see module docstring)."""
    text = _ABUSE_DATE_RE.sub("Abuse date: <GENERATED_AT>", text)
    lines = [line.rstrip() for line in text.splitlines()]
    return "\n".join(lines).strip("\n")


def _golden_path(name: str) -> Path:
    return GOLDEN_DIR / f"{name}.txt"


def _render_golden_document(emails: list[TakedownEmail]) -> str:
    parts = []
    for index, email in enumerate(emails):
        header = f"case[{index}] provider={email.provider} abuse={email.abuse_email}"
        parts.append(
            f"{header}\n"
            f"subject: {email.subject}\n"
            f"channel: {email.channel_name}\n"
            f"rights_owner_reference_url: {email.rights_owner_reference_url}\n"
            f"stream_urls: {email.stream_urls}\n"
            f"screenshot_urls: {email.screenshot_urls}\n"
            f"server_labels: {email.server_labels}\n"
            f"body:\n{email.body}"
        )
    return "\n\n".join(parts)


def _assert_matches_golden(name: str, emails: list[TakedownEmail]) -> None:
    document = _normalize(_render_golden_document(emails))
    path = _golden_path(name)
    if os.environ.get("OWC_REGEN_GOLDENS") == "1":
        GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(document + "\n", encoding="utf-8")
        return
    expected = path.read_text(encoding="utf-8").rstrip("\n")
    assert document == expected, (
        f"Rendered output diverges from golden file {path.relative_to(REPO_ROOT)}.\n"
        "--- expected (golden) ---\n"
        f"{expected}\n"
        "--- actual (rendered) ---\n"
        f"{document}\n"
        "If the change is intentional, regenerate with OWC_REGEN_GOLDENS=1 and review the diff."
    )


# ── Fixture evidence ─────────────────────────────────────────────────────────


def _hosting_extraction() -> ExtractionResult:
    """Hosting-page extraction: server-scoped HLS stream with screenshots."""
    stream_url = "https://cdn.examplehost.net/live/sky1/index.m3u8"
    return ExtractionResult(
        url="https://pirate-stream.example/watch/sky-sports-live",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        servers=[
            ServerResult(
                label="Server 1",
                status="success",
                m3u8_urls=[stream_url],
                screenshot_url="https://res.cloudinary.com/demo/image/upload/server1_evidence.jpg",
                detected_channel="sky sports",
                ocr_text="SKY SPORTS 1 LIVE",
            )
        ],
        streams=[
            StreamURL(url=stream_url, protocol="hls", source_layer="Server 1"),
        ],
        screenshots=["https://res.cloudinary.com/demo/image/upload/page_evidence.jpg"],
        primary_channel="Sky Sports",
    )


def _hosting_provider(stream_url: str) -> ProviderInfo:
    return ProviderInfo(
        stream_url=stream_url,
        ip="203.0.113.10",
        hostname="cdn.examplehost.net",
        org="AS64512 ExampleHost B.V.",
        provider="ExampleHost",
        country="NL",
        region="North Holland",
        city="Amsterdam",
        abuse_email="abuse@examplehost.net",
    )


def _embedded_extraction() -> ExtractionResult:
    """Embedded-player extraction: iframe-layer stream, no server entries."""
    return ExtractionResult(
        url="https://pirate-stream.example/player/bein-sports",
        page_type=PageType.EMBEDDED,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.EMBEDDED_PAGE,
        servers=[],
        streams=[
            StreamURL(
                url="https://edge.embedcdn.io/hls/bein1.m3u8",
                protocol="hls",
                source_layer="iframe-player",
                channel_name="beIN SPORTS 1 HD",
            )
        ],
        screenshots=["https://res.cloudinary.com/demo/image/upload/embedded_player.jpg"],
        primary_channel="",
    )


def _embedded_provider() -> ProviderInfo:
    return ProviderInfo(
        stream_url="https://edge.embedcdn.io/hls/bein1.m3u8",
        ip="198.51.100.7",
        hostname="",
        org="AS64511 EmbedCDN GmbH",
        provider="EmbedCDN",
        country="DE",
        abuse_email="",
    )


def _generic_extraction() -> ExtractionResult:
    """Hosting extraction whose labels normalize to no channel at all."""
    return ExtractionResult(
        url="https://pirate-stream.example/video/12345",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        servers=[
            ServerResult(
                label="source 1",
                status="success",
                mp4_urls=["https://mirror.generic-host.io/v/clip.mp4"],
                screenshot_url="https://res.cloudinary.com/demo/image/upload/generic_server.jpg",
            )
        ],
        streams=[],
        screenshots=[],
        primary_channel="",
    )


def _generic_providers() -> list[ProviderInfo]:
    return [
        ProviderInfo(
            stream_url="https://unmapped.provider.example/x.mp4",
            ip="203.0.113.99",
            hostname="unmapped.provider.example",
            org="AS64513 GenericHost LLC",
            provider="GenericHost",
            country="US",
            abuse_email="reports@generichost.io",
        ),
        ProviderInfo(
            stream_url="https://mirror.generic-host.io/v/clip.mp4",
            ip="203.0.113.41",
            hostname="mirror.generic-host.io",
            org="AS64514 MirrorRelay S.A.",
            provider="MirrorRelay",
            country="FR",
            abuse_email="abuse@mirrorrelay.io",
        ),
    ]


CASE_KWARGS: dict[str, dict[str, Any]] = {
    "hosting_resolved": {
        "infringing_url": "https://pirate-stream.example/",
        "extraction_results": [_hosting_extraction()],
        "provider_analysis": [
            _hosting_provider("https://cdn.examplehost.net/live/sky1/index.m3u8")
        ],
    },
    "embedded_unresolved": {
        "infringing_url": "https://pirate-stream.example/",
        "extraction_results": [_embedded_extraction()],
        "provider_analysis": [_embedded_provider()],
    },
    "multi_provider_no_channel": {
        "infringing_url": "https://pirate-stream.example/",
        "extraction_results": [_generic_extraction()],
        "provider_analysis": _generic_providers(),
    },
}

CASE_NAMES = sorted(CASE_KWARGS)


def _render_case(name: str, **extra: Any) -> list[TakedownEmail]:
    return render_takedown_emails(
        TakedownEmailRenderInput(**{**CASE_KWARGS[name], **extra})
    )


# ── Golden regression tests (owned module vs pre-refactor characterization) ──


@pytest.mark.unit
@pytest.mark.parametrize("case", CASE_NAMES)
def test_golden_files_reproduced_by_owned_module(case: str) -> None:
    emails = _render_case(case)
    assert emails
    _assert_matches_golden(case, emails)


@pytest.mark.unit
@pytest.mark.parametrize("case", CASE_NAMES)
def test_legacy_entrypoint_equivalent_to_owned_module(case: str) -> None:
    """The compatibility shim must stay byte-equal to the owned module."""
    from src.agents.email_generator import generate_takedown_emails

    legacy = generate_takedown_emails(**CASE_KWARGS[case])
    modern = _render_case(case)
    assert len(legacy) == len(modern)
    for old, new in zip(legacy, modern):
        old_payload = old.model_dump(mode="json")
        new_payload = new.model_dump(mode="json")
        # Wall-clock stamps differ by construction: the generated_at field and
        # the "Abuse date:" stamp embedded inside the body text.
        for payload in (old_payload, new_payload):
            payload.pop("generated_at")
            payload["body"] = _normalize(payload["body"])
        assert old_payload == new_payload


# ── Strict-undefined proofs ──────────────────────────────────────────────────


def _first_context(case: str) -> dict[str, Any]:
    contexts = build_email_contexts(
        infringing_url=CASE_KWARGS[case]["infringing_url"],
        extraction_results=CASE_KWARGS[case]["extraction_results"],
        provider_analysis=CASE_KWARGS[case]["provider_analysis"],
        generated_at_iso="2026-01-02T03:04:05+00:00",
    )
    assert contexts
    return contexts[0]


@pytest.mark.unit
@pytest.mark.parametrize(
    ("missing_key", "template_kind"),
    [
        # Subject template consumes only these two raw slots.
        ("provider_name", "subject"),
        ("channel_name", "subject"),
        # Body template consumes precomputed prose slots plus these raw ones.
        ("infringing_url", "body"),
        ("generated_at_iso", "body"),
        ("object_id", "body"),
        ("contact_line", "body"),
        ("channel_or_licensed", "body"),
        ("works_reference", "body"),
        ("title_line", "body"),
        ("evidence_rows", "body"),
        ("contact_note", "body"),
    ],
)
def test_missing_required_context_key_fails_loudly(missing_key: str, template_kind: str) -> None:
    """StrictUndefined: a dropped slot raises instead of leaking empty prose.

    Each template-referenced key is asserted against the renderer that
    actually consumes it — dropping a key from the context must fail loudly
    in exactly that template, never silently degrade the prose.
    """
    context = _first_context("hosting_resolved")
    broken = {key: value for key, value in context.items() if key != missing_key}
    renderer = render_subject if template_kind == "subject" else render_body
    with pytest.raises(UndefinedError):
        renderer(broken, variant="hosting")


@pytest.mark.unit
def test_render_input_rejects_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        TakedownEmailRenderInput(
            infringing_url="https://pirate-stream.example/",
            extraction_results=[],
            provider_analysis=[],
            not_a_real_field=True,  # type: ignore[arg-type]
        )


@pytest.mark.unit
def test_render_input_requires_validated_evidence() -> None:
    with pytest.raises(ValidationError):
        TakedownEmailRenderInput(extraction_results=[], provider_analysis=[])  # type: ignore[call-arg]
    with pytest.raises(ValidationError):
        TakedownEmailRenderInput(
            infringing_url="https://pirate-stream.example/",
            extraction_results=[{"url": "not-a-model"}],  # type: ignore[list-item]
            provider_analysis=[],
        )


# ── Subject/body invariants ──────────────────────────────────────────────────


@pytest.mark.unit
@pytest.mark.parametrize("case", CASE_NAMES)
def test_no_template_placeholder_leakage(case: str) -> None:
    for email in _render_case(case):
        for text in (email.subject, email.body):
            assert "{{" not in text, "Jinja variable leaked into prose"
            assert "{%" not in text, "Jinja block tag leaked into prose"
            assert "{#" not in text, "Jinja comment leaked into prose"


@pytest.mark.unit
@pytest.mark.parametrize("case", CASE_NAMES)
def test_subject_and_dmca_structure_invariants(case: str) -> None:
    for email in _render_case(case):
        assert email.subject.startswith("DMCA Notice: unauthorized ")
        assert email.provider in email.subject
        lines = email.body.splitlines()
        object_id = (email.channel_name or "Broadcast").replace(" ", "_")
        assert lines[0] == f"Object: {object_id}_LIPTV_ID"
        assert "17 U.S.C. § 512" in email.body
        assert "counter-notice" in lines[-1]
        for stream_url in email.stream_urls:
            assert f"- URL(s): {stream_url}" in email.body


@pytest.mark.unit
@pytest.mark.parametrize("case", CASE_NAMES)
def test_resolved_contact_note_branch(case: str) -> None:
    for email in _render_case(case):
        note = (
            "No abuse contact was resolved automatically; review the provider "
            "Whois details before sending."
        )
        assert (note in email.body) == (not email.abuse_email.strip())


# ── Variant selection + seams ────────────────────────────────────────────────


@pytest.mark.unit
def test_select_template_variant_follows_provider_context() -> None:
    assert select_template_variant([]) == "hosting"
    assert select_template_variant([_hosting_extraction()]) == "hosting"
    assert select_template_variant([_embedded_extraction()]) == "embedded"
    # Embedded evidence anywhere flips the whole draft to the embedded variant.
    assert select_template_variant([_hosting_extraction(), _embedded_extraction()]) == "embedded"


@pytest.mark.unit
@pytest.mark.parametrize("case", CASE_NAMES)
def test_validator_approved_seam_accepts_all_states_without_churn(case: str) -> None:
    """Task-24 seam: the field exists today, gating slots in later."""
    baseline = _render_case(case, validator_approved=None)
    for flag in (True, False):
        gated = _render_case(case, validator_approved=flag)
        assert [e.subject for e in gated] == [e.subject for e in baseline]
        assert [_normalize(e.body) for e in gated] == [_normalize(e.body) for e in baseline]


@pytest.mark.unit
def test_injected_clock_makes_render_deterministic() -> None:
    fixed = datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC)
    first = _render_case("hosting_resolved")
    second = render_takedown_emails(
        TakedownEmailRenderInput(**CASE_KWARGS["hosting_resolved"]),
        generated_at=fixed,
    )
    stamp = f"Abuse date: {fixed.isoformat()}"
    assert any(stamp in email.body for email in second)
    assert [_normalize(e.body) for e in first] == [_normalize(e.body) for e in second]
