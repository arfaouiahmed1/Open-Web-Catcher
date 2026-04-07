"""Tests for site-focused short-term and long-term memory."""

from __future__ import annotations

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
