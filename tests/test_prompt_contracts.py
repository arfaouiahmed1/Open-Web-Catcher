from pathlib import Path


PROMPT_DIR = Path(__file__).resolve().parents[1] / "configs" / "prompts"


def _prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


def test_browser_agent_prompts_keep_react_and_blocker_guardrails() -> None:
    for name in ("landing_page_v1.md", "hosting_page_v1.md", "embedded_page_v1.md"):
        text = _prompt(name)
        for token in ("OBSERVE", "STATE", "HYPOTHESIS", "ACTION", "VERIFY"):
            assert token in text
        for phrase in (
            "Curiosity guardrail",
            "screenshot",
            "Cloudflare",
            "site-down",
            "unrelated",
            "Do not repeat",
        ):
            assert phrase in text


def test_classification_and_orchestrator_prompts_preserve_failure_evidence() -> None:
    classification = _prompt("classification_v1.md")
    orchestrator = _prompt("orchestrator_v1.md")

    for phrase in (
        "Investigation Loop",
        "Challenge or Cloudflare-style verification",
        "Site unavailable",
        "News article",
    ):
        assert phrase in classification

    for phrase in (
        "Evidence Policy",
        "site-down",
        "persistent challenge",
        "provider analysis and email generation",
    ):
        assert phrase in orchestrator


def test_prompts_handle_background_video_and_click_to_play_routing() -> None:
    classification = _prompt("classification_v1.md")
    landing = _prompt("landing_page_v1.md")
    hosting = _prompt("hosting_page_v1.md")
    embedded = _prompt("embedded_page_v1.md")
    orchestrator = _prompt("orchestrator_v1.md")

    for phrase in (
        "Decorative video trap",
        "decorative/background/autoplay",
        "same-site watch/player shell",
        "direct embedded ownership is proven",
    ):
        assert phrase in classification

    for name, text in (
        ("landing", landing),
        ("hosting", hosting),
        ("embedded", embedded),
        ("orchestrator", orchestrator),
    ):
        assert "decorative/autoplay background video" in text, name

    for phrase in ("route_source", "redirect_chain", "click_to_play"):
        assert phrase in landing or phrase in hosting or phrase in orchestrator

    assert 'down_reason: "not_embedded_player"' in embedded
    assert 'embedded_url_source: "click_to_play_redirect"' in hosting


def test_prompts_preserve_live_focus_deep_link_recovery_and_short_memory() -> None:
    landing = _prompt("landing_page_v1.md")
    hosting = _prompt("hosting_page_v1.md")

    for phrase in (
        "Focus the downstream handoff on live/watchable matches",
        "Short memory should make later turns and agents avoid rediscovering",
        "top_match_candidates",
        "same repeated section/div",
        "Do not output an empty `hosting_pages` list while `top_match_candidates`",
        "popup",
    ):
        assert phrase in landing

    for phrase in (
        "net::ERR_INVALID_ARGUMENT",
        "landing redirect chain",
        "landing iframes to watch",
        "Keep short memory useful",
    ):
        assert phrase in hosting
