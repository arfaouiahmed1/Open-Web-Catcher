from __future__ import annotations

import sys
from types import ModuleType

import pytest

from src.agents.orchestrator import PipelineState, _build_landing_handoff, landing_page_node
from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import ClassificationResult, ExtractionResult
from src.tools.static_prepass import collect_static_candidate_links
from src.utils.config import Settings


def _landing_state() -> PipelineState:
    return {
        "url": "https://sports.example/schedule/index.html",
        "run_id": "static-prepass-test",
        "classification": ClassificationResult(
            url="https://sports.example/schedule/index.html",
            page_type=PageType.LANDING,
            confidence=Confidence.HIGH,
        ),
        "matches": [],
        "extraction_results": [],
        "pending_hosting_urls": [],
        "pending_embedded_urls": [],
        "provider_analysis": [],
        "takedown_emails": [],
        "error": "",
        "gate_no_target": False,
    }


def test_static_prepass_is_disabled_by_default() -> None:
    assert Settings().static_prepass_enabled is False


def test_static_prepass_normalizes_and_deduplicates_http_links(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeSelection:
        def getall(self) -> list[str]:
            return [
                "/watch/1#player",
                "https://sports.example/watch/1",
                "../watch/2",
                "//cdn.example/player/3",
                "javascript:void(0)",
                "mailto:abuse@example.test",
                "#schedule",
                "",
            ]

    class FakePage:
        status = 200

        def css(self, selector: str) -> FakeSelection:
            assert selector == "a::attr(href)"
            return FakeSelection()

    class FakeFetcher:
        @staticmethod
        def get(url: str) -> FakePage:
            assert url == "https://sports.example/schedule/index.html"
            return FakePage()

    fetchers = ModuleType("scrapling.fetchers")
    setattr(fetchers, "Fetcher", FakeFetcher)
    monkeypatch.setitem(sys.modules, "scrapling.fetchers", fetchers)

    assert collect_static_candidate_links(
        "https://sports.example/schedule/index.html"
    ) == [
        "https://sports.example/watch/1",
        "https://sports.example/watch/2",
        "https://cdn.example/player/3",
    ]


def test_static_prepass_skips_when_scrapling_is_absent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def missing_scrapling(name: str) -> ModuleType:
        raise ModuleNotFoundError(name=name)

    monkeypatch.setattr("src.tools.static_prepass.import_module", missing_scrapling)

    assert collect_static_candidate_links("https://sports.example") == []


@pytest.mark.asyncio
async def test_disabled_static_prepass_preserves_landing_handoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _landing_state()
    captured_handoffs: list[str] = []

    def unexpected_collect(url: str) -> list[str]:
        raise AssertionError(f"static pre-pass unexpectedly called for {url}")

    async def fake_run(self, *, url, observer=None, orchestrator_handoff=""):
        captured_handoffs.append(orchestrator_handoff)
        return ExtractionResult(
            url=url,
            page_type=PageType.LANDING,
            status=ExtractionStatus.FAILED,
            agent_type=AgentType.LANDING_PAGE,
        )

    monkeypatch.setattr(
        "src.tools.static_prepass.collect_static_candidate_links", unexpected_collect
    )
    monkeypatch.setattr("src.agents.landing_page.LandingPageAgent.run", fake_run)

    await landing_page_node(
        state,
        settings=Settings(static_prepass_enabled=False),
        observer=None,
        memory=None,
    )

    assert captured_handoffs == [
        _build_landing_handoff(state, memory_hint_text="")
    ]


@pytest.mark.asyncio
async def test_enabled_static_prepass_feeds_candidates_to_landing_handoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _landing_state()
    captured_handoffs: list[str] = []

    def fake_collect(url: str) -> list[str]:
        assert url == state["url"]
        return [
            "https://sports.example/watch/1",
            "https://sports.example/watch/2",
        ]

    async def fake_run(self, *, url, observer=None, orchestrator_handoff=""):
        captured_handoffs.append(orchestrator_handoff)
        return ExtractionResult(
            url=url,
            page_type=PageType.LANDING,
            status=ExtractionStatus.FAILED,
            agent_type=AgentType.LANDING_PAGE,
        )

    monkeypatch.setattr(
        "src.tools.static_prepass.collect_static_candidate_links", fake_collect
    )
    monkeypatch.setattr("src.agents.landing_page.LandingPageAgent.run", fake_run)

    await landing_page_node(
        state,
        settings=Settings(static_prepass_enabled=True),
        observer=None,
        memory=None,
    )

    assert "https://sports.example/watch/1" in captured_handoffs[0]
    assert "https://sports.example/watch/2" in captured_handoffs[0]
