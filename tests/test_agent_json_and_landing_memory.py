from src.agents.base import parse_json_object
from src.agents.landing_page import _augment_landing_output, _normalize_hosting_pages
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


def test_landing_normalizer_coerces_nulls_and_drops_explicit_non_live_without_player() -> None:
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
            },
        ],
        source_url="https://site.example/v3",
    )

    assert [page["url"] for page in pages] == ["https://site.example/match/live-1"]
    assert pages[0]["title"] == ""
    assert pages[0]["participants"] == ""
    assert pages[0]["redirect_chain"] == ["https://site.example/v3"]


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
