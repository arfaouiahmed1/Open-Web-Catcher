"""Tests for site-focused short-term and long-term memory."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

from src.agents.memory import remember_agent_run
from src.memory.long_term import LongTermMemory
from src.memory.short_term import ShortTermMemory


def test_short_term_memory_tracks_navigation_and_tool_attempts():
    memory = ShortTermMemory(k=5)

    memory.record_navigation("https://example.com/watch/1", via="open_url")
    memory.record_tool("click_text", {"text": "Server 2"}, status="success", result_preview="clicked server switch")
    memory.record_observation("player activated after server switch", source="hosting")

    summary = memory.summary()

    assert "nav: https://example.com/watch/1 | open_url" in summary
    assert "tool: click_text [success] on text=Server 2" in summary
    assert "player activated after server switch" in summary


def test_short_term_memory_builds_bounded_working_state():
    memory = ShortTermMemory(k=6)

    memory.record_navigation("https://example.com/watch/1", via="open_url")
    memory.record_tool("click_text", {"text": "Server 2"}, status="success", result_preview="server switched")
    memory.record_tool(
        "wait_for_page_state",
        {"mode": "challenge_cleared"},
        status="error",
        result_preview="cloudflare challenge still active",
    )

    working_state = memory.working_state(
        objective="Extract streams from the host page.",
        page_url="https://example.com/watch/1",
        page_type="hosting_page",
    )

    assert "current objective" in working_state
    assert "steps already tried" in working_state
    assert "click_text on text=Server 2" in working_state
    assert "cloudflare challenge still active" in working_state
    assert "next best move" in working_state


def test_long_term_memory_builds_site_hints_for_future_runs(tmp_path):
    memory = LongTermMemory(str(tmp_path / "site_memory.db"))

    memory.remember(
        url="https://www.example.com/watch/1",
        page_type="hosting_page",
        status="success",
        payload={
            "decision": "safe_exit",
            "streaming_urls": [{"url": "https://cdn.example.com/master.m3u8", "type": "hls"}],
            "servers": [{"label": "Server 2"}],
        },
        short_memory_summary="- tool: click_text [success] on text=Server 2",
    )
    memory.remember(
        url="https://example.com/watch/2",
        page_type="hosting_page",
        status="failed",
        payload={
            "decision": "no_stream_found",
            "servers": [{"label": "Backup"}],
        },
    )

    prompt_context = memory.build_prompt_context(
        url="https://example.com/watch/9",
        page_type="hosting_page",
        limit=5,
    )

    assert "SITE MEMORY HINTS" in prompt_context
    assert "domain: `example.com`" in prompt_context
    assert "recent runs remembered: `2`" in prompt_context
    assert "recent successes: `1` / `2`" in prompt_context
    assert "repeated server labels" in prompt_context
    assert "Server 2" in prompt_context or "Backup" in prompt_context
    assert "previously seen stream hosts" in prompt_context
    assert "cdn.example.com" in prompt_context


def test_failed_runs_are_not_persisted_to_long_term_memory(tmp_path):
    memory = LongTermMemory(str(tmp_path / "site_memory.db"))
    observer = MagicMock()
    observer.trace.return_value = None
    observer.actor = "hosting_page_agent"
    observer.run_id = "run-1"

    remember_agent_run(
        memory,
        url="https://example.com/watch/3",
        page_type="hosting_page",
        status="failed",
        payload={"decision": "no_stream_found"},
        observer=observer,
        short_memory=ShortTermMemory(),
    )

    prompt_context = memory.build_prompt_context(
        url="https://example.com/watch/3",
        page_type="hosting_page",
        limit=5,
    )

    assert prompt_context == ""


def test_short_term_memory_extracts_structured_run_signals_from_tool_payloads():
    memory = ShortTermMemory(k=8)

    payload = json.dumps(
        {
            "matches": [
                {
                    "href": "https://example.com/live?page=2",
                    "selector": ".match-card a",
                }
            ],
            "streaming_urls": [
                {
                    "url": "https://cdn.example.com/master.m3u8",
                    "type": "m3u8",
                }
            ],
            "servers": [
                {
                    "label": "Server 2",
                    "embedded_url": "https://embed.example.com/player/xyz",
                }
            ],
        }
    )

    memory.ingest_tool_result(
        "query_elements",
        {
            "url": "https://example.com/live?page=2",
            "selector": ".match-card a",
        },
        payload,
    )

    run_memory = memory.export_run_memory()
    assert "https://example.com/live?page=2" in run_memory["critical_links"]
    assert any("page={n}" in pattern for pattern in run_memory["pagination_patterns"])
    assert "https://cdn.example.com/master.m3u8" in run_memory["stream_urls"]
    assert "cdn.example.com" in run_memory["stream_hosts"]
    assert "Server 2" in run_memory["server_labels"]


def test_long_term_profile_memory_upsert_and_prompt_context(tmp_path):
    memory = LongTermMemory(str(tmp_path / "site_memory.db"))

    memory.upsert_profile(
        url="https://example.com/live/123",
        page_type="landing_page",
        patch={
            "selectors": ["selector=.match-card a", "xpath=//main//a[contains(@href, '/live/')]"],
            "pagination_url_patterns": ["https://example.com/live?page={n}"],
            "url_patterns": ["https://example.com/live/{n}"],
            "critical_links": ["https://example.com/live/123"],
            "navigation_hints": ["url=https://example.com/live/123"],
        },
        source="mcp_tool",
        reason="initial memory seed",
    )

    memory.remember(
        url="https://example.com/live/123",
        page_type="landing_page",
        status="success",
        payload={
            "hosting_pages": [{"url": "https://example.com/watch/555"}],
            "run_memory": {
                "url_patterns": ["https://example.com/watch/{n}"],
                "critical_links": ["https://example.com/watch/555"],
            },
        },
    )

    context = memory.build_prompt_context(
        url="https://example.com/live/999",
        page_type="landing_page",
        limit=5,
    )

    profile = memory.get_profile(url="https://example.com/live/999", page_type="landing_page")

    assert profile.get("revision", 0) >= 1
    assert "selector=.match-card a" in profile.get("selectors", [])
    assert "https://example.com/live?page={n}" in profile.get("pagination_url_patterns", [])
    assert "https://example.com/watch/555" in profile.get("critical_links", [])

    assert "remembered selectors/actions" in context
    assert "remembered pagination url patterns" in context
    assert "memory-first policy" in context


def test_short_term_memory_exports_landing_specific_candidate_memory():
    memory = ShortTermMemory(k=20, page_type="landing_page")
    payload = {
        "hosting_pages": [
            {"url": f"https://example.com/watch/{index}", "title": f"Match {index}"}
            for index in range(1, 261)
        ]
    }

    memory.ingest_tool_result(
        "inspect_landing",
        {"url": "https://example.com/live"},
        payload,
    )

    run_memory = memory.export_run_memory(page_type="landing_page")
    assert run_memory["page_type"] == "landing_page"
    assert len(run_memory["hosting_candidate_urls"]) >= 250
    assert "landing_page" in run_memory["agent_specific"]
    assert len(run_memory["agent_specific"]["landing_page"]["hosting_candidate_urls"]) >= 250


def test_long_term_memory_keeps_landing_and_hosting_profiles_separate(tmp_path):
    memory = LongTermMemory(str(tmp_path / "site_memory.db"))

    landing_payload = {
        "hosting_pages": [
            {"url": f"https://example.com/watch/{index}", "title": f"Match {index}"}
            for index in range(1, 231)
        ]
    }
    memory.remember(
        url="https://example.com/live/today",
        page_type="landing_page",
        status="success",
        payload=landing_payload,
    )

    hosting_payload = {
        "decision": "safe_exit",
        "servers": [
            {
                "label": f"Server {index}",
                "status": "success",
                "server_up": True,
                "player_state": "playing",
                "screenshot_url": f"https://img.example.com/server-{index}.png",
                "m3u8_urls": [f"https://cdn.example.com/{index}/master.m3u8"],
                "primary_stream": f"https://cdn.example.com/{index}/master.m3u8",
            }
            for index in range(1, 36)
        ],
    }
    memory.remember(
        url="https://example.com/watch/999",
        page_type="hosting_page",
        status="success",
        payload=hosting_payload,
    )

    landing_profile = memory.get_profile(url="https://example.com/live/next", page_type="landing_page")
    hosting_profile = memory.get_profile(url="https://example.com/watch/1000", page_type="hosting_page")

    assert len(landing_profile.get("hosting_candidate_urls", [])) >= 200
    assert landing_profile.get("server_records", []) == []

    assert len(hosting_profile.get("server_records", [])) >= 30
    assert len(hosting_profile.get("activated_servers", [])) >= 30
    assert hosting_profile.get("hosting_candidate_urls", []) == []
