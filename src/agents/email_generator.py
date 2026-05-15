"""Generate DMCA takedown email drafts from provider analysis and extraction results."""

from __future__ import annotations

from collections import OrderedDict
from datetime import datetime, timezone

from src.models.schemas import ExtractionResult, ProviderInfo, StreamEvidence, TakedownEmail
from src.utils.channel_detection import best_channel_match, normalize_channel_name, rights_owner_reference_url


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


def _collect_stream_evidence(extraction_results: list[ExtractionResult]) -> list[StreamEvidence]:
    evidence_by_url: "OrderedDict[str, StreamEvidence]" = OrderedDict()

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
                    *(([server.primary_stream] if server.primary_stream else [])),
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


def generate_takedown_emails(
    *,
    infringing_url: str,
    extraction_results: list[ExtractionResult],
    provider_analysis: list[ProviderInfo],
) -> list[TakedownEmail]:
    """Build one takedown draft per unique provider/contact pair."""
    grouped: "OrderedDict[tuple[str, str, str], dict[str, object]]" = OrderedDict()
    all_evidence = _collect_stream_evidence(extraction_results)
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

    emails: list[TakedownEmail] = []
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
            channel_name = normalize_channel_name(str(channel_guess.get("channel_name") or "").strip())

        stream_urls = [row.stream_url for row in stream_evidence if row.stream_url]
        screenshot_urls = _dedupe_strings(
            [screenshot for row in stream_evidence for screenshot in row.screenshot_urls]
        ) or list(fallback_screenshot_urls)
        server_labels = _dedupe_strings(
            [row.server_label for row in stream_evidence if row.server_label]
        ) or list(fallback_server_labels)

        subject = _email_header_subject(channel_name, provider_name)
        contact_note = (
            "No abuse contact was resolved automatically; review the provider Whois details before sending."
            if not isinstance(provider, ProviderInfo) or not (provider.abuse_email or "").strip()
            else ""
        )
        rights_reference = rights_owner_reference_url(channel_name)
        generated_at = datetime.now(timezone.utc).isoformat()
        evidence_lines = []
        for row in stream_evidence[:8]:
            summary = f"- URL(s): {row.stream_url}"
            evidence_lines.append(summary)
            evidence_lines.append(f"  Protocol: {row.protocol or 'unknown'}")
            if row.server_label:
                evidence_lines.append(f"  Server/Source: {row.server_label}")
            if row.channel_name:
                evidence_lines.append(f"  Channel: {row.channel_name}")
            if row.provider_hostname:
                evidence_lines.append(f"  Hostname: {row.provider_hostname}")
            for screenshot in row.screenshot_urls[:2]:
                evidence_lines.append(f"  Infringement Evidence: {screenshot}")
        body = "\n".join(
            [
                f"Object: {(channel_name or 'Broadcast').replace(' ', '_')}_LIPTV_ID",
                f"{provider_name}, {provider.abuse_email if isinstance(provider, ProviderInfo) else ''}".strip(", "),
                "To whom it may concern",
                "",
                "This letter constitutes a formal notification under the provisions of the Digital Millennium",
                "Copyright Act (DMCA), 17 U.S.C. § 512, to demand the immediate removal or disabling",
                "of access to infringing copyrighted material hosted on, or accessible through your servers,",
                f"relating to the unauthorised retransmission of {(channel_name or 'licensed')} audio-visual content and channel signals.",
                "",
                "I am the copyright owner or an agent authorized to act on behalf of the owner of the",
                f"following copyrighted work(s): {rights_reference or infringing_url}.",
                "A representative list of our copyrighted works may also be provided upon request.",
                "",
                "The infringing materials are located at the following URLs and evidence links:",
                f"Title(s): {channel_name or 'Broadcast stream'}",
                f"Abuse date: {generated_at}",
                f"Infringing page: {infringing_url}",
                *evidence_lines,
                "",
                "I have a good faith belief that the use of the copyrighted material described above is not",
                "authorized by the copyright owner, its agent, or the law.",
                "I declare, under penalty of perjury, that the information in this notification is accurate",
                "and that I am authorized to act on behalf of the owner of an exclusive right that is allegedly infringed.",
                "",
                "We demand the immediate removal or disabling of access to the infringing material",
                "identified above and that the reported entity cease any further infringement.",
                "",
                *( [contact_note, ""] if contact_note else [] ),
                "If you believe you have received this notice in error, you may submit a counter-notice in accordance with 17 U.S.C. § 512(g).",
            ]
        )
        emails.append(
            TakedownEmail(
                provider=provider_name,
                abuse_email=provider.abuse_email if isinstance(provider, ProviderInfo) else "",
                channel_name=channel_name,
                subject=subject,
                body=body,
                infringing_url=infringing_url,
                stream_urls=stream_urls,
                screenshot_urls=screenshot_urls,
                server_labels=server_labels,
                stream_evidence=stream_evidence,
                provider_info=provider if isinstance(provider, ProviderInfo) else None,
                rights_owner_reference_url=rights_reference,
            )
        )

    return emails
