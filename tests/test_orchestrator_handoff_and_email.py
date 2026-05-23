import pytest

from src.agents.email_generator import generate_takedown_emails
from src.agents.hosting_page import _normalize_hosting_output
from src.agents.orchestrator import (
    _build_embedded_handoff,
    _build_hosting_handoff,
    _build_pipeline_result,
    _collect_all_streams,
    _embedded_target_allowed,
    _split_landing_match_handoff_targets,
    hosting_page_node,
    landing_page_node,
    _requires_embedded_followup,
    route_after_classification,
)
from src.agents.landing_page import _normalize_hosting_pages
from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import (
    ClassificationResult,
    ExtractionResult,
    ProviderInfo,
    ServerResult,
    StreamURL,
    MatchInfo,
)
from src.utils.config import Settings


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


def test_embedded_classification_with_site_shell_video_falls_back_to_hosting() -> None:
    classification = ClassificationResult(
        url="https://freeslot.example/live",
        page_type=PageType.EMBEDDED,
        confidence=Confidence.MEDIUM,
        reasoning=(
            "Large autoplay background video with normal site chrome, nav menu, "
            "search box, and cookie banner. No player controls were verified."
        ),
    )

    assert route_after_classification({"classification": classification}) == "queue_root_hosting"


def test_embedded_classification_with_real_player_stays_embedded() -> None:
    classification = ClassificationResult(
        url="https://embed.example/player/123",
        page_type=PageType.EMBEDDED,
        confidence=Confidence.HIGH,
        reasoning=(
            "Standalone third-party player with minimal chrome, play button, "
            "video controls, and iframe player ownership."
        ),
    )

    assert route_after_classification({"classification": classification}) == "queue_root_embedded"


def test_hosting_handoff_preserves_landing_route_and_iframe_context() -> None:
    handoff = _build_hosting_handoff(
        {
            "url": "https://istreameast.app/v3",
            "classification": ClassificationResult(
                url="https://istreameast.app/v3",
                page_type=PageType.LANDING,
                confidence=Confidence.HIGH,
                reasoning="listing page",
            ),
            "matches": [
                MatchInfo(
                    url="https://istreameast.app/game/123",
                    title="Sweden vs Czechia",
                    route="stream_extractor",
                    iframes=["https://gooz.example/embed/50810"],
                    video_srcs=["https://video.example/player/50810"],
                    player_urls=["https://sports.example/e/50810"],
                    route_source="representative_card",
                    redirect_chain=[
                        "https://istreameast.app/v3",
                        "https://istreameast.app/v52",
                        "https://istreameast.app/game/123",
                    ],
                )
            ],
        },
        target_url="https://istreameast.app/game/123",
        memory_hint_text="",
    )

    assert "landing route source: representative_card" in handoff
    assert "landing redirect chain: https://istreameast.app/v3 -> https://istreameast.app/v52" in handoff
    assert "landing iframes to watch" not in handoff
    assert "landing video srcs to inspect" not in handoff
    assert "landing player urls to inspect" not in handoff


def test_hosting_handoff_preserves_landing_match_metadata() -> None:
    handoff = _build_hosting_handoff(
        {
            "url": "https://sports.example",
            "classification": ClassificationResult(
                url="https://sports.example",
                page_type=PageType.LANDING,
                confidence=Confidence.HIGH,
                reasoning="schedule grid with live rows",
            ),
            "matches": [
                MatchInfo(
                    url="https://sports.example/watch/ajax-groningen",
                    title="Eredivisie: Ajax Amsterdam vs Groningen",
                    participants="Ajax Amsterdam vs Groningen",
                    team1="Ajax Amsterdam",
                    team2="Groningen",
                    score="1-0",
                    status="live",
                    scheduled_time="17:45",
                    league="Eredivisie",
                    type="football",
                    sport="soccer",
                    channel="Channel 1",
                    channel_candidates=["Channel 1", "Canal 11"],
                    screenshot_url="https://img.example/landing.png",
                    visual_evidence="green expanded row with four channel links under the live fixture",
                )
            ],
        },
        target_url="https://sports.example/watch/ajax-groningen",
        memory_hint_text="",
    )

    assert "teams: Ajax Amsterdam vs Groningen" in handoff
    assert "landing status: live" in handoff
    assert "landing score: 1-0" in handoff
    assert "landing scheduled time: 17:45" in handoff
    assert "landing league: Eredivisie" in handoff
    assert "landing type: football" in handoff
    assert "landing channel: Channel 1" in handoff
    assert "landing channel candidates: Channel 1, Canal 11" in handoff
    assert "landing screenshot evidence: https://img.example/landing.png" in handoff
    assert "green expanded row" in handoff
    assert "do not navigate to another match" in handoff
    assert "dismiss popups/overlays" in handoff


def test_hosting_handoff_preserves_landing_server_hints() -> None:
    handoff = _build_hosting_handoff(
        {
            "url": "https://streamed.example",
            "classification": ClassificationResult(
                url="https://streamed.example",
                page_type=PageType.LANDING,
                confidence=Confidence.HIGH,
                reasoning="event cards",
            ),
            "matches": [
                MatchInfo(
                    url="https://streamed.example/watch/bologna-vs-inter-milan-2265406",
                    title="Bologna vs Inter Milan",
                    status="live",
                    route="stream_extractor",
                    server_hints=[
                        {
                            "label": "Admin Stream 1",
                            "source_group": "Admin",
                            "source_index": 1,
                            "source_url": "https://streamed.example/watch/bologna-vs-inter-milan-2265406/admin/1",
                            "selector": ".provider-admin a:nth-child(1)",
                        },
                        {
                            "label": "Delta Stream 1",
                            "source_group": "Delta",
                            "source_index": 1,
                            "source_url": "https://streamed.example/watch/bologna-vs-inter-milan-2265406/delta/1",
                        },
                    ],
                )
            ],
        },
        target_url="https://streamed.example/watch/bologna-vs-inter-milan-2265406",
        memory_hint_text="",
    )

    assert "landing server/source hints:" in handoff
    assert "Admin / Admin Stream 1 / https://streamed.example/watch/bologna-vs-inter-milan-2265406/admin/1" in handoff
    assert "Delta / Delta Stream 1 / https://streamed.example/watch/bologna-vs-inter-milan-2265406/delta/1" in handoff
    assert "hosting mini-listing" in handoff


def test_embedded_handoff_preserves_landing_match_metadata_from_hosting_source() -> None:
    handoff = _build_embedded_handoff(
        {
            "url": "https://sports.example",
            "classification": ClassificationResult(
                url="https://sports.example",
                page_type=PageType.LANDING,
                confidence=Confidence.HIGH,
            ),
            "matches": [
                MatchInfo(
                    url="https://sports.example/watch/ajax-groningen",
                    title="Eredivisie: Ajax Amsterdam vs Groningen",
                    team1="Ajax Amsterdam",
                    team2="Groningen",
                    status="live",
                    scheduled_time="17:45",
                    iframes=["https://embed.example/player/ajax-groningen"],
                    visual_evidence="landing row expanded into server choices",
                )
            ],
            "extraction_results": [
                ExtractionResult(
                    url="https://sports.example/watch/ajax-groningen",
                    page_type=PageType.HOSTING,
                    status=ExtractionStatus.FAILED,
                    agent_type=AgentType.HOSTING_PAGE,
                    metadata={
                        "decision": "needs_embed_agent",
                        "embedded_urls_for_processing": [
                            "https://embed.example/player/ajax-groningen"
                        ],
                    },
                )
            ],
        },
        target_url="https://embed.example/player/ajax-groningen",
        memory_hint_text="",
    )

    assert "teams: Ajax Amsterdam vs Groningen" in handoff
    assert "landing status: live" in handoff
    assert "landing scheduled time: 17:45" in handoff
    assert "landing visual evidence: landing row expanded into server choices" in handoff
    assert "source hosting page: https://sports.example/watch/ajax-groningen" in handoff
    assert "route source: hosting output: explicit embedded_url/player_iframe handoff" in handoff
    assert "do not navigate to another match" in handoff
    assert "dismiss popups/overlays" in handoff


@pytest.mark.asyncio
async def test_hosting_page_node_filters_popup_ad_embedded_handoffs(monkeypatch) -> None:
    async def fake_run(self, *, url, observer=None, orchestrator_handoff=""):
        return ExtractionResult(
            url=url,
            page_type=PageType.HOSTING,
            status=ExtractionStatus.FAILED,
            agent_type=AgentType.HOSTING_PAGE,
            servers=[
                ServerResult(
                    label="popup",
                    status="needs_embed_agent",
                    embedded_url="https://doubleclick.example/ad/player",
                    player_iframe_url="https://doubleclick.example/ad/player",
                ),
                ServerResult(
                    label="server 1",
                    status="needs_embed_agent",
                    embedded_url="https://embed.example/player/ajax-groningen",
                    player_iframe_url="https://embed.example/player/ajax-groningen",
                ),
            ],
            metadata={
                "decision": "needs_embed_agent",
                "embedded_urls_for_processing": [
                    "https://doubleclick.example/ad/player",
                    "https://embed.example/player/ajax-groningen",
                ],
            },
        )

    monkeypatch.setattr("src.agents.hosting_page.HostingPageAgent.run", fake_run)

    result = await hosting_page_node(
        {
            "url": "https://sports.example",
            "classification": ClassificationResult(
                url="https://sports.example",
                page_type=PageType.LANDING,
                confidence=Confidence.HIGH,
            ),
            "matches": [
                MatchInfo(
                    url="https://sports.example/watch/ajax-groningen",
                    title="Ajax Amsterdam vs Groningen",
                    team1="Ajax Amsterdam",
                    team2="Groningen",
                    status="live",
                )
            ],
            "extraction_results": [],
            "pending_hosting_urls": ["https://sports.example/watch/ajax-groningen"],
            "pending_embedded_urls": [],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        },
        settings=Settings(),
        observer=None,
        memory=None,
    )

    assert result["pending_embedded_urls"] == ["https://embed.example/player/ajax-groningen"]


@pytest.mark.asyncio
async def test_landing_page_node_queues_hosting_pages_with_visual_evidence_list(monkeypatch) -> None:
    async def fake_run(self, *, url, observer=None, orchestrator_handoff=""):
        return ExtractionResult(
            url=url,
            page_type=PageType.LANDING,
            status=ExtractionStatus.SUCCESS,
            agent_type=AgentType.LANDING_PAGE,
            metadata={
                "hosting_pages": [
                    {
                        "url": "https://sports.example/watch/ajax-groningen",
                        "title": "Ajax Amsterdam vs Groningen",
                        "status": "live",
                        "visual_evidence": [
                            "green expanded row",
                            "four channel/server links visible",
                        ],
                    }
                ]
            },
        )

    monkeypatch.setattr("src.agents.landing_page.LandingPageAgent.run", fake_run)

    result = await landing_page_node(
        {
            "url": "https://sports.example",
            "classification": ClassificationResult(
                url="https://sports.example",
                page_type=PageType.LANDING,
                confidence=Confidence.HIGH,
            ),
            "matches": [],
            "extraction_results": [],
            "pending_hosting_urls": [],
            "pending_embedded_urls": [],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        },
        settings=Settings(),
        observer=None,
        memory=None,
    )

    assert result["pending_hosting_urls"] == ["https://sports.example/watch/ajax-groningen"]
    assert result["matches"][0].visual_evidence == [
        "green expanded row",
        "four channel/server links visible",
    ]


def test_landing_match_handoff_splits_embeds_from_direct_streams() -> None:
    match = MatchInfo(
        url="https://site.example/watch/123",
        iframes=["https://sportsembed.su/embed/4716"],
        video_srcs=[
            "https://cdn.example.com/hls/channel/mono.css?token=abc",
            "https://player.example.com/video/123",
        ],
        player_urls=["https://host.example/player?id=123"],
    )

    embedded_targets, direct_streams = _split_landing_match_handoff_targets(match)

    assert embedded_targets == [
        "https://sportsembed.su/embed/4716",
        "https://player.example.com/video/123",
        "https://host.example/player?id=123",
    ]
    assert direct_streams == ["https://cdn.example.com/hls/channel/mono.css?token=abc"]


def test_embedded_target_requires_hosting_source_unless_root_embedded() -> None:
    state = {
        "url": "https://site.example",
        "classification": ClassificationResult(
            url="https://site.example",
            page_type=PageType.LANDING,
            confidence=Confidence.HIGH,
        ),
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": ["https://embed.example/player/1"],
        "matches": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
    }

    assert _embedded_target_allowed(state, "https://embed.example/player/1") is False

    state["extraction_results"] = [
        ExtractionResult(
            url="https://site.example/watch/1",
            page_type=PageType.HOSTING,
            status=ExtractionStatus.FAILED,
            agent_type=AgentType.HOSTING_PAGE,
            metadata={"servers_needing_embed": ["https://embed.example/player/1"]},
        )
    ]

    assert _embedded_target_allowed(state, "https://embed.example/player/1") is True


def test_landing_normalization_preserves_player_handoff_fields() -> None:
    pages = _normalize_hosting_pages(
        [
            {
                "url": "/watch/1",
                "status": "live",
                "iframes": ["/embed/1"],
                "player_handoff_candidates": [
                    {"type": "video_src", "url": "https://cdn.example.com/live/master.m3u8"},
                    {"type": "frame_url", "url": "https://frame.example.com/player/1"},
                ],
            }
        ],
        source_url="https://site.example/",
    )

    assert pages[0]["iframes"] == ["https://site.example/embed/1"]
    assert pages[0]["video_srcs"] == ["https://cdn.example.com/live/master.m3u8"]
    assert pages[0]["player_urls"] == ["https://frame.example.com/player/1"]
    assert pages[0]["direct_stream_urls"] == ["https://cdn.example.com/live/master.m3u8"]


def test_provider_analysis_only_receives_protocol_stream_urls() -> None:
    extraction = ExtractionResult(
        url="https://streamed.pk/category/cricket",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
        streams=[
            StreamURL(url="https://streamed.pk/category/cricket"),
            StreamURL(url="https://cdn.example.com/live/master.m3u8"),
            StreamURL(url="https://cdn.example.com/hls/channel/mono.css?token=abc"),
            StreamURL(url="https://cdn.example.com/assets/mono.css"),
        ],
        servers=[
            ServerResult(
                label="server",
                stream_urls=[
                    "https://cdn.example.com/live/playlist?type=hls&token=1",
                    "https://cdn.example.com/theme.css",
                ],
                m3u8_urls=["https://cdn.example.com/live/master.m3u8"],
                mp4_urls=["https://cdn.example.com/video.mp4?token=1"],
            )
        ],
    )

    assert [stream.url for stream in _collect_all_streams([extraction])] == [
        "https://cdn.example.com/live/master.m3u8",
        "https://cdn.example.com/hls/channel/mono.css?token=abc",
        "https://cdn.example.com/live/playlist?type=hls&token=1",
        "https://cdn.example.com/video.mp4?token=1",
    ]


def test_pipeline_result_distinguishes_no_hosting_pages() -> None:
    result = _build_pipeline_result(
        {
            "run_id": "run-no-hosting",
            "url": "https://landing.example",
            "classification": ClassificationResult(
                url="https://landing.example",
                page_type=PageType.LANDING,
                confidence=Confidence.HIGH,
            ),
            "matches": [],
            "extraction_results": [
                ExtractionResult(
                    url="https://landing.example",
                    page_type=PageType.LANDING,
                    status=ExtractionStatus.FAILED,
                    agent_type=AgentType.LANDING_PAGE,
                    metadata={"hosting_pages": []},
                )
            ],
            "pending_hosting_urls": [],
            "pending_embedded_urls": [],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        }
    )

    assert result.final_status == ExtractionStatus.NO_HOSTING_PAGES


def test_pipeline_result_distinguishes_page_inaccessible() -> None:
    result = _build_pipeline_result(
        {
            "run_id": "run-inaccessible",
            "url": "https://dead.example",
            "classification": ClassificationResult(
                url="https://dead.example",
                page_type=PageType.LANDING,
                confidence=Confidence.HIGH,
            ),
            "matches": [],
            "extraction_results": [
                ExtractionResult(
                    url="https://dead.example",
                    page_type=PageType.LANDING,
                    status=ExtractionStatus.FAILED,
                    agent_type=AgentType.LANDING_PAGE,
                    error_message="The page is inaccessible due to a browser-level navigation error.",
                    metadata={"hosting_pages": []},
                )
            ],
            "pending_hosting_urls": [],
            "pending_embedded_urls": [],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        }
    )

    assert result.final_status == ExtractionStatus.PAGE_INACCESSIBLE


def test_pipeline_result_distinguishes_no_streams() -> None:
    result = _build_pipeline_result(
        {
            "run_id": "run-no-streams",
            "url": "https://host.example/watch/1",
            "classification": ClassificationResult(
                url="https://host.example/watch/1",
                page_type=PageType.HOSTING,
                confidence=Confidence.HIGH,
            ),
            "matches": [],
            "extraction_results": [
                ExtractionResult(
                    url="https://host.example/watch/1",
                    page_type=PageType.HOSTING,
                    status=ExtractionStatus.FAILED,
                    agent_type=AgentType.HOSTING_PAGE,
                    metadata={"decision": "no_stream_found"},
                )
            ],
            "pending_hosting_urls": [],
            "pending_embedded_urls": [],
            "provider_analysis": [],
            "takedown_emails": [],
            "error": "",
        }
    )

    assert result.final_status == ExtractionStatus.NO_STREAMS


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
