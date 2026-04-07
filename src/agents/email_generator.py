"""Generate DMCA takedown email drafts from provider analysis and extraction results."""

from __future__ import annotations

from collections import OrderedDict

from src.models.schemas import ExtractionResult, ProviderInfo, TakedownEmail


def generate_takedown_emails(
    *,
    infringing_url: str,
    extraction_results: list[ExtractionResult],
    provider_analysis: list[ProviderInfo],
) -> list[TakedownEmail]:
    """Build one takedown draft per unique provider/contact pair."""
    grouped: "OrderedDict[tuple[str, str], ProviderInfo]" = OrderedDict()
    for provider in provider_analysis:
        abuse_email = (provider.abuse_email or "").strip()
        if not abuse_email:
            continue
        provider_name = (provider.provider or provider.org or provider.hostname or "Hosting Provider").strip()
        grouped.setdefault((provider_name, abuse_email.lower()), provider)

    stream_urls = list(
        dict.fromkeys(
            stream.url
            for extraction in extraction_results
            for stream in extraction.streams
            if stream.url
        )
    )
    screenshot_urls = list(
        dict.fromkeys(
            screenshot
            for extraction in extraction_results
            for screenshot in extraction.screenshots
            if screenshot
        )
    )
    server_labels = list(
        dict.fromkeys(
            server.label
            for extraction in extraction_results
            for server in extraction.servers
            if server.label
        )
    )

    emails: list[TakedownEmail] = []
    for (provider_name, _), provider in grouped.items():
        subject = f"DMCA Notice: unauthorized streaming hosted by {provider_name}"
        body = "\n".join(
            [
                f"Hello {provider_name} Abuse Team,",
                "",
                "Please investigate and disable access to the following unauthorized streaming content:",
                f"- Infringing page: {infringing_url}",
                *(f"- Stream URL: {url}" for url in stream_urls[:10]),
                "",
                "Observed evidence includes direct stream captures and page-level screenshots.",
                "Please let us know if you need any additional information.",
                "",
                "Regards,",
                "Open Web Catcher",
            ]
        )
        emails.append(
            TakedownEmail(
                provider=provider_name,
                abuse_email=provider.abuse_email,
                subject=subject,
                body=body,
                infringing_url=infringing_url,
                stream_urls=stream_urls,
                screenshot_urls=screenshot_urls,
                server_labels=server_labels,
                provider_info=provider,
            )
        )

    return emails
