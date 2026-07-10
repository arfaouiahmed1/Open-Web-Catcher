from pathlib import Path


PROMPT_DIR = Path(__file__).resolve().parents[1] / "configs" / "prompts"
AGENT_DIR = Path(__file__).resolve().parents[1] / "src" / "agents"


def _prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


def _agent(name: str) -> str:
    return (AGENT_DIR / name).read_text(encoding="utf-8")


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


def test_classification_prompt_clears_visible_popups_before_deciding() -> None:
    classification = _prompt("classification_v1.md")

    for phrase in (
        "Popup-first rule",
        "do not classify the popup itself as the page",
        "Already a member, continue",
        "popups[].close_selector",
        "popups[].close_xpath",
        "Avoid external/action buttons",
        "Join Discord",
        "Bookmark",
        "After the dismissal click",
        "classify that underlying page state",
        "Promotional popups and welcome modals",
        "Record the popup in `ANOMALIES`",
    ):
        assert phrase in classification


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


def test_landing_prompt_enforces_bounded_crawler_contract() -> None:
    landing = _prompt("landing_page_v1.md")

    for phrase in (
        "Crawler Contract",
        "Work like a bounded, evidence-driven crawler",
        "return every currently visible or reachable live match",
        "Maintain a `crawl_frontier[]`",
        "representative_verified",
        "accepted_sibling",
        "rejected_with_reason",
        "Efficient crawler loop",
        "Verify one representative per distinct pattern",
        "bulk-add same-pattern siblings",
        "Pagination URLs are crawl frontier, never final hosting targets",
        "accepted+rejected+blocked candidates reconcile",
        "Do not return an empty or sparse `hosting_pages` result",
        "False-positive discipline",
        "If accepted candidates are fewer than the visible live rows",
    ):
        assert phrase in landing


def test_all_prompts_make_react_mandatory() -> None:
    for name in (
        "classification_v1.md",
        "orchestrator_v1.md",
        "landing_page_v1.md",
        "hosting_page_v1.md",
        "embedded_page_v1.md",
    ):
        text = _prompt(name)
        assert "mandatory" in text.lower(), name
        if name != "orchestrator_v1.md":
            for token in ("OBSERVE", "STATE", "HYPOTHESIS", "ACTION", "VERIFY"):
                assert token in text, name


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


def test_browser_prompts_cover_popup_windows_ublock_and_llm_activation() -> None:
    classification = _prompt("classification_v1.md")
    landing = _prompt("landing_page_v1.md")
    hosting = _prompt("hosting_page_v1.md")
    embedded = _prompt("embedded_page_v1.md")
    orchestrator = _prompt("orchestrator_v1.md")

    for name, text in (
        ("classification", classification),
        ("landing", landing),
        ("hosting", hosting),
        ("embedded", embedded),
        ("orchestrator", orchestrator),
    ):
        for phrase in (
            "opened_targets",
            "blocked_popup_attempts",
            "target_decision",
            "blocked_by_client",
            "Do not trust same hostname alone",
        ):
            assert phrase in text, name

    for name, text in (("hosting", hosting), ("embedded", embedded)):
        for phrase in (
            "activation_candidates",
            "blocker_candidates",
            "needs_agent_choice",
            "popup_window_diagnostics",
            "Choose the activation target yourself",
            "Do not rely on hardcoded play/control guessing",
            "A bare `play_media` call returns `needs_agent_choice`",
        ):
            assert phrase in text, name

    for phrase in (
        "popup/window/uBlock evidence",
        "Browser-blocked popups and uBlock",
        "Same-content adoption requires",
        "LLM-chosen activation",
        "popup_window_diagnostics",
    ):
        assert phrase in orchestrator


def test_agent_contracts_cover_popup_windows_ublock_and_llm_activation() -> None:
    classification = _agent("classification.py")
    landing = _agent("landing_page.py")
    hosting = _agent("hosting_page.py")
    embedded = _agent("embedded_page.py")
    orchestrator = _agent("orchestrator.py")

    for name, text in (
        ("classification", classification),
        ("landing", landing),
        ("hosting", hosting),
        ("embedded", embedded),
        ("orchestrator", orchestrator),
    ):
        for phrase in (
            "opened_targets",
            "blocked_popup_attempts",
            "target_decision",
            "blocked_by_client",
            "popup/window",
        ):
            assert phrase in text, name

    for name, text in (("hosting", hosting), ("embedded", embedded)):
        for phrase in (
            "activation_candidates",
            "bare play_media is only candidate discovery",
            "popup_window_diagnostics",
            "same hostname alone",
            "extracted_player_urls",
        ):
            assert phrase in text, name

    assert "popup_window_diagnostics" in orchestrator
    assert "extracted_player_urls" in orchestrator


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
        "External URLs may be probed",
        "recover once with `go_back`",
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
            "Remove a visible popup/modal/overlay",
            "Popup removal rule",
            "popups[].close_selector",
            "popups[].close_xpath",
            "close_selector",
            "close_xpath",
            'down_reason: "player_blocked_by_popup"',
            "Do not harvest or take final played-video evidence while a popup visibly covers the player",
            "Server-only navigation rule",
            "Do not navigate to another match",
            "If a click opens another match/channel/listing/category/news/homepage",
            "compare it to the assigned title/team/channel/time",
            "extracted_player_urls",
            "cross-domain page",
            "go_back",
        ):
            assert phrase in text, name

    assert "Do not re-run landing discovery from a hosting page" in hosting
    assert "Embedded has no downstream fallback" in embedded


def test_prompts_handle_full_page_and_player_view_blockers() -> None:
    landing = _prompt("landing_page_v1.md")
    hosting = _prompt("hosting_page_v1.md")
    embedded = _prompt("embedded_page_v1.md")

    for phrase in (
        "anything that blocks the body",
        "hides all useful page content",
        "full-screen interstitials",
        "anti-adblock notices",
        "transparent click shields",
        "Do not return sparse or empty `hosting_pages` merely because the initial screenshot was blocked",
        "crawl the revealed body",
        "concrete full-page blocker",
    ):
        assert phrase in landing

    for name, text in (("hosting", hosting), ("embedded", embedded)):
        for phrase in (
            "anything that blocks the assigned player view or the whole viewport",
            "anti-adblock notices",
            "notification prompts",
            "sticky/floating ads",
            "transparent click shields",
            "full-screen interstitials",
            "Remove a visible player blocker before activation",
            "Do not treat a blocker-dismissal click as a play/activation attempt",
            "continue with activation from the newly revealed player state",
            "selector/xpath/text evidence",
        ):
            assert phrase in text, name

    assert "Do not harvest, hand off to embedded, or take final played-video evidence" in hosting
    assert "Remove a visible popup/modal/overlay or player blocker" in embedded


def test_agent_contracts_handle_full_page_and_player_view_blockers() -> None:
    landing = _agent("landing_page.py")
    hosting = _agent("hosting_page.py")
    embedded = _agent("embedded_page.py")

    for phrase in (
        "full-page blocker",
        "hides body candidates",
        "clear safe same-page dismissal controls",
        "verify the revealed page state",
    ):
        assert phrase in landing

    for name, text in (("hosting", hosting), ("embedded", embedded)):
        for phrase in (
            "anything that blocks the assigned player view or whole viewport",
            "anti-adblock notices",
            "transparent click shields",
            "full-screen interstitials",
            "blocker_candidates",
            "if a click only dismisses a blocker",
            "do not count it as activation",
            "continue activation from the revealed state",
        ):
            assert phrase in text, name


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


def test_hosting_prompt_detects_multilingual_source_rows_and_navigation_switches() -> None:
    hosting = _prompt("hosting_page_v1.md")

    for phrase in (
        "Multilingual server/source detection",
        "Infer server switches from structure and role, not English words",
        "Rows, cards, tabs, buttons, links, dropdown options",
        "Stream 1",
        "Server HD",
        "Option 1",
        "Link 1",
        "servidor",
        "fuente",
        "opção",
        "idioma",
        "سيرفر",
        "مصدر",
        "جودة",
        "Source enumeration rule",
        "3 of 3 sources",
        "2 streams",
        "5 streams",
        "Do not stop at the first working source",
        "If `inspect_hosting` misses visually obvious source rows",
        "use `navigate` only when the destination clearly remains the same assigned event/channel/player",
        "If it is JS-only or in-place, use `interact`",
    ):
        assert phrase in hosting


def test_hosting_prompt_requires_full_server_frontier_crawl() -> None:
    hosting = _prompt("hosting_page_v1.md")

    for phrase in (
        "Full server crawl loop",
        "Build `server_frontier[]` before the first risky click",
        "landing handoff includes server/source hints",
        "source_group",
        "source_index",
        "source_url",
        "route_pattern",
        "current marker",
        "landing handoff",
        "Do not stop after first successful server",
        "return to `mainUrl` or last reliable server-list URL/state",
        "Preserve route patterns",
        "never generate unvisited server URLs from a pattern",
        "Store every attempted source as one `servers[]` entry",
        "Event-page hierarchy rule",
        "`inspect_hosting.event_server_routes[]`",
        "same event slug/title",
        "/watch/<event>/<provider>/<number>",
        "When the assigned URL already includes a provider/index child route",
    ):
        assert phrase in hosting


def test_landing_prompt_passes_event_server_hints_to_hosting() -> None:
    landing = _prompt("landing_page_v1.md")

    for phrase in (
        "server_hints",
        "return the event URL as the hosting candidate",
        "same-event stream links",
        "Do not emit each child stream route as a separate match",
        "The hosting agent owns opening each same-event route",
        '"source_group"',
        '"source_index"',
        '"source_url"',
        '"route_pattern"',
    ):
        assert phrase in landing


def test_embedded_prompt_keeps_server_source_loop_open() -> None:
    embedded = _prompt("embedded_page_v1.md")

    for phrase in (
        "Embedded server/source loop",
        "usually a single source",
        "server/source controls are present under or inside the iframe",
        "Build `server_frontier[]`",
        "same-player source navigation",
        "Do not stop after the first successful embedded source",
        "remove popups, activate/play, capture post-activation screenshot/media state, harvest",
        "recover once to `embedded_url` or the last reliable same-player URL",
        "Embedded has no fallback to landing/hosting discovery",
    ):
        assert phrase in embedded


def test_hosting_and_embedded_prompts_react_to_dynamic_source_content() -> None:
    hosting = _prompt("hosting_page_v1.md")
    embedded = _prompt("embedded_page_v1.md")

    for name, text in (("hosting", hosting), ("embedded", embedded)):
        for phrase in (
            "Dynamic content reaction",
            "newly visible controls",
            "merge them into `server_frontier[]` immediately",
            "Do not assume nothing happened just because navigation did not occur",
            "not exhausted until those",
        ):
            assert phrase in text, name

    assert "before final JSON or embedded handoff" in hosting
    assert "before final JSON" in embedded


def test_landing_prompt_prioritizes_body_and_stays_on_main_domain() -> None:
    landing = _prompt("landing_page_v1.md")
    landing_agent = _agent("landing_page.py")

    for phrase in (
        "Region priority is body first",
        "Main body live/watch/channel tiles",
        "Header/footer candidates must not outrank body candidates",
        "Header/footer navigation is a last-resort route",
        "Do not spend tool calls on header/footer links while any body live/watch/channel row",
        "Domain discipline",
        "stay anchored to `mainUrl`'s normalized domain/site",
        "External URLs are allowed as probes",
        "extracted_player_urls",
        "off-target provider page",
    ):
        assert phrase in landing

    assert "header/footer navigation is a last-resort path" in landing_agent


def test_landing_prompt_rejects_article_news_cards_before_match_widgets() -> None:
    landing = _prompt("landing_page_v1.md")
    landing_agent = _agent("landing_page.py")

    for phrase in (
        "Article/news URLs such as `/read/...`, `/post/...`, `/article/...`, `/news/...`",
        "related-story cards are not hosting targets",
        "Article pages can still contain real match cards or channel widgets",
        "Extract the body match/card/widget URLs or reveal controls",
        "not the article URL, related news cards, breadcrumbs, header links, or latest/popular-story cards",
        "reject it as `news_article_link`",
        "On article/detail pages, ignore breadcrumbs, share links, related posts",
        "News/article cards remain rejected unless they expose player/server/match-card evidence",
    ):
        assert phrase in landing

    assert "reject article/news URLs such as /read, /post, /article, and /news" in landing_agent
    assert "related news cards and headers are not hosting_pages" in landing_agent


def test_hosting_prompt_requires_iframe_local_activation_before_handoff() -> None:
    hosting = _prompt("hosting_page_v1.md")
    hosting_agent = _agent("hosting_page.py")

    for phrase in (
        "iframe-local `sample_buttons`, `sample_links`, `sample_videos`",
        "Do not hand off to embedded just because the player is in an iframe",
        "choose an exact iframe `frame_path` target",
        "When a visible player iframe contains a video element or Play/Watch/Start control",
        "iframe existence alone is not enough for handoff",
    ):
        assert phrase in hosting

    for phrase in (
        "iframe-local sample_buttons, sample_links, or sample_videos",
        "try play_media or interact before embedded handoff",
        "iframe-local activation was tried or inaccessible",
    ):
        assert phrase in hosting_agent
