"""Prompt and local dataset regression tests."""

from __future__ import annotations

import json
from pathlib import Path

from src.evaluation.datasets import load_test_cases

CASES_PATH = Path("data/test_cases/sites.json")


def test_load_test_cases_missing_file():
    cases = load_test_cases("data/test_cases/nonexistent.json")
    assert cases == []


def test_load_test_cases_valid(tmp_path):
    cases_file = tmp_path / "sites.json"
    cases_file.write_text(json.dumps([
        {"url": "https://example.com", "expected_type": "landing_page"}
    ]))
    cases = load_test_cases(cases_file)
    assert len(cases) == 1
    assert cases[0]["expected_type"] == "landing_page"


def test_landing_prompt_covers_navigation_and_match_extraction_flow():
    prompt = Path("configs/prompts/landing_page_v1.md").read_text(encoding="utf-8")

    assert "Discover every URL that leads to a watchable hosting page." in prompt
    assert "query_elements" in prompt
    assert "When pagination is detected" in prompt
    assert "Verify Hosting Patterns" in prompt
    assert '"participants": "Team A vs Team B"' in prompt
    assert '"channel": "Channel name"' in prompt
    assert "challenge_cleared" in prompt
    assert "access_state.challenge_detected" in prompt


def test_hosting_prompt_covers_server_switching_activation_and_network_extraction():
    prompt = Path("configs/prompts/hosting_page_v1.md").read_text(encoding="utf-8")

    assert "Try every detected server/source path you can find." in prompt
    assert "Activate playback" in prompt
    assert "Always call `capture_streams` before final output." in prompt
    assert "If the page navigates away unintentionally, recover with `open_url(mainUrl)`." in prompt
    assert "access_state.challenge_detected" in prompt
    assert "early_stop_reason" in prompt
    assert '"decision": "safe_exit|needs_embed_agent|partial_success_needs_embed|no_stream_found"' in prompt


def test_embedded_prompt_covers_frame_mapping_activation_and_capture():
    prompt = Path("configs/prompts/embedded_page_v1.md").read_text(encoding="utf-8")

    assert "Map frames and player" in prompt
    assert "click_coordinates" in prompt
    assert "Try all source/server options" in prompt
    assert '"all_stream_urls"' in prompt
    assert "Never end on context alone." in prompt
    assert "access_state.challenge_detected" in prompt
    assert "challenge_cleared" in prompt
