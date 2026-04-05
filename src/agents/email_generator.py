"""Takedown email generator — deterministic, no LLM.

Groups extracted streams by provider, then writes one takedown notice per
provider containing: the infringing URL, stream URLs, Cloudinary screenshot
links, and server labels as evidence.

Emails are NOT sent — they are returned as TakedownEmail objects for human
review and dispatch.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from src.models.schemas import ExtractionResult, ProviderInfo, StreamURL, TakedownEmail
from src.utils.logging import get_logger

logger = get_logger(__name__)


def generate_takedown_emails(
    infringing_url: str,
    extraction_results: list[ExtractionResult],
    provider_analysis: list[ProviderInfo],
) -> list[TakedownEmail]:
    """Generate one takedown email per unique provider.

    Args:
        infringing_url: The top-level URL of the illegal streaming site.
        extraction_results: All ExtractionResult objects from hosting/embedded agents.
        provider_analysis: ProviderInfo list from IPInfo lookup.

    Returns:
        List of TakedownEmail objects, one per unique provider.
    """
    # Build lookup: stream_url → ProviderInfo
    provider_by_url: dict[str, ProviderInfo] = {p.stream_url: p for p in provider_analysis}

    # Build lookup: stream_url → (server_label, screenshot_url, source_url)
    stream_context: dict[str, dict] = {}
    for result in extraction_results:
        for server in result.servers:
            for stream_url in server.m3u8_urls + server.mpd_urls + server.mp4_urls:
                stream_context[stream_url] = {
                    "server_label": server.label,
                    "screenshot_url": server.screenshot_url or "",
                    "source_url": result.url,
                }

    # Group everything by provider
    groups: dict[str, _ProviderGroup] = defaultdict(_ProviderGroup)

    for stream_url, ctx in stream_context.items():
        info = provider_by_url.get(stream_url)
        if info is None:
            # No provider info — use a fallback key
            key = "unknown"
            provider_name = "Unknown Provider"
            abuse_email = ""
        else:
            key = info.provider or info.org or "unknown"
            provider_name = info.provider or info.org or "Unknown Provider"
            abuse_email = info.abuse_email

        g = groups[key]
        g.provider_name = provider_name
        g.abuse_email = abuse_email
        g.provider_info = info
        g.stream_urls.append(stream_url)
        if ctx["server_label"]:
            g.server_labels.append(ctx["server_label"])
        if ctx["screenshot_url"]:
            g.screenshot_urls.append(ctx["screenshot_url"])

    emails: list[TakedownEmail] = []
    for key, group in groups.items():
        email = _write_email(
            provider=group.provider_name,
            abuse_email=group.abuse_email,
            infringing_url=infringing_url,
            stream_urls=list(dict.fromkeys(group.stream_urls)),       # dedup, preserve order
            screenshot_urls=list(dict.fromkeys(group.screenshot_urls)),
            server_labels=list(dict.fromkeys(group.server_labels)),
            provider_info=group.provider_info,
        )
        emails.append(email)
        logger.info("Generated takedown email for provider: %s", group.provider_name)

    return emails


# ── Internal helpers ──────────────────────────────────────────────────────────

class _ProviderGroup:
    def __init__(self) -> None:
        self.provider_name: str = ""
        self.abuse_email: str = ""
        self.provider_info: ProviderInfo | None = None
        self.stream_urls: list[str] = []
        self.server_labels: list[str] = []
        self.screenshot_urls: list[str] = []


def _write_email(
    provider: str,
    abuse_email: str,
    infringing_url: str,
    stream_urls: list[str],
    screenshot_urls: list[str],
    server_labels: list[str],
    provider_info: ProviderInfo | None,
) -> TakedownEmail:
    today = date.today().strftime("%B %d, %Y")
    to_line = abuse_email or f"abuse@{provider.lower().replace(' ', '')}.com"
    subject = f"DMCA Takedown Notice — Illegal Streaming via Your Infrastructure — {today}"

    geo_line = ""
    if provider_info:
        parts = [p for p in [provider_info.city, provider_info.region, provider_info.country] if p]
        geo_line = f"  Location: {', '.join(parts)}\n" if parts else ""
        if provider_info.ip:
            geo_line += f"  IP Address: {provider_info.ip}\n"
        if provider_info.org:
            geo_line += f"  Network: {provider_info.org}\n"

    stream_list = "\n".join(f"  • {u}" for u in stream_urls)
    screenshot_list = "\n".join(f"  • {u}" for u in screenshot_urls) or "  (none captured)"
    server_list = ", ".join(server_labels) or "default"

    body = f"""To the Abuse / DMCA Team at {provider},

Date: {today}

---
NOTICE OF COPYRIGHT INFRINGEMENT
---

We write to notify you that your infrastructure is being used to deliver
unauthorized streams of copyrighted broadcast content without the consent of
the rights holders.

INFRINGING WEBSITE
  {infringing_url}

INFRINGING STREAM URLS (delivered via your servers)
{stream_list}

SERVER LABELS OBSERVED ON THE SITE
  {server_list}

PROVIDER INFORMATION
{geo_line or '  (lookup unavailable)'}

SCREENSHOT EVIDENCE (hosted on Cloudinary)
{screenshot_list}

---
We request that you:
  1. Immediately suspend or terminate the accounts / services delivering the
     above stream URLs.
  2. Preserve all related logs for potential legal proceedings.
  3. Confirm action taken by replying to this notice.

This notice is sent in good faith and under penalty of perjury. We are
authorized to act on behalf of the affected rights holders.

Sincerely,
Open Web Catcher — Anti-Piracy Pipeline
[Contact information redacted for automated notice]
"""

    return TakedownEmail(
        provider=provider,
        abuse_email=to_line,
        subject=subject,
        body=body,
        infringing_url=infringing_url,
        stream_urls=stream_urls,
        screenshot_urls=screenshot_urls,
        server_labels=server_labels,
        provider_info=provider_info,
    )
