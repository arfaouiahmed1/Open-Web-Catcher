import json

from src.agents.runtime import parse_json_object
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


def test_landing_normalizer_preserves_server_hints_for_hosting() -> None:
    pages = _normalize_hosting_pages(
        [
            {
                "url": "https://streamed.example/watch/game-1",
                "server_hints": [
                    {
                        "label": "Admin Stream 1",
                        "source_group": "Admin",
                        "source_index": 1,
                        "source_url": "https://streamed.example/watch/game-1/admin/1",
                        "selector": ".admin a:nth-child(1)",
                        "xpath": "//section[1]//a[1]",
                        "route_pattern": "/watch/game-1/{provider}/{n}",
                    }
                ],
            }
        ],
        source_url="https://streamed.example/",
    )

    assert pages[0]["server_hints"][0]["label"] == "Admin Stream 1"
    assert pages[0]["server_hints"][0]["source_group"] == "Admin"
    assert pages[0]["server_hints"][0]["source_url"] == "https://streamed.example/watch/game-1/admin/1"
    assert pages[0]["server_hints"][0]["route_pattern"] == "/watch/game-1/{provider}/{n}"


def test_landing_normalizer_rejects_article_urls_without_match_or_player_evidence() -> None:
    pages = _normalize_hosting_pages(
        [
            {
                "url": "/post/yacine-tv-world-cup-2026",
                "title": "Yacine TV World Cup 2026 live all matches HD",
                "status": "live",
                "route_source": "related_news_card",
            },
            {
                "url": "/match/team-a-team-b",
                "title": "Team A vs Team B",
                "participants": "Team A vs Team B",
                "scheduled_time": "20:00",
                "status": "live",
                "route_source": "match_card",
            },
            {
                "url": "/post/team-a-team-b-live",
                "title": "Team A vs Team B",
                "participants": "Team A vs Team B",
                "scheduled_time": "20:00",
                "status": "live",
                "route_source": "match_card",
                "server_hints": [{"label": "Server 1", "selector": ".server-1"}],
            },
        ],
        source_url="https://martinchavez98.org/post/yacine-tv-premier-league-live",
    )

    assert [page["url"] for page in pages] == [
        "https://martinchavez98.org/match/team-a-team-b",
        "https://martinchavez98.org/post/team-a-team-b-live",
    ]


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


def test_short_memory_skips_related_article_cards_from_landing_candidates() -> None:
    memory = ShortTermMemory(page_type="landing_page")
    memory.ingest_tool_result(
        "inspect_landing",
        {"url": "https://martinchavez98.org/post/yacine-tv-premier-league-live"},
        {
            "candidate_ledger": [
                {
                    "url": "https://martinchavez98.org/post/yacine-tv-world-cup-2026",
                    "title": "Yacine TV World Cup 2026 live all matches HD",
                    "nearby_text": "Latest news Yacine TV World Cup 2026 live all matches HD",
                    "status": "live",
                    "source": "content",
                    "source_section": "Latest News",
                    "selector": ".related-posts a",
                    "xpath": "//aside//a[1]",
                    "url_pattern": "https://martinchavez98.org/post/yacine-tv-world-cup-{n}",
                },
                {
                    "url": "https://martinchavez98.org/match/team-a-team-b",
                    "title": "Team A vs Team B",
                    "nearby_text": "20:00 Team A vs Team B Watch Live",
                    "row_text": "20:00 Team A vs Team B Watch Live",
                    "status": "live",
                    "source": "content",
                    "source_section": "Live Matches",
                    "selector": ".match-card a",
                    "xpath": "//main//section[2]//a[1]",
                    "url_pattern": "https://martinchavez98.org/match/team-a-team-b",
                },
            ]
        },
    )

    run_memory = memory.export_run_memory(page_type="landing_page")
    assert run_memory["hosting_candidate_urls"] == [
        "https://martinchavez98.org/match/team-a-team-b"
    ]
    assert "yacine-tv-world-cup-2026" not in "".join(run_memory["match_records"])


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


def test_short_memory_captures_visible_live_match_count() -> None:
    memory = ShortTermMemory(page_type="landing_page")
    memory.ingest_tool_result(
        "inspect_landing",
        {"url": "https://streamsports99.su/"},
        {
            "text_blocks": [
                {"text": "Live Matches (36)"},
                {"text": "Refreshed 54s ago"},
            ],
            "candidate_ledger": [
                {
                    "url": "/watch/1",
                    "title": "Live match 1",
                    "status": "live",
                    "url_pattern": "https://streamsports99.su/watch/{n}",
                }
            ],
        },
    )

    run_memory = memory.export_run_memory(page_type="landing_page")
    assert run_memory["visible_live_counts"] == ["live_matches=36"]
    assert run_memory["common"]["visible_live_counts"] == ["live_matches=36"]


def test_short_memory_tracks_pagination_without_hosting_candidate() -> None:
    memory = ShortTermMemory(page_type="landing_page")
    memory.ingest_tool_result(
        "inspect_landing",
        {"url": "https://freeshot.live/live-tv"},
        {
            "pagination": {
                "page_urls": [
                    "https://freeshot.live/live-tv?page=2",
                    "https://freeshot.live/live-tv?page=73",
                ],
                "sample_links": [
                    {"text": "2", "href": "https://freeshot.live/live-tv?page=2"},
                ],
            },
            "candidate_ledger": [
                {
                    "url": "https://freeshot.live/live-tv?page=2",
                    "title": "2",
                    "status": "unknown",
                    "url_pattern": "https://freeshot.live/live-tv?page={n}",
                },
                {
                    "url": "https://freeshot.live/live-tv/espn-arg/871",
                    "title": "ESPN ARG",
                    "status": "not_live",
                    "url_pattern": "https://freeshot.live/live-tv/espn-arg/{n}",
                },
            ],
        },
    )

    run_memory = memory.export_run_memory(page_type="landing_page")
    assert "https://freeshot.live/live-tv?page={n}" in run_memory["common"]["pagination_patterns"]
    assert run_memory["hosting_candidate_urls"] == [
        "https://freeshot.live/live-tv/espn-arg/871"
    ]
    assert all("?page=" not in record for record in run_memory["match_records"])


def test_landing_output_marks_completion_gap_when_visible_live_count_not_met() -> None:
    output, expanded = _augment_landing_output(
        {
            "hosting_pages": [
                {
                    "url": f"https://streamsports99.su/watch/{index}",
                    "title": f"Live match {index}",
                    "status": "live",
                    "patterns": {"url_pattern": "https://streamsports99.su/watch/{n}"},
                }
                for index in range(1, 16)
            ],
            "extraction_summary": {"hosting_pages_found": 15},
        },
        source_url="https://streamsports99.su/",
        run_memory={
            "visible_live_counts": ["live_matches=36"],
            "common": {"visible_live_counts": ["live_matches=36"]},
        },
    )

    assert expanded == 0
    assert len(output["hosting_pages"]) == 15
    assert output["extraction_summary"]["expected_live_items_count"] == 36
    assert output["extraction_summary"]["hosting_pages_missing_from_visible_count"] == 21
    assert output["extraction_summary"]["completion_gap"] is True
    assert "expected 36" in output["extraction_summary"]["continuation_needed_reason"]


def test_landing_pattern_expansion_skips_pagination_and_listing_pages() -> None:
    output, expanded = _augment_landing_output(
        {
            "hosting_pages": [
                {
                    "url": "https://freeshot.live/live-tv/espn-arg/871",
                    "title": "ESPN ARG",
                    "status": "not_live",
                    "patterns": {
                        "url_pattern": "https://freeshot.live/live-tv/espn-arg/{n}"
                    },
                }
            ],
            "extraction_summary": {"hosting_pages_found": 1},
        },
        source_url="https://freeshot.live/live-tv",
        run_memory={
            "hosting_candidate_urls": [
                "https://freeshot.live/live-tv?page=2",
                "https://freeshot.live/live-tv/argentina",
                "https://freeshot.live/live-tv/sky-sports/872",
            ],
            "match_records": [],
            "common": {
                "critical_links": [
                    "https://freeshot.live/live-tv?page=73",
                    "https://freeshot.live/live-tv/albania-kosovo",
                    "https://freeshot.live/live-tv/fox-sports/873",
                ],
                "pagination_patterns": ["https://freeshot.live/live-tv?page={n}"],
            },
        },
    )

    assert expanded == 2
    assert [page["url"] for page in output["hosting_pages"]] == [
        "https://freeshot.live/live-tv/espn-arg/871",
        "https://freeshot.live/live-tv/sky-sports/872",
        "https://freeshot.live/live-tv/fox-sports/873",
    ]
    assert output["extraction_summary"]["pagination_detected"] is True
    assert output["site_patterns"]["pagination"]["url_pattern"] == "https://freeshot.live/live-tv?page={n}"


def test_landing_output_uses_model_visual_live_count_from_screenshot() -> None:
    output, expanded = _augment_landing_output(
        {
            "hosting_pages": [
                {
                    "url": f"https://streamsports99.su/watch/{index}",
                    "title": f"Screenshot live card {index}",
                    "status": "live",
                }
                for index in range(1, 16)
            ],
            "extraction_summary": {
                "hosting_pages_found": 15,
                "visual_live_items_count": 24,
            },
        },
        source_url="https://streamsports99.su/",
        run_memory={"common": {}},
    )

    assert expanded == 0
    assert output["extraction_summary"]["expected_live_items_count"] == 24
    assert output["extraction_summary"]["visible_live_count_source"] == "screenshot_visual_count"
    assert output["extraction_summary"]["hosting_pages_missing_from_visible_count"] == 9
    assert output["extraction_summary"]["completion_gap"] is True


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


def test_hosting_normalizer_preserves_source_frontier_metadata() -> None:
    output = _normalize_hosting_output(
        {
            "servers": [
                {
                    "label": "Admin / Stream 1 / HD / English",
                    "source_group": "Admin",
                    "source_index": 2,
                    "source_url": "https://watch.example.com/game/admin-1",
                    "route_pattern": "/game/{provider}-{n}",
                    "current_marker": True,
                    "status": "failed",
                }
            ]
        }
    )

    server = output["servers"][0]
    assert server["source_group"] == "Admin"
    assert server["source_index"] == 2
    assert server["source_url"] == "https://watch.example.com/game/admin-1"
    assert server["route_pattern"] == "/game/{provider}-{n}"
    assert server["current_marker"] is True


def test_hosting_normalizer_preserves_popup_window_diagnostics() -> None:
    output = _normalize_hosting_output(
        {
            "servers": [
                {
                    "label": "Server 1",
                    "status": "failed",
                    "popup_diagnostics": [
                        {
                            "url": "https://ads.example/promo",
                            "classification": "ad_or_drift",
                            "action": "closed",
                            "extracted_player_urls": ["https://player.example/embed/1"],
                        }
                    ],
                }
            ]
        }
    )

    diagnostics = output["servers"][0]["popup_window_diagnostics"]
    assert diagnostics[0]["url"] == "https://ads.example/promo"
    assert diagnostics[0]["classification"] == "ad_or_drift"
    assert diagnostics[0]["action"] == "closed"
    assert diagnostics[0]["extracted_player_urls"] == ["https://player.example/embed/1"]


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


def test_embedded_normalizer_preserves_source_frontier_metadata() -> None:
    output = _normalize_embedded_output(
        {
            "servers": [
                {
                    "label": "Source 2 / Spanish",
                    "source_group": "player menu",
                    "source_index": 1,
                    "source_url": "https://embed.example.com/player?source=2",
                    "route_pattern": "?source={n}",
                    "current_marker": False,
                    "status": "failed",
                }
            ]
        }
    )

    server = output["servers"][0]
    assert server["source_group"] == "player menu"
    assert server["source_index"] == 1
    assert server["source_url"] == "https://embed.example.com/player?source=2"
    assert server["route_pattern"] == "?source={n}"
    assert server["current_marker"] is False


def test_embedded_normalizer_preserves_popup_window_diagnostics() -> None:
    output = _normalize_embedded_output(
        {
            "servers": [
                {
                    "label": "Source 1",
                    "status": "success",
                    "window_diagnostics": [
                        {
                            "url": "https://player.example/embed",
                            "classification": "same_content_player",
                            "action": "adopted",
                            "extracted_player_urls": ["https://player.example/embed"],
                        }
                    ],
                }
            ]
        }
    )

    diagnostics = output["servers"][0]["popup_window_diagnostics"]
    assert diagnostics[0]["url"] == "https://player.example/embed"
    assert diagnostics[0]["classification"] == "same_content_player"
    assert diagnostics[0]["action"] == "adopted"
    assert diagnostics[0]["extracted_player_urls"] == ["https://player.example/embed"]


def test_short_memory_captures_hosting_frontier_activation_and_observed_changes() -> None:
    memory = ShortTermMemory(page_type="hosting_page")

    memory.ingest_tool_result(
        "inspect_hosting",
        {"url": "https://site.example/watch/game-1"},
        {
            "server_frontier": [
                {
                    "label": "Server HD",
                    "source_group": "primary",
                    "source_index": 1,
                    "source_url": "/watch/game-1/server/1",
                    "selector": ".server-hd",
                    "route_pattern": "/watch/game-1/server/{n}",
                    "current_marker": True,
                }
            ],
            "activation_candidates": [
                {
                    "kind": "button",
                    "text": "Play",
                    "selector": ".play",
                    "frame_path": "root.0",
                    "reason": "visible player button",
                }
            ],
            "blocker_candidates": [
                {
                    "label": "Close ad",
                    "selector": ".ad-close",
                    "reason": "covers player",
                }
            ],
            "observed_change": {
                "navigated": False,
                "url_after": "https://site.example/watch/game-1",
                "target_decision": "same_page_update",
            },
        },
    )

    run_memory = memory.export_run_memory(page_type="hosting_page")
    assert run_memory["server_frontier"]
    assert run_memory["activation_targets"]
    assert run_memory["blocker_targets"]
    assert run_memory["observed_changes"]
    assert run_memory["agent_specific"]["hosting_page"]["server_frontier"]

    frontier = json.loads(run_memory["server_frontier"][0])
    assert frontier["label"] == "Server HD"
    assert frontier["source_group"] == "primary"
    assert frontier["source_url"] == "/watch/game-1/server/1"
    assert "https://site.example/watch/game-1/server/1" in run_memory["critical_links"]

    working_state = memory.working_state(
        objective="Extract all sources",
        page_type="hosting_page",
        page_url="https://site.example/watch/game-1",
    )
    assert "pending server/source frontier remembered: `1`" in working_state
    assert "activation targets remembered" in working_state
    assert "recent observed changes" in working_state
