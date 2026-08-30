"""Takedown-email rendering — owned module for plan task 29 (batch W7).

Pure render logic: validated evidence inputs in, rendered ``TakedownEmail``
drafts out. No network, database, or subprocess I/O happens here; the only
filesystem access is the one-time load of versioned Jinja2 templates from
``configs/email_templates/<version>/`` (cached per version).

Provenance
----------
The prose was characterized byte-for-byte from the pre-refactor inline
implementation in ``src/agents/email_generator.py``; golden files under
``configs/email_templates/__golden__/`` lock that shape (see
``tests/orchestrator/test_email_templates.py``). Rendering must not change
the emitted text — only its provenance moved here.

Template policy
---------------
- ``undefined=StrictUndefined``: a context key referenced by a template but
  not supplied fails loudly at render time instead of leaking an empty slot
  into operator-facing prose.
- ``autoescape`` is enabled through ``select_autoescape`` so any future
  HTML variant (``*.html.j2``) is escaped automatically while the current
  plain-text letters (``*.txt.j2``) stay raw — entity-encoding ``&`` inside
  stream URLs would corrupt the DMCA evidence links.
- ``trim_blocks``/``lstrip_blocks`` keep control tags out of the rendered
  whitespace; default ``keep_trailing_newline=False`` strips the single
  trailing newline, matching the historical join-based bodies.

Validator seam (task 24)
------------------------
``TakedownEmailRenderInput.validator_approved`` is reserved for the
ValidatorAgent gate: once task 24 lands it will decide which evidence is
allowed to reach rendering. ``None`` (default) preserves today's behavior;
the field exists on the input model now so gating slots in without another
signature churn.
"""

from __future__ import annotations

from collections import OrderedDict
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from jinja2 import Environment, StrictUndefined, select_autoescape
from pydantic import BaseModel, ConfigDict

from src.models.enums import PageType
from src.models.schemas import (
    ExtractionResult,
    ProviderInfo,
    StreamEvidence,
    TakedownEmail,
)
from src.utils.channel_detection import (
    best_channel_match,
    normalize_channel_name,
    rights_owner_reference_url,
)

TEMPLATE_VERSION = "v1"
TEMPLATES_ROOT = Path(__file__).resolve().parents[2] / "configs" / "email_templates"

TemplateVariant = Literal["hosting", "embedded"]


# ── Render input model ───────────────────────────────────────────────────────


class TakedownEmailRenderInput(BaseModel):
    """Validated evidence inputs for takedown-email rendering.

    ``validator_approved`` is the task-24 seam: ``None`` keeps legacy
    behavior (all collected evidence renders); once ValidatorAgent gating
    lands it will pass explicit booleans without changing this signature.
    """

    model_config = ConfigDict(extra="forbid")

    infringing_url: str
    extraction_results: list[ExtractionResult]
    provider_analysis: list[ProviderInfo]
    validator_approved: bool | None = None


# ── Evidence collection (moved verbatim from the inline implementation) ──────


def _protocol_from_url(url: str) -> str:
    lowered = str(url or "").lower()
    if ".m3u8" in lowered:
        return "hls"
    if ".mpd" in lowered:
        return "dash"
    if ".mp4" in lowered:
        return "mp4"
    return ""


def _dedupe_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        candidate = str(value or "").strip()
        if candidate and candidate not in seen:
            seen.add(candidate)
            result.append(candidate)
    return result


def collect_stream_evidence(extraction_results: list[ExtractionResult]) -> list[StreamEvidence]:
    evidence_by_url: OrderedDict[str, StreamEvidence] = OrderedDict()

    for extraction in extraction_results:
        extraction_screenshots = _dedupe_strings(list(extraction.screenshots or []))
        stream_metadata = {
            stream.url: {
                "protocol": str(stream.protocol or "").strip(),
                "source_layer": str(stream.source_layer or "").strip(),
            }
            for stream in extraction.streams
            if stream.url
        }

        for server in extraction.servers:
            server_streams = _dedupe_strings(
                [
                    *list(server.stream_urls or []),
                    *list(server.m3u8_urls or []),
                    *list(server.mpd_urls or []),
                    *list(server.mp4_urls or []),
                    *([server.primary_stream] if server.primary_stream else []),
                ]
            )
            server_screenshots = _dedupe_strings(
                [server.screenshot_url] if server.screenshot_url else []
            )
            for stream_url in server_streams:
                meta = stream_metadata.get(stream_url, {})
                channel_name = normalize_channel_name(
                    str(
                        server.detected_channel
                        or extraction.primary_channel
                        or extraction.channel_metadata.get("primary_channel", "")
                        or ""
                    ).strip()
                )
                evidence_by_url[stream_url] = StreamEvidence(
                    stream_url=stream_url,
                    protocol=str(meta.get("protocol") or _protocol_from_url(stream_url)).strip(),
                    source_layer=str(meta.get("source_layer") or server.label or "").strip(),
                    server_label=str(server.label or "").strip(),
                    channel_name=channel_name,
                    screenshot_urls=server_screenshots or extraction_screenshots,
                    page_url=extraction.url,
                    ocr_text=str(server.ocr_text or "").strip(),
                )

        for stream in extraction.streams:
            if not stream.url:
                continue
            existing = evidence_by_url.get(stream.url)
            if existing is None:
                evidence_by_url[stream.url] = StreamEvidence(
                    stream_url=stream.url,
                    protocol=str(stream.protocol or _protocol_from_url(stream.url)).strip(),
                    source_layer=str(stream.source_layer or "").strip(),
                    server_label=str(stream.source_layer or "").strip(),
                    channel_name=normalize_channel_name(
                        str(stream.channel_name or extraction.primary_channel or "").strip()
                    ),
                    screenshot_urls=extraction_screenshots,
                    page_url=extraction.url,
                )
                continue
            if not existing.protocol and stream.protocol:
                existing.protocol = str(stream.protocol).strip()
            if not existing.source_layer and stream.source_layer:
                existing.source_layer = str(stream.source_layer).strip()
            if not existing.server_label and stream.source_layer:
                existing.server_label = str(stream.source_layer).strip()
            if not existing.screenshot_urls:
                existing.screenshot_urls = list(extraction_screenshots)
            if not existing.channel_name:
                existing.channel_name = normalize_channel_name(
                    str(stream.channel_name or extraction.primary_channel or "").strip()
                )

    return list(evidence_by_url.values())


def _email_header_subject(channel_name: str, provider_name: str) -> str:
    if channel_name:
        return f"DMCA Notice: unauthorized {channel_name} streaming hosted by {provider_name}"
    return f"DMCA Notice: unauthorized streaming hosted by {provider_name}"


# ── Template environment ─────────────────────────────────────────────────────


@lru_cache(maxsize=8)
def _environment(version: str) -> Environment:
    """Build (once per version) the strict, plain-text-first Jinja2 env."""
    return Environment(
        loader=_versioned_loader(version),
        autoescape=select_autoescape(
            enabled_extensions=("html", "htm", "xml"),
            default_for_string=False,
            default=False,
        ),
        undefined=StrictUndefined,
        trim_blocks=True,
        lstrip_blocks=True,
    )


def _versioned_loader(version: str):  # noqa: ANN202 - FileSystemLoader | ChoiceLoader
    from jinja2 import FileSystemLoader

    root = TEMPLATES_ROOT / version
    if not root.is_dir():
        raise FileNotFoundError(f"email template version not found: {root}")
    return FileSystemLoader(str(root))


def select_template_variant(extraction_results: list[ExtractionResult]) -> TemplateVariant:
    """Pick the subject/body variant for the evidence's provider-type context.

    Embedded-player evidence (iframe/player contexts) selects the
    ``embedded`` variant; everything else renders ``hosting``. Both variants
    currently emit identical prose (golden-locked); they exist as separate
    versioned files so future divergence needs no call-site changes.
    """
    if any(result.page_type == PageType.EMBEDDED for result in extraction_results):
        return "embedded"
    return "hosting"


def render_subject(
    context: dict[str, Any],
    *,
    variant: TemplateVariant,
    version: str = TEMPLATE_VERSION,
) -> str:
    """Render the subject line for one email context (strict-undefined)."""
    template = _environment(version).get_template(f"subject.{variant}.txt.j2")
    return str(template.render(**context)).strip()


def render_body(
    context: dict[str, Any],
    *,
    variant: TemplateVariant,
    version: str = TEMPLATE_VERSION,
) -> str:
    """Render the body letter for one email context (strict-undefined)."""
    template = _environment(version).get_template(f"body.{variant}.txt.j2")
    return str(template.render(**context))


# ── Context building (grouping logic moved verbatim) ─────────────────────────


def build_email_contexts(
    *,
    infringing_url: str,
    extraction_results: list[ExtractionResult],
    provider_analysis: list[ProviderInfo],
    generated_at_iso: str,
) -> list[dict[str, Any]]:
    """Group evidence into one flat render context per provider/contact pair."""
    grouped: OrderedDict[tuple[str, str, str], dict[str, object]] = OrderedDict()
    all_evidence = collect_stream_evidence(extraction_results)
    evidence_by_url = OrderedDict((row.stream_url, row) for row in all_evidence if row.stream_url)
    fallback_stream_urls = list(evidence_by_url.keys())
    fallback_screenshot_urls = _dedupe_strings(
        [
            screenshot
            for row in all_evidence
            for screenshot in row.screenshot_urls
        ]
    )
    fallback_server_labels = _dedupe_strings(
        [row.server_label for row in all_evidence if row.server_label]
    )

    channel_by_stream = {
        row.stream_url: normalize_channel_name(row.channel_name)
        for row in all_evidence
        if row.stream_url
    }

    for provider in provider_analysis:
        abuse_email = (provider.abuse_email or "").strip()
        provider_name = (
            provider.provider or provider.org or provider.hostname or "Hosting Provider"
        ).strip()
        contact_key = abuse_email.lower() if abuse_email else f"unresolved:{provider_name.lower()}"
        channel_name = normalize_channel_name(channel_by_stream.get(provider.stream_url, ""))
        grouped.setdefault(
            (channel_name, provider_name, contact_key),
            {"provider": provider, "rows": []},
        )
        cast_rows = grouped[(channel_name, provider_name, contact_key)]["rows"]
        if isinstance(cast_rows, list):
            cast_rows.append(provider)

    contexts: list[dict[str, Any]] = []
    for (channel_name, provider_name, _), payload in grouped.items():
        provider = payload["provider"]
        provider_rows = payload["rows"] if isinstance(payload["rows"], list) else []
        provider_stream_urls = _dedupe_strings(
            [
                str(row.stream_url or "").strip()
                for row in provider_rows
                if isinstance(row, ProviderInfo)
            ]
        )
        provider_hostname = next(
            (
                str(row.hostname or "").strip()
                for row in provider_rows
                if isinstance(row, ProviderInfo) and str(row.hostname or "").strip()
            ),
            "",
        )
        stream_evidence = [
            StreamEvidence(
                **{
                    **row.model_dump(mode="json"),
                    "provider_hostname": provider_hostname,
                    "channel_name": normalize_channel_name(
                        channel_name or row.channel_name or ""
                    ),
                }
            )
            for url, row in evidence_by_url.items()
            if not provider_stream_urls or url in provider_stream_urls
        ]
        if not stream_evidence and fallback_stream_urls:
            stream_evidence = list(all_evidence)
        if not channel_name:
            channel_guess = best_channel_match(
                *[
                    item.channel_name or item.server_label or item.stream_url
                    for item in stream_evidence
                ]
            )
            channel_name = normalize_channel_name(
                str(channel_guess.get("channel_name") or "").strip()
            )

        stream_urls = [row.stream_url for row in stream_evidence if row.stream_url]
        screenshot_urls = _dedupe_strings(
            [screenshot for row in stream_evidence for screenshot in row.screenshot_urls]
        ) or list(fallback_screenshot_urls)
        server_labels = _dedupe_strings(
            [row.server_label for row in stream_evidence if row.server_label]
        ) or list(fallback_server_labels)

        abuse_email = provider.abuse_email if isinstance(provider, ProviderInfo) else ""
        contact_note = (
            "No abuse contact was resolved automatically; "
            "review the provider Whois details before sending."
            if not isinstance(provider, ProviderInfo) or not (provider.abuse_email or "").strip()
            else ""
        )
        rights_reference = rights_owner_reference_url(channel_name)

        evidence_rows = [
            {
                "stream_url": row.stream_url,
                "protocol_display": row.protocol or "unknown",
                "server_label": row.server_label,
                "channel_name": row.channel_name,
                "provider_hostname": row.provider_hostname,
                "screenshots": list(row.screenshot_urls[:2]),
            }
            for row in stream_evidence[:8]
        ]

        contexts.append(
            {
                # Required slots — StrictUndefined fails loudly if missing.
                "infringing_url": infringing_url,
                "generated_at_iso": generated_at_iso,
                "provider_name": provider_name,
                "abuse_email": abuse_email,
                "channel_name": channel_name,
                # Derived prose slots (precomputed; templates stay dumb).
                "object_id": f"{(channel_name or 'Broadcast').replace(' ', '_')}_LIPTV_ID",
                "contact_line": f"{provider_name}, {abuse_email}".strip(", "),
                "channel_or_licensed": channel_name or "licensed",
                "works_reference": rights_reference or infringing_url,
                "title_line": channel_name or "Broadcast stream",
                "evidence_rows": evidence_rows,
                "contact_note": contact_note,
                # Structured fields persisted alongside the draft.
                "stream_urls": stream_urls,
                "screenshot_urls": screenshot_urls,
                "server_labels": server_labels,
                "stream_evidence": stream_evidence,
                "rights_reference": rights_reference,
                "provider": provider,
            }
        )

    return contexts


# ── Public entry point ───────────────────────────────────────────────────────


def render_takedown_emails(
    params: TakedownEmailRenderInput,
    *,
    generated_at: datetime | None = None,
    version: str = TEMPLATE_VERSION,
    invalid_sink: list[dict[str, Any]] | None = None,
) -> list[TakedownEmail]:
    """Render reviewable takedown drafts from validated evidence inputs.

    Pure: same inputs (and same injected clock) produce identical drafts.
    ``generated_at`` defaults to the current UTC time, matching the
    historical ``Abuse date`` stamp.

    Stage-parse safety (plan T15): when ``invalid_sink`` is a list, any
    per-item render failure is recorded there as
    ``{"stage", "reason", "item_preview"}`` and skipped instead of aborting
    the whole batch; ``None`` (default) preserves the raising behavior.
    """
    stamp = (generated_at or datetime.now(UTC)).isoformat()
    variant = select_template_variant(params.extraction_results)
    contexts = build_email_contexts(
        infringing_url=params.infringing_url,
        extraction_results=params.extraction_results,
        provider_analysis=params.provider_analysis,
        generated_at_iso=stamp,
    )

    emails: list[TakedownEmail] = []
    for context in contexts:
        try:
            emails.append(
                TakedownEmail(
                    provider=str(context["provider_name"]),
                    abuse_email=str(context["abuse_email"]),
                    channel_name=str(context["channel_name"]),
                    subject=render_subject(context, variant=variant, version=version),
                    body=render_body(context, variant=variant, version=version),
                    infringing_url=params.infringing_url,
                    stream_urls=list(context["stream_urls"]),
                    screenshot_urls=list(context["screenshot_urls"]),
                    server_labels=list(context["server_labels"]),
                    stream_evidence=list(context["stream_evidence"]),
                    provider_info=(
                        context["provider"]
                        if isinstance(context["provider"], ProviderInfo)
                        else None
                    ),
                    rights_owner_reference_url=str(context["rights_reference"]),
                )
            )
        except Exception as exc:  # noqa: BLE001 — one bad draft must not kill the stage
            if invalid_sink is None:
                raise
            invalid_sink.append(
                {
                    "stage": "generate_takedown_emails",
                    "reason": f"{type(exc).__name__}: {exc}",
                    "item_preview": str(context.get("provider_name", ""))[:300],
                }
            )
    return emails
