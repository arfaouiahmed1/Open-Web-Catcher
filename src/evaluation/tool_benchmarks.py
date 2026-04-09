"""Benchmark catalog for MCP tool scenarios."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from src.tools.mcp_client import REQUIRED_TOOLS_BY_PROFILE


@dataclass(frozen=True)
class ToolInvocation:
    tool_name: str
    args: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class ToolBenchmarkCase:
    tool_name: str
    profile: str
    description: str
    scenario: str
    benchmark_step: ToolInvocation
    setup_steps: tuple[ToolInvocation, ...] = ()
    tags: tuple[str, ...] = ()

    def render(self, *, base_url: str) -> "ToolBenchmarkCase":
        return ToolBenchmarkCase(
            tool_name=self.tool_name,
            profile=self.profile,
            description=self.description,
            scenario=self.scenario,
            benchmark_step=ToolInvocation(
                tool_name=self.benchmark_step.tool_name,
                args=_render_args(self.benchmark_step.args, base_url=base_url),
            ),
            setup_steps=tuple(
                ToolInvocation(tool_name=step.tool_name, args=_render_args(step.args, base_url=base_url))
                for step in self.setup_steps
            ),
            tags=self.tags,
        )


def _render_args(value: Any, *, base_url: str) -> Any:
    if isinstance(value, str):
        return value.replace("{base_url}", base_url.rstrip("/"))
    if isinstance(value, dict):
        return {key: _render_args(item, base_url=base_url) for key, item in value.items()}
    if isinstance(value, list):
        return [_render_args(item, base_url=base_url) for item in value]
    if isinstance(value, tuple):
        return tuple(_render_args(item, base_url=base_url) for item in value)
    return value


TOOL_BENCHMARKS: dict[str, ToolBenchmarkCase] = {
    "navigate": ToolBenchmarkCase(
        tool_name="navigate",
        profile="classification",
        description="Legacy navigate wrapper used by some agents/tools.",
        scenario="Backward-compatible navigation path.",
        benchmark_step=ToolInvocation(
            tool_name="navigate",
            args={"url": "{base_url}/watch", "wait_until": "networkidle2", "timeout_ms": 30000},
        ),
        tags=("navigation", "legacy"),
    ),
    "inspect": ToolBenchmarkCase(
        tool_name="inspect",
        profile="classification",
        description="Legacy inspect wrapper for classification profile.",
        scenario="Backward-compatible page inspection path.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/watch", "wait_until": "networkidle2"}),
        ),
        benchmark_step=ToolInvocation("inspect", {}),
        tags=("context", "legacy"),
    ),
    "inspect_landing": ToolBenchmarkCase(
        tool_name="inspect_landing",
        profile="landing",
        description="Legacy landing inspect wrapper.",
        scenario="Backward-compatible landing inspection path.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "networkidle2"}),
        ),
        benchmark_step=ToolInvocation("inspect_landing", {}),
        tags=("context", "legacy"),
    ),
    "inspect_hosting": ToolBenchmarkCase(
        tool_name="inspect_hosting",
        profile="hosting",
        description="Legacy hosting inspect wrapper.",
        scenario="Backward-compatible hosting inspection path.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "networkidle2"}),
        ),
        benchmark_step=ToolInvocation("inspect_hosting", {}),
        tags=("context", "legacy"),
    ),
    "inspect_embedded": ToolBenchmarkCase(
        tool_name="inspect_embedded",
        profile="embedded",
        description="Legacy embedded inspect wrapper.",
        scenario="Backward-compatible embedded inspection path.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/embedded", "wait_until": "networkidle2"}),
        ),
        benchmark_step=ToolInvocation("inspect_embedded", {}),
        tags=("context", "legacy"),
    ),
    "interact": ToolBenchmarkCase(
        tool_name="interact",
        profile="hosting",
        description="Legacy interact wrapper for click/play/type actions.",
        scenario="Backward-compatible generic interaction path.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "interact",
            {"mode": "click", "frame_path": "root", "selector": ".server-button[data-server='2']", "wait_ms": 1200},
        ),
        tags=("actions", "legacy"),
    ),
    "screenshot": ToolBenchmarkCase(
        tool_name="screenshot",
        profile="hosting",
        description="Legacy screenshot wrapper.",
        scenario="Backward-compatible screenshot capture path.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "networkidle2"}),
        ),
        benchmark_step=ToolInvocation("screenshot", {}),
        tags=("media", "legacy"),
    ),
    "harvest": ToolBenchmarkCase(
        tool_name="harvest",
        profile="hosting",
        description="Legacy stream harvesting wrapper.",
        scenario="Backward-compatible stream extraction path.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "networkidle2"}),
            ToolInvocation("play_media", {"frame_path": "root.0", "selector": "video", "wait_ms": 1500}),
        ),
        benchmark_step=ToolInvocation("harvest", {"duration_ms": 12000, "player_iframe_url": "{base_url}/player"}),
        tags=("media", "legacy"),
    ),
    "memory_lookup": ToolBenchmarkCase(
        tool_name="memory_lookup",
        profile="classification",
        description="Lookup memory context before running classification decisions.",
        scenario="Memory-aware classification warmup.",
        benchmark_step=ToolInvocation("memory_lookup", {"query": "sports stream host", "k": 5}),
        tags=("memory", "context"),
    ),
    "memory_update": ToolBenchmarkCase(
        tool_name="memory_update",
        profile="classification",
        description="Persist an outcome signal into memory after run completion.",
        scenario="Memory write-back path.",
        benchmark_step=ToolInvocation(
            "memory_update",
            {
                "key": "last_provider",
                "value": {"provider": "example-cdn", "source": "benchmark"},
            },
        ),
        tags=("memory", "write"),
    ),
    "open_url": ToolBenchmarkCase(
        tool_name="open_url",
        profile="classification",
        description="Open a watch page from a cold browser session.",
        scenario="Baseline navigation into a watch-like page before classification or extraction.",
        benchmark_step=ToolInvocation(
            tool_name="open_url",
            args={"url": "{base_url}/watch", "wait_until": "networkidle2", "timeout_ms": 30000},
        ),
        tags=("navigation", "entry"),
    ),
    "get_page_context": ToolBenchmarkCase(
        tool_name="get_page_context",
        profile="landing",
        description="Collect top-level page context after opening a landing page.",
        scenario="Landing navigation and match extraction kickoff.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "networkidle2"}),
        ),
        benchmark_step=ToolInvocation("get_page_context", {"frame_path": "root"}),
        tags=("context", "landing"),
    ),
    "query_elements": ToolBenchmarkCase(
        tool_name="query_elements",
        profile="landing",
        description="Find likely watch links and server controls on the current page.",
        scenario="Landing page match discovery and hosting page server switch discovery.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "networkidle2"}),
        ),
        benchmark_step=ToolInvocation(
            "query_elements",
            {
                "frame_path": "root",
                "kind": "link",
                "text_contains": "watch",
                "visible_only": True,
                "limit": 10,
            },
        ),
        tags=("context", "discovery"),
    ),
    "get_element_detail": ToolBenchmarkCase(
        tool_name="get_element_detail",
        profile="landing",
        description="Inspect one ambiguous match or server element before acting on it.",
        scenario="Resolve ambiguous landing navigation targets.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "networkidle2"}),
        ),
        benchmark_step=ToolInvocation(
            "get_element_detail",
            {"frame_path": "root", "selector": ".match-card a.watch-link"},
        ),
        tags=("context", "inspection"),
    ),
    "get_frame_tree": ToolBenchmarkCase(
        tool_name="get_frame_tree",
        profile="embedded",
        description="Map the frame structure before extracting from an embedded player.",
        scenario="Embedded iframe discovery before player activation.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/embedded", "wait_until": "networkidle2"}),
        ),
        benchmark_step=ToolInvocation("get_frame_tree", {}),
        tags=("frames", "embedded"),
    ),
    "scroll_page": ToolBenchmarkCase(
        tool_name="scroll_page",
        profile="landing",
        description="Scroll a listing page to expose more matches.",
        scenario="Landing pagination and lazy-loaded match discovery.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "scroll_page",
            {"frame_path": "root", "direction": "down", "amount": 800, "behavior": "auto"},
        ),
        tags=("navigation", "landing"),
    ),
    "go_back": ToolBenchmarkCase(
        tool_name="go_back",
        profile="classification",
        description="Return to the previous page after opening a likely hosting candidate.",
        scenario="Recover from a representative-hosting-page check.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "networkidle2"}),
            ToolInvocation("open_url", {"url": "{base_url}/watch", "wait_until": "networkidle2"}),
        ),
        benchmark_step=ToolInvocation("go_back", {"timeout_ms": 30000}),
        tags=("navigation", "recovery"),
    ),
    "scroll_to_element": ToolBenchmarkCase(
        tool_name="scroll_to_element",
        profile="landing",
        description="Bring a match card or server button into view before clicking.",
        scenario="Precise landing navigation before opening a candidate watch page.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "scroll_to_element",
            {"frame_path": "root", "selector": ".match-card a.watch-link"},
        ),
        tags=("navigation", "precision"),
    ),
    "wait_for_page_state": ToolBenchmarkCase(
        tool_name="wait_for_page_state",
        profile="hosting",
        description="Wait for the hosting page to settle after a server switch or activation.",
        scenario="Server switching and player activation stabilization.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "wait_for_page_state",
            {"frame_path": "root", "mode": "network_idle", "timeout_ms": 10000},
        ),
        tags=("navigation", "stability"),
    ),
    "click_element": ToolBenchmarkCase(
        tool_name="click_element",
        profile="hosting",
        description="Click a server toggle returned from a previous query.",
        scenario="Hosting page server switching with element references.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "click_element",
            {"frame_path": "root", "element_ref": "server-button-1", "wait_ms": 1500},
        ),
        tags=("actions", "server-switching"),
    ),
    "click_css": ToolBenchmarkCase(
        tool_name="click_css",
        profile="hosting",
        description="Click a server or source button via CSS selector.",
        scenario="Hosting page server switching via deterministic CSS selectors.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "click_css",
            {"frame_path": "root", "selector": ".server-button[data-server='2']", "wait_ms": 1500},
        ),
        tags=("actions", "server-switching"),
    ),
    "click_text": ToolBenchmarkCase(
        tool_name="click_text",
        profile="hosting",
        description="Click a visible server label or play control by text.",
        scenario="Hosting page activation when text labels are more stable than selectors.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "click_text",
            {"frame_path": "root", "text": "Server 2", "wait_ms": 1500},
        ),
        tags=("actions", "activation"),
    ),
    "click_xpath": ToolBenchmarkCase(
        tool_name="click_xpath",
        profile="hosting",
        description="Click a server option or play control through XPath.",
        scenario="Hosting workflows where CSS/text locators are unstable.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "click_xpath",
            {"frame_path": "root", "xpath": "//button[contains(., 'Play')]", "wait_ms": 1500},
        ),
        tags=("actions", "fallback"),
    ),
    "click_checkbox": ToolBenchmarkCase(
        tool_name="click_checkbox",
        profile="landing",
        description="Dismiss a blocking overlay or enable a filter checkbox.",
        scenario="Landing page filtering and anti-overlay dismissal.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "click_checkbox",
            {
                "frame_path": "root",
                "selector": "input[type='checkbox'][name='live-only']",
                "checked": True,
                "wait_ms": 1000,
            },
        ),
        tags=("actions", "filters"),
    ),
    "click_radio": ToolBenchmarkCase(
        tool_name="click_radio",
        profile="landing",
        description="Switch tabs or source groups through radio-style controls.",
        scenario="Landing category navigation before match extraction.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "click_radio",
            {"frame_path": "root", "selector": "input[type='radio'][value='football']", "wait_ms": 1000},
        ),
        tags=("actions", "filters"),
    ),
    "type_into": ToolBenchmarkCase(
        tool_name="type_into",
        profile="landing",
        description="Fill a landing-page search box to locate a specific match.",
        scenario="Landing navigation through on-page search.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "type_into",
            {"frame_path": "root", "selector": "input[name='match-search']", "value": "Team A", "wait_ms": 500},
        ),
        tags=("actions", "search"),
    ),
    "select_option": ToolBenchmarkCase(
        tool_name="select_option",
        profile="landing",
        description="Choose a competition or channel from a dropdown.",
        scenario="Landing filter selection before match extraction.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/landing", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "select_option",
            {"frame_path": "root", "selector": "select[name='competition']", "option_text": "Premier League", "wait_ms": 1000},
        ),
        tags=("actions", "filters"),
    ),
    "play_media": ToolBenchmarkCase(
        tool_name="play_media",
        profile="hosting",
        description="Trigger playback inside a hosting or embedded player.",
        scenario="Player activation before network extraction.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "play_media",
            {"frame_path": "root.0", "selector": "video", "wait_ms": 1500},
        ),
        tags=("actions", "playback"),
    ),
    "swipe_region": ToolBenchmarkCase(
        tool_name="swipe_region",
        profile="embedded",
        description="Drag inside a player or carousel when standard clicks are not enough.",
        scenario="Embedded player interaction with gesture-only controls.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/embedded", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "swipe_region",
            {"frame_path": "root", "x": 960, "y": 540, "delta_x": -400, "delta_y": 0, "steps": 12, "wait_ms": 500},
        ),
        tags=("actions", "gesture"),
    ),
    "click_coordinates": ToolBenchmarkCase(
        tool_name="click_coordinates",
        profile="embedded",
        description="Click the center of a cross-origin player overlay.",
        scenario="Embedded player activation when DOM locators are unavailable.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/embedded", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation(
            "click_coordinates",
            {"frame_path": "root", "x": 960, "y": 540, "wait_ms": 1500},
        ),
        tags=("actions", "iframe"),
    ),
    "get_media_state": ToolBenchmarkCase(
        tool_name="get_media_state",
        profile="hosting",
        description="Inspect whether the player is present, paused, or already playing.",
        scenario="Hosting player activation verification before capture.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "domcontentloaded"}),
        ),
        benchmark_step=ToolInvocation("get_media_state", {"frame_path": "root.0"}),
        tags=("media", "verification"),
    ),
    "capture_streams": ToolBenchmarkCase(
        tool_name="capture_streams",
        profile="hosting",
        description="Capture network and DOM stream URLs after playback or server activation.",
        scenario="Hosting page server switching, network extraction, and player activation.",
        setup_steps=(
            ToolInvocation("open_url", {"url": "{base_url}/hosting", "wait_until": "networkidle2"}),
            ToolInvocation("play_media", {"frame_path": "root.0", "selector": "video", "wait_ms": 1500}),
        ),
        benchmark_step=ToolInvocation(
            "capture_streams",
            {"frame_path": "root.0", "duration_ms": 12000, "player_iframe_hint": "player"},
        ),
        tags=("media", "network", "extraction"),
    ),
}


def get_all_benchmark_cases() -> list[ToolBenchmarkCase]:
    return list(TOOL_BENCHMARKS.values())


def expected_benchmark_tool_names() -> set[str]:
    return set().union(*REQUIRED_TOOLS_BY_PROFILE.values())
