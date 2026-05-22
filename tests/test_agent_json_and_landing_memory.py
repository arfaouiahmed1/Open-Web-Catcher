from src.agents.base import parse_json_object
from src.agents.embedded_page import _normalize_embedded_output
from src.agents.hosting_page import _normalize_hosting_output
from src.agents.landing_page import _augment_landing_output, _normalize_hosting_pages
from src.memory.long_term import build_site_memory_entry
from src.memory.short_term import ShortTermMemory


def test_parse_json_object_recovers_raw_control_character_in_key() -> None:
    payload, error = parse_json_object(
        """```json
{
  "decision": "no_stream_found",
  "successful_servers": 0,
  "
failed_servers_count": 0
}
```"""
    )

    assert error == ""
    assert payload["failed_servers_count"] == 0


def test_landing_normalizer_coerces_nulls_keeps_upcoming_and_drops_replay() -> None:
    pages = _normalize_hosting_pages(
        [
            {
                "url": "/match/live-1",
                "title": None,
                "participants": None,
                "status": "unknown",
                "iframes": ["https://embed.example.com/player/1"],
                "route_source": "representative_card",
                "redirect_chain": ["https://site.example/v3", None],
            },
            {
                "url": "/match/upcoming-1",
                "title": "Tomorrow game",
                "status": "upcoming",
                "team1": "Team A",
                "team2": "Team B",
                "type": "League Cup",
            },
            {
                "url": "/match/replay-1",
                "title": "Yesterday replay",
                "status": "replay",
            },
        ],
        source_url="https://site.example/v3",
    )

    assert [page["url"] for page in pages] == [
        "https://site.example/match/live-1",
        "https://site.example/match/upcoming-1",
    ]
    assert pages[0]["title"] == ""
    assert pages[0]["participants"] == ""
    assert pages[0]["redirect_chain"] == ["https://site.example/v3"]
    assert pages[1]["participants"] == "Team A vs Team B"
    assert pages[1]["league"] == "League Cup"
    assert pages[1]["type"] == "League Cup"


def test_landing_normalizer_keeps_not_live_channel_candidates() -> None:
    pages = _normalize_hosting_pages(
        [
            {
                "url": "/channel/news-1",
                "title": "News Channel",
                "channel": "News Channel",
                "status": "not_live",
                "route_source": "channel_grid",
            },
        ],
        source_url="https://site.example/",
    )

    assert pages[0]["url"] == "https://site.example/channel/news-1"
    assert pages[0]["status"] == "not_live"
    assert pages[0]["participants"] == ""


def test_landing_normalizer_preserves_visual_handoff_evidence() -> None:
    pages = _normalize_hosting_pages(
        [
            {
                "url": "/watch/live-1",
                "status": "live",
                "screenshot_url": "https://img.example.com/landing-rep.png",
                "visual_evidence": [
                    "representative screenshot shows player shell",
                    None,
                    "same-pattern card grid",
                ],
                "iframes": ["https://embed.example.com/player/1"],
                "route": "embed_agent",
            }
        ],
        source_url="https://site.example/",
    )

    assert pages[0]["route"] == "stream_extractor"
    assert pages[0]["screenshot_url"] == "https://img.example.com/landing-rep.png"
    assert pages[0]["visual_evidence"] == [
        "representative screenshot shows player shell",
        "same-pattern card grid",
    ]
    assert pages[0]["iframes"] == ["https://embed.example.com/player/1"]


def test_short_memory_saves_match_records_from_landing_tool_payload() -> None:
    memory = ShortTermMemory(page_type="landing_page")
    memory.ingest_tool_result(
        "inspect_landing",
        {"url": "https://site.example/v3"},
        {
            "hosting_pages": [
                {
                    "url": "/live/sweden-czechia/40925152",
                    "title": "Sweden vs Czechia",
                    "status": "live",
                    "route": "stream_extractor",
                    "iframes": ["https://embed.example.com/player/1"],
                }
            ]
        },
    )

    run_memory = memory.export_run_memory(page_type="landing_page")
    assert run_memory["hosting_candidate_urls"] == [
        "https://site.example/live/sweden-czechia/40925152"
    ]
    assert '"status": "live"' in run_memory["match_records"][0]


def test_short_memory_saves_full_landing_candidate_ledger() -> None:
    memory = ShortTermMemory(page_type="landing_page")
    memory.ingest_tool_result(
        "inspect_landing",
        {"url": "https://pirlotv3.pl/index2.php"},
        {
            "candidate_ledger": [
                {
                    "url": "https://pirlotv3.pl/deportes/eventos.php?r=abc123",
                    "title": "Bundesliga: Wolfsburg vs Paderborn 07",
                    "nearby_text": "19:30 Bundesliga: Wolfsburg vs Paderborn 07",
                    "scheduled_time": "19:30",
                    "status": "unknown",
                    "source": "content",
                    "source_section": "Today's Programming on PIRLO TV",
                    "selector": ".row a",
                    "xpath": "//tr[4]/td[2]/a",
                    "url_pattern": "https://pirlotv3.pl/deportes/eventos.php?r={token}",
                },
                {
                    "url": "https://pirlotv3.pl/deportes/eventos.php?r=def456",
                    "title": "NBA: Knicks vs Cavaliers",
                    "scheduled_time": "01:00",
                    "status": "unknown",
                    "url_pattern": "https://pirlotv3.pl/deportes/eventos.php?r={token}",
                },
            ]
        },
    )

    run_memory = memory.export_run_memory(page_type="landing_page")
    assert run_memory["hosting_candidate_urls"] == [
        "https://pirlotv3.pl/deportes/eventos.php?r=abc123",
        "https://pirlotv3.pl/deportes/eventos.php?r=def456",
    ]
    assert "Wolfsburg vs Paderborn" in run_memory["match_records"][0]
    assert '"scheduled_time": "19:30"' in run_memory["match_records"][0]


def test_landing_output_recovers_candidates_from_short_memory_when_model_omits_them() -> None:
    output, expanded = _augment_landing_output(
        {"hosting_pages": [], "extraction_summary": {"hosting_pages_found": 0}},
        source_url="https://site.example/v3",
        run_memory={
            "match_records": [
                '{"url":"https://site.example/live/sweden-czechia/40925152","title":"Sweden vs Czechia","status":"live"}'
            ],
            "common": {},
        },
    )

    assert expanded == 0
    assert output["hosting_pages"][0]["url"] == "https://site.example/live/sweden-czechia/40925152"
    assert output["hosting_pages"][0]["route_source"] == "inspect_landing_short_memory"
    assert output["pattern_expansion"]["short_memory_recovered_candidates"] == 1


def test_landing_output_recovers_candidate_ledger_siblings_when_model_returns_one() -> None:
    output, expanded = _augment_landing_output(
        {
            "hosting_pages": [
                {
                    "url": "https://pirlotv3.pl/deportes/eventos.php?r=abc123",
                    "title": "Bundesliga: Wolfsburg vs Paderborn 07",
                    "status": "unknown",
                    "iframes": ["https://www.capoplay.net/laliga5.php"],
                    "patterns": {
                        "url_pattern": "https://pirlotv3.pl/deportes/eventos.php?r={token}"
                    },
                }
            ],
            "extraction_summary": {"hosting_pages_found": 1},
        },
        source_url="https://www.pirlotv2.pl/",
        run_memory={
            "match_records": [
                (
                    '{"url":"https://pirlotv3.pl/deportes/eventos.php?r=def456",'
                    '"title":"NBA: Knicks vs Cavaliers","scheduled_time":"01:00",'
                    '"status":"unknown","url_pattern":"https://pirlotv3.pl/deportes/eventos.php?r={token}"}'
                ),
                (
                    '{"url":"https://pirlotv3.pl/deportes/eventos.php?r=ghi789",'
                    '"title":"Copa Sudamericana: Blooming vs Carabobo","scheduled_time":"01:30",'
                    '"status":"unknown","url_pattern":"https://pirlotv3.pl/deportes/eventos.php?r={token}"}'
                ),
            ],
            "common": {},
        },
    )

    assert expanded == 0
    assert [page["url"] for page in output["hosting_pages"]] == [
        "https://pirlotv3.pl/deportes/eventos.php?r=abc123",
        "https://pirlotv3.pl/deportes/eventos.php?r=def456",
        "https://pirlotv3.pl/deportes/eventos.php?r=ghi789",
    ]
    assert output["hosting_pages"][1]["scheduled_time"] == "01:00"
    assert output["pattern_expansion"]["short_memory_recovered_candidates"] == 2


def test_landing_pattern_expansion_allows_redirected_landing_domain() -> None:
    output, expanded = _augment_landing_output(
        {
            "hosting_pages": [
                {
                    "url": "https://pirlotv3.pl/deportes/eventos.php?r=abc123",
                    "status": "unknown",
                    "iframes": ["https://www.capoplay.net/laliga5.php"],
                    "patterns": {
                        "url_pattern": "https://pirlotv3.pl/deportes/eventos.php?r={token}"
                    },
                }
            ],
            "extraction_summary": {"hosting_pages_found": 1},
        },
        source_url="https://www.pirlotv2.pl/",
        run_memory={
            "hosting_candidate_urls": [
                "https://pirlotv3.pl/deportes/eventos.php?r=def456",
            ],
            "match_records": [],
            "common": {
                "critical_links": [
                    "https://pirlotv3.pl/deportes/eventos.php?r=def456",
                    "https://unrelated.example/watch/1",
                ]
            },
        },
    )

    assert expanded == 1
    assert [page["url"] for page in output["hosting_pages"]] == [
        "https://pirlotv3.pl/deportes/eventos.php?r=abc123",
        "https://pirlotv3.pl/deportes/eventos.php?r=def456",
    ]


def test_long_memory_entry_keeps_playbook_pagination_and_continuation_fields() -> None:
    entry = build_site_memory_entry(
        url="https://site.example/v3",
        page_type="landing_page",
        status="partial",
        actor="landing",
        trace=None,
        short_memory_summary="",
        payload={
            "hosting_pages": [{"url": "https://site.example/live/game/123"}],
            "site_patterns": {
                "pagination": {"type": "query", "url_pattern": "https://site.example/v3?page={n}"}
            },
            "extraction_summary": {
                "pagination_detected": True,
                "pages_paginated": 3,
                "rejected_patterns": ["external ad"],
            },
            "agent_run": {
                "stop_reason": "completed",
                "continuation_capsules": [
                    {
                        "continuation_index": 1,
                        "compaction_reason": "context_window_threshold",
                        "next_best_move": "continue page 3",
                    }
                ],
            },
        },
    )

    assert entry["landing_match_urls"] == ["https://site.example/live/game/123"]
    assert "url_pattern=https://site.example/v3?page={n}" in entry["pagination_rules"]
    assert entry["rejected_patterns"] == ["external ad"]
    assert entry["failure_cues"] == ["stop_reason=completed"]
    assert "continue page 3" in entry["continuation_notes"][0]


def test_hosting_normalizer_preserves_paused_tokenized_protocol_details() -> None:
    output = _normalize_hosting_output(
        {
            "servers": [
                {
                    "label": "Server 1",
                    "player_state": "paused",
                    "playback_confirmed": False,
                    "m3u8_urls": ["https://cdn.example.com/master.m3u8?token=abc&expires=999"],
                    "protocol_details": [
                        {
                            "protocol": "hls",
                            "playlist_url": "https://cdn.example.com/master.m3u8?token=abc&expires=999",
                            "role": "master_playlist",
                            "tokenized": True,
                        }
                    ],
                }
            ]
        }
    )

    server = output["servers"][0]
    assert output["decision"] == "safe_exit"
    assert server["status"] == "success"
    assert server["player_state"] == "paused"
    assert server["playback_confirmed"] is False
    assert server["m3u8_urls"] == ["https://cdn.example.com/master.m3u8?token=abc&expires=999"]
    assert server["protocol_details"][0]["protocol"] == "hls"
    assert server["protocol_details"][0]["role"] == "master_playlist"
    assert server["protocol_details"][0]["tokenized"] is True


def test_embedded_normalizer_infers_protocol_details_from_stream_objects() -> None:
    output = _normalize_embedded_output(
        {
            "servers": [
                {
                    "label": "default",
                    "player_state": "loading",
                    "stream_urls": [
                        {
                            "stream_url": "https://cdn.example.com/live/manifest.mpd?sig=abc",
                            "protocol": "dash",
                        }
                    ],
                }
            ]
        }
    )

    server = output["servers"][0]
    assert output["total_unique_streams"] == 1
    assert server["status"] == "success"
    assert server["mpd_urls"] == ["https://cdn.example.com/live/manifest.mpd?sig=abc"]
    assert server["protocol_details"][0]["protocol"] == "dash"
    assert server["protocol_details"][0]["role"] == "manifest"
    assert server["protocol_details"][0]["tokenized"] is True
