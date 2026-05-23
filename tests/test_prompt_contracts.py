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
        "Focus the downstream handoff on live events, upcoming scheduled events",
        "Live sports events happening now",
        "Upcoming sports events scheduled for later today or this week",
        "Live TV/channel pages",
        "Reject replays, VODs, finished matches",
        "Memory is pattern guidance",
        "top_match_candidates",
        "candidate_ledger",
        "candidate_groups",
        "reveal_actions",
        "collapsed_sections",
        "same-pattern siblings",
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


def test_landing_prompt_uses_react_screenshots_and_broad_then_scoped_tools() -> None:
    landing = _prompt("landing_page_v1.md")

    for phrase in (
        "Broad Then Scoped Tool Policy",
        "observed_change",
        "Frontier Policy",
        "current-page candidate ledger",
        "next cheapest proof",
        "Use it with at least one real predicate or scope",
        "Do not call broad queries like",
        "screenshot before asking for more DOM",
        "Use the returned URL, status, `screenshot_url`, `observed_change`, and visual state",
    ):
        assert phrase in landing

    assert "Heavy-first reliability path" not in landing
    assert '{ "kind": "link", "limit": 10 }' in landing


def test_landing_prompt_reconciles_inspect_screenshots_and_inline_servers() -> None:
    landing = _prompt("landing_page_v1.md")

    for phrase in (
        "If the screenshot visibly shows many repeated live/watch rows",
        "Reconcile the screenshot with `candidate_ledger`",
        "If the broad inspect missed visible rows",
        "Use `interact` aggressively but precisely",
        "server/source lists expanded directly under the selected landing row or card",
        "Inline server/source controls can exist directly on a landing/listing page",
        "Set `route_source` to `inline_server_list` or `js_expanded_row`",
        "Full extraction rule",
        "extract the full visible candidate set for that pattern",
    ):
        assert phrase in landing


def test_landing_prompt_requires_section_and_pattern_complete_extraction() -> None:
    landing = _prompt("landing_page_v1.md")

    for phrase in (
        "Clean Landing Extraction Steps",
        "Section inventory",
        "work section by section",
        "row list, grid, table, card group, channel directory",
        "Keep the full visible candidate set for each bucket",
        "score/countdown/badge signals",
        "Row-by-row and grid-by-grid completion",
        "Do not abandon remaining body sections because the first bucket worked",
        "Final completeness check",
        "compare `hosting_pages` against the screenshot-visible rows/grids/sections",
        "Visible count reconciliation",
        "Live-count rule",
        "Live Matches (36)",
        "completion_gap=true",
        "Context compression is allowed",
        "visually count the live cards",
        "screenshot_live_items_count",
    ):
        assert phrase in landing


def test_hosting_and_embedded_prompts_keep_paused_stream_protocol_evidence() -> None:
    for name in ("hosting_page_v1.md", "embedded_page_v1.md"):
        text = _prompt(name)
        for phrase in (
            "Paused players can still expose real streams",
            "A working-player verdict and a stream-discovery verdict are separate",
            "Do not discard URLs only because the player did not play",
            "Protocol detail rules",
            "`protocol_details`",
            "tokenized: true",
            "Do not strip query strings",
            'visual_confirmation: "player paused/loading but streams captured"',
        ):
            assert phrase in text, name


def test_hosting_and_embedded_prompts_are_agentic_not_hardcoded() -> None:
    for name in ("hosting_page_v1.md", "embedded_page_v1.md"):
        text = _prompt(name)
        for phrase in (
            "Broad Then Scoped Tool Policy",
            "ReAct Loop",
            "server/source controls",
            "harvest after meaningful state changes",
            "Use it with a real predicate or scope",
            "Do not repeat",
        ):
            assert phrase in text, name

        for hardcoded_phrase in (
            "Known channel examples include",
            "beIN SPORTS, Sky Sports",
            "Heavy-first reliability path",
        ):
            assert hardcoded_phrase not in text, name


def test_prompts_handle_multilingual_channel_grids_and_bad_redirects() -> None:
    classification = _prompt("classification_v1.md")
    landing = _prompt("landing_page_v1.md")
    hosting = _prompt("hosting_page_v1.md")
    embedded = _prompt("embedded_page_v1.md")

    for phrase in (
        "Multilingual and RTL pages",
        "channel-logo directory or TV channel grid",
        "Ad redirect or off-target provider page",
    ):
        assert phrase in classification

    for phrase in (
        "Multilingual pages are normal",
        "Domain discipline",
        "External URLs require explicit same-content watch/player evidence",
        "channel-logo or directory cards",
        "memory_update",
    ):
        assert phrase in landing

    for name, text in (("hosting", hosting), ("embedded", embedded)):
        for phrase in (
            "Multilingual channel rules",
            "Work across any language and script",
            "Bad redirect handling",
            "fake download pages",
            "memory_update",
        ):
            assert phrase in text, name


def test_landing_and_hosting_handle_click_to_load_servers_after_play() -> None:
    landing = _prompt("landing_page_v1.md")
    hosting = _prompt("hosting_page_v1.md")

    for phrase in (
        "play/watch/reveal buttons",
        "server/source controls",
        "server/source lists expanded directly under the selected landing row or card",
        "Off-air live TV channels are valid `not_live` candidates",
        "does not extract final streams",
    ):
        assert phrase in landing

    for phrase in (
        "After every Play/Watch/Start/overlay click",
        "post-click server/source check",
        "Do not call a Play/Watch overlay failed",
        "max 3 distinct activation strategies",
        "strategy ladder",
        "newly visible server/source button",
        "Server-only navigation rule",
        "Do not re-run landing discovery from a hosting page",
        "another match or channel",
        "popup/modal/overlay that covers the player",
    ):
        assert phrase in hosting


def test_hosting_and_embedded_prompts_dismiss_popups_and_stay_same_content() -> None:
    hosting = _prompt("hosting_page_v1.md")
    embedded = _prompt("embedded_page_v1.md")

    for name, text in (("hosting", hosting), ("embedded", embedded)):
        for phrase in (
            "Popups that cover the player are not final failure evidence",
            "Dismiss a visible popup/modal/overlay",
            "Server-only navigation rule",
            "Do not navigate to another match",
            "If a click opens another match/channel/listing/category/news/homepage",
            "compare it to the assigned title/team/channel/time",
        ):
            assert phrase in text, name

    assert "Do not re-run landing discovery from a hosting page" in hosting
    assert "Embedded has no downstream fallback" in embedded


def test_hosting_and_embedded_prompts_require_played_screenshot_before_harvest() -> None:
    hosting = _prompt("hosting_page_v1.md")
    embedded = _prompt("embedded_page_v1.md")

    for name, text in (("hosting", hosting), ("embedded", embedded)):
        for phrase in (
            "Mandatory activation proof",
            "attempt to play the player before harvest",
            "post-activation player state",
            "played-video screenshot",
            "activation -> played-state screenshot -> harvest sequence",
            "Do not reuse the previous",
            "Harvest should normally happen after activation and post-activation screenshot evidence",
            "Required per",
            "post-activation screenshot",
        ):
            assert phrase in text, name

    assert "For the default server and every server/source switch" in hosting
    assert "After every server/source switch" in hosting
    assert "For the default source and every source/server switch" in embedded
    assert "After every source/server switch" in embedded


def test_landing_prompt_prioritizes_body_and_stays_on_main_domain() -> None:
    landing = _prompt("landing_page_v1.md")

    for phrase in (
        "Region priority is body first",
        "Main body live/watch/channel tiles",
        "Header/footer candidates must not outrank body candidates",
        "Domain discipline",
        "stay anchored to `mainUrl`'s normalized domain/site",
        "External URLs require explicit same-content watch/player evidence",
        "off-target provider page",
    ):
        assert phrase in landing
