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


def test_classification_prompt_stops_on_other():
    prompt = Path("configs/prompts/classification_v1.md").read_text(encoding="utf-8")

    assert "classify as `other` and make `NEXT_STEPS` explicitly say to stop" in prompt
    assert "or `stop` when classification is `other`" in prompt


def test_landing_prompt_covers_navigation_and_match_extraction_flow():
    prompt = Path("configs/prompts/landing_page_v1.md").read_text(encoding="utf-8")

    assert "hosting-first" in prompt
    assert "inspect_landing" in prompt
    assert "query_elements" in prompt
    assert "pagination" in prompt
    assert "OBSERVE:" in prompt
    assert "HYPOTHESIS:" in prompt
    assert "VERIFY:" in prompt
    assert "stream_extractor" in prompt
    assert "embed_agent" in prompt
    assert '"participants": "Team A vs Team B"' in prompt
    assert '"channel": "Channel name"' in prompt
    assert "challenge_cleared" in prompt
    assert "access_state.challenge_detected" in prompt
    assert "memory_lookup" in prompt
    assert "memory_update" in prompt
    assert "return an empty `hosting_pages` list and stop" in prompt
    assert "Do not invent a downstream target." in prompt


def test_hosting_prompt_covers_server_switching_activation_and_network_extraction():
    prompt = Path("configs/prompts/hosting_page_v1.md").read_text(encoding="utf-8")

    assert "same-content okay" in prompt
    assert "assigned hosting" in prompt
    assert "Activate playback" in prompt
    assert "Always call `harvest` before final output." in prompt
    assert "inspect_hosting" in prompt
    assert "verify after every activation attempt and after every server switch" in prompt
    assert "network_diagnostics" in prompt
    assert "iframe_diagnostics" in prompt
    assert "access_state.challenge_detected" in prompt
    assert "early_stop_reason" in prompt
    assert '"decision": "safe_exit|needs_embed_agent|partial_success_needs_embed|no_stream_found"' in prompt
    assert "memory_lookup" in prompt
    assert "memory_update" in prompt
    assert "OBSERVE:" in prompt
    assert "VERIFY:" in prompt
    assert "try embedded fallback only when you have an explicit `embedded_url` or `player_iframe_url`, then stop" in prompt
    assert "Do not invent a next target." in prompt


def test_embedded_prompt_covers_frame_mapping_activation_and_capture():
    prompt = Path("configs/prompts/embedded_page_v1.md").read_text(encoding="utf-8")

    assert "inspect_embedded" in prompt
    assert "click_coordinates" in prompt
    assert "same-content okay" in prompt
    assert "Do not drift back into host-page exploration" in prompt
    assert "For each distinct server/source option" in prompt
    assert '"all_stream_urls"' in prompt
    assert "always run `harvest` before output" in prompt
    assert "access_state.challenge_detected" in prompt
    assert "challenge_cleared" in prompt
    assert "memory_lookup" in prompt
    assert "memory_update" in prompt
    assert "network_diagnostics" in prompt
    assert "iframe_diagnostics" in prompt
    assert "OBSERVE:" in prompt
    assert "VERIFY:" in prompt
    assert "Do not invent another fallback agent." in prompt
    assert "stop and summarize the failure in `session_summary`" in prompt
