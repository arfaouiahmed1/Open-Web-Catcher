from src.agents.email_generator import generate_takedown_emails
from src.agents.hosting_page import _normalize_hosting_output
from src.models.enums import AgentType, ExtractionStatus, PageType
from src.models.schemas import ExtractionResult, ProviderInfo, ServerResult, StreamURL
from src.utils.channel_detection import best_channel_match, normalize_channel_name


def test_channel_detection_uses_known_broadcaster_aliases_and_rejects_generic_labels() -> None:
    assert normalize_channel_name("Server 1") == ""
    assert normalize_channel_name("English") == ""
    assert normalize_channel_name("LIVE CNN International") == "CNN"
    assert normalize_channel_name("CNBC Europe HD") == "CNBC"
    assert normalize_channel_name("beIN Sports 1 HD") == "beIN SPORTS"

    match = best_channel_match("source 2", "visible player logo: Sky News live")

    assert match["channel_name"] == "Sky News"


def test_hosting_output_derives_channel_metadata_from_stream_and_ocr() -> None:
    payload = _normalize_hosting_output(
        {
            "servers": [
                {
                    "label": "Sky Main",
                    "status": "success",
                    "server_up": True,
                    "m3u8_urls": ["https://cdn.example.com/sky-sports/main.m3u8"],
                    "ocr_text": "LIVE Sky Sports Premier League",
                    "screenshot_url": "https://img.example.com/server1.png",
                }
            ]
        }
    )

    assert payload["primary_channel"] == "Sky Sports"
    assert "Sky Sports" in payload["detected_channels"]
    assert payload["servers"][0]["detected_channel"] == "Sky Sports"


def test_generate_takedown_emails_groups_by_channel_and_provider() -> None:
    extraction = ExtractionResult(
        url="https://host.example.com/watch/1",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        primary_channel="beIN SPORTS",
        detected_channels=["beIN SPORTS", "Sky Sports"],
        streams=[
            StreamURL(
                url="https://cdn.example.com/bein/master.m3u8",
                protocol="hls",
                source_layer="Server 1",
                channel_name="beIN SPORTS",
            ),
            StreamURL(
                url="https://cdn.example.com/sky/master.m3u8",
                protocol="hls",
                source_layer="Server 2",
                channel_name="Sky Sports",
            ),
        ],
        servers=[
            ServerResult(
                label="Server 1",
                status="success",
                server_up=True,
                detected_channel="beIN SPORTS",
                m3u8_urls=["https://cdn.example.com/bein/master.m3u8"],
                screenshot_url="https://img.example.com/bein.png",
            ),
            ServerResult(
                label="Server 2",
                status="success",
                server_up=True,
                detected_channel="Sky Sports",
                m3u8_urls=["https://cdn.example.com/sky/master.m3u8"],
                screenshot_url="https://img.example.com/sky.png",
            ),
        ],
    )
    provider_rows = [
        ProviderInfo(
            stream_url="https://cdn.example.com/bein/master.m3u8",
            provider="Example CDN",
            hostname="cdn.example.com",
            abuse_email="abuse@example.com",
        ),
        ProviderInfo(
            stream_url="https://cdn.example.com/sky/master.m3u8",
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

    assert len(emails) == 2
    channels = {email.channel_name for email in emails}
    assert channels == {"beIN SPORTS", "Sky Sports"}
    assert all("unauthorized" in email.subject.lower() for email in emails)
    assert all("Infringement Evidence" in email.body for email in emails)
