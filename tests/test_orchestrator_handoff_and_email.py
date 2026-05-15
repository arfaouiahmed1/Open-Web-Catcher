from src.agents.email_generator import generate_takedown_emails
from src.agents.hosting_page import _normalize_hosting_output
from src.agents.orchestrator import _requires_embedded_followup
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult, ProviderInfo, ServerResult, StreamURL


def test_hosting_output_promotes_partial_success_embed_decision() -> None:
    payload = _normalize_hosting_output(
        {
            "servers": [
                {
                    "label": "Server 1",
                    "status": "success",
                    "server_up": True,
                    "m3u8_urls": ["https://cdn.example.com/master.m3u8"],
                    "screenshot_url": "https://img.example.com/server1.png",
                },
                {
                    "label": "Server 2",
                    "status": "needs_embed_agent",
                    "server_up": False,
                    "embedded_url": "https://embed.example.com/player/2",
                    "player_iframe_url": "https://embed.example.com/player/2",
                    "screenshot_url": "https://img.example.com/server2.png",
                },
            ]
        }
    )

    assert payload["decision"] == "partial_success_needs_embed"
    assert payload["successful_servers"] == 1
    assert "https://embed.example.com/player/2" in payload["embedded_urls_for_processing"]


def test_requires_embedded_followup_when_server_requests_it() -> None:
    extraction = ExtractionResult(
        url="https://host.example.com/watch/1",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        streams=[
            StreamURL(
                url="https://cdn.example.com/master.m3u8",
                protocol="hls",
                source_layer="Server 1",
            )
        ],
        servers=[
            ServerResult(
                label="Server 1",
                status="success",
                server_up=True,
                m3u8_urls=["https://cdn.example.com/master.m3u8"],
            ),
            ServerResult(
                label="Server 2",
                status="needs_embed_agent",
                server_up=False,
                embedded_url="https://embed.example.com/player/2",
                player_iframe_url="https://embed.example.com/player/2",
            ),
        ],
        metadata={"decision": "safe_exit"},
    )

    assert _requires_embedded_followup(extraction) is True


def test_generate_takedown_emails_without_abuse_contact_still_creates_draft() -> None:
    extraction = ExtractionResult(
        url="https://host.example.com/watch/1",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        streams=[
            StreamURL(
                url="https://cdn.example.com/master.m3u8",
                protocol="hls",
                source_layer="Server 1",
            )
        ],
        screenshots=["https://img.example.com/server1.png"],
        servers=[ServerResult(label="Server 1", status="success", server_up=True)],
    )
    provider_rows = [
        ProviderInfo(
            stream_url="https://cdn.example.com/master.m3u8",
            provider="Example CDN",
            hostname="cdn.example.com",
            abuse_email="",
            whois_raw='{"name":"Example CDN"}',
        )
    ]

    emails = generate_takedown_emails(
        infringing_url="https://host.example.com/watch/1",
        extraction_results=[extraction],
        provider_analysis=provider_rows,
    )

    assert len(emails) == 1
    assert emails[0].provider == "Example CDN"
    assert emails[0].abuse_email == ""
    assert "No abuse contact was resolved automatically" in emails[0].body
    assert emails[0].stream_evidence[0].stream_url == "https://cdn.example.com/master.m3u8"
    assert emails[0].stream_evidence[0].screenshot_urls == [
        "https://img.example.com/server1.png"
    ]


def test_generate_takedown_emails_correlates_server_screenshots_per_stream() -> None:
    extraction = ExtractionResult(
        url="https://host.example.com/watch/1",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        screenshots=["https://img.example.com/fallback.png"],
        streams=[
            StreamURL(
                url="https://cdn.example.com/master.m3u8",
                protocol="hls",
                source_layer="Server 1",
            ),
            StreamURL(
                url="https://cdn.example.com/backup.m3u8",
                protocol="hls",
                source_layer="Server 2",
            ),
        ],
        servers=[
            ServerResult(
                label="Server 1",
                status="success",
                server_up=True,
                m3u8_urls=["https://cdn.example.com/master.m3u8"],
                screenshot_url="https://img.example.com/server1.png",
            ),
            ServerResult(
                label="Server 2",
                status="success",
                server_up=True,
                m3u8_urls=["https://cdn.example.com/backup.m3u8"],
                screenshot_url="https://img.example.com/server2.png",
            ),
        ],
    )
    provider_rows = [
        ProviderInfo(
            stream_url="https://cdn.example.com/master.m3u8",
            provider="Example CDN",
            hostname="cdn.example.com",
            abuse_email="abuse@example.com",
        ),
        ProviderInfo(
            stream_url="https://cdn.example.com/backup.m3u8",
            provider="Example CDN",
            hostname="cdn.example.com",
            abuse_email="abuse@example.com",
        ),
    ]

    emails = generate_takedown_emails(
        infringing_url="https://host.example.com/watch/1",
        extraction_results=[extraction],
        provider_analysis=provider_rows,
    )

    assert len(emails) == 1
    evidence_by_url = {row.stream_url: row for row in emails[0].stream_evidence}
    assert evidence_by_url["https://cdn.example.com/master.m3u8"].screenshot_urls == [
        "https://img.example.com/server1.png"
    ]
    assert evidence_by_url["https://cdn.example.com/backup.m3u8"].screenshot_urls == [
        "https://img.example.com/server2.png"
    ]


def test_generate_takedown_emails_falls_back_to_extraction_screenshots() -> None:
    extraction = ExtractionResult(
        url="https://embed.example.com/player/1",
        page_type=PageType.EMBEDDED,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.EMBEDDED_PAGE,
        screenshots=["https://img.example.com/extraction.png"],
        streams=[
            StreamURL(
                url="https://cdn.example.com/direct.mp4",
                protocol="mp4",
                source_layer="default",
            )
        ],
        servers=[ServerResult(label="default", status="success", server_up=True)],
    )
    provider_rows = [
        ProviderInfo(
            stream_url="https://cdn.example.com/direct.mp4",
            provider="Example CDN",
            hostname="cdn.example.com",
            abuse_email="abuse@example.com",
        )
    ]

    emails = generate_takedown_emails(
        infringing_url="https://embed.example.com/player/1",
        extraction_results=[extraction],
        provider_analysis=provider_rows,
    )

    assert len(emails) == 1
    assert emails[0].stream_evidence[0].screenshot_urls == [
        "https://img.example.com/extraction.png"
    ]
