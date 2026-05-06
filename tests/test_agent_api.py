"""Tests for the API routes that call each agent.

Covers:
  POST /classify               → ClassificationAgent
  POST /extract (landing)      → LandingPageAgent
  POST /extract (hosting)      → HostingPageAgent
  POST /extract (embedded)     → EmbeddedPageAgent
  POST /run                    → full orchestrator pipeline
  POST /ui/agents/test         → background single-agent run (any profile)
  POST /ui/workflows/run       → background full pipeline run

All agents and external I/O are mocked so the tests run without a real
browser, MCP server, or Google API key.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import (
    ClassificationResult,
    ExtractionResult,
    PipelineResult,
    StreamURL,
)
from src.utils.config import Settings


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def api_settings() -> Settings:
    return Settings(
        google_api_key="test-key",
        browser_ws_endpoint="ws://browser.local:9222/devtools/browser/shared",
        mcp_server_url="http://mcp.local:3000",
        database_url="sqlite:///:memory:",
        memory_enabled=False,
        model_pricing_json="{}",
    )


@pytest.fixture
def client(api_settings: Settings):
    from src.api import app as api_app

    with (
        patch.object(api_app, "_settings", api_settings),
        patch.object(api_app, "setup_tracing_from_settings"),
        patch.object(api_app, "create_tables"),
        patch.object(api_app, "_auto_sync_provider_pricing"),
        patch.object(api_app, "probe_browser", return_value={"healthy": True}),
        patch.object(api_app, "probe_mcp", return_value={"healthy": True}),
    ):
        with TestClient(api_app.app) as test_client:
            yield test_client


# ---------------------------------------------------------------------------
# Helper stubs
# ---------------------------------------------------------------------------

def _classification_result(url: str = "https://streaming.example.com") -> ClassificationResult:
    return ClassificationResult(
        url=url,
        page_type=PageType.HOSTING,
        confidence=Confidence.HIGH,
        reasoning="Video player detected with HLS source.",
    )


def _extraction_result(
    url: str = "https://hosting.example.com/video/1",
    page_type: PageType = PageType.HOSTING,
    agent_type: AgentType = AgentType.HOSTING_PAGE,
    status: ExtractionStatus = ExtractionStatus.SUCCESS,
    streams: list[StreamURL] | None = None,
) -> ExtractionResult:
    return ExtractionResult(
        url=url,
        page_type=page_type,
        status=status,
        agent_type=agent_type,
        streams=streams or [StreamURL(url="https://cdn.example.com/stream.m3u8", protocol="hls")],
    )


def _pipeline_result(url: str = "https://streaming.example.com") -> PipelineResult:
    return PipelineResult(
        run_id="run-test-1",
        url=url,
        classification=_classification_result(url),
        final_status=ExtractionStatus.SUCCESS,
        all_streams=[StreamURL(url="https://cdn.example.com/stream.m3u8", protocol="hls")],
    )


# ---------------------------------------------------------------------------
# POST /classify → ClassificationAgent
# ---------------------------------------------------------------------------

class TestClassifyEndpoint:
    def test_returns_classification_result(self, client: TestClient):
        result = _classification_result()
        with patch("src.agents.classification.ClassificationAgent.run", new=AsyncMock(return_value=result)):
            response = client.post("/classify", json={"url": "https://streaming.example.com"})

        assert response.status_code == 200
        data = response.json()
        assert data["url"] == "https://streaming.example.com"
        assert data["page_type"] == "hosting_page"
        assert data["confidence"] == "high"
        assert data["reasoning"] == "Video player detected with HLS source."

    def test_classification_agent_receives_correct_url(self, client: TestClient):
        result = _classification_result(url="https://live.sports-stream.net")
        mock_run = AsyncMock(return_value=result)
        with patch("src.agents.classification.ClassificationAgent.run", new=mock_run):
            client.post("/classify", json={"url": "https://live.sports-stream.net"})

        mock_run.assert_awaited_once()
        assert mock_run.call_args.kwargs["url"] == "https://live.sports-stream.net"

    def test_unknown_page_type_is_returned(self, client: TestClient):
        result = ClassificationResult(
            url="https://streaming.example.com",
            page_type=PageType.UNKNOWN,
            confidence=Confidence.LOW,
            reasoning="Could not determine type.",
        )
        with patch("src.agents.classification.ClassificationAgent.run", new=AsyncMock(return_value=result)):
            response = client.post("/classify", json={"url": "https://streaming.example.com"})

        assert response.status_code == 200
        assert response.json()["page_type"] == "unknown"

    def test_landing_page_classification(self, client: TestClient):
        result = ClassificationResult(
            url="https://streaming.example.com",
            page_type=PageType.LANDING,
            confidence=Confidence.MEDIUM,
            reasoning="Grid of match links detected.",
        )
        with patch("src.agents.classification.ClassificationAgent.run", new=AsyncMock(return_value=result)):
            response = client.post("/classify", json={"url": "https://streaming.example.com"})

        assert response.status_code == 200
        assert response.json()["page_type"] == "landing_page"
        assert response.json()["confidence"] == "medium"


# ---------------------------------------------------------------------------
# POST /extract → LandingPageAgent / HostingPageAgent / EmbeddedPageAgent
# ---------------------------------------------------------------------------

class TestExtractEndpoint:

    # ── landing ──────────────────────────────────────────────────────────────

    def test_landing_page_routes_to_landing_agent(self, client: TestClient):
        result = _extraction_result(page_type=PageType.LANDING, agent_type=AgentType.LANDING_PAGE)
        with patch("src.agents.landing_page.LandingPageAgent.run", new=AsyncMock(return_value=result)):
            response = client.post(
                "/extract",
                json={"url": "https://streaming.example.com", "page_type": "landing_page"},
            )

        assert response.status_code == 200
        assert response.json()["page_type"] == "landing_page"

    def test_landing_agent_receives_correct_url(self, client: TestClient):
        result = _extraction_result(
            url="https://sport-links.net",
            page_type=PageType.LANDING,
            agent_type=AgentType.LANDING_PAGE,
        )
        mock_run = AsyncMock(return_value=result)
        with patch("src.agents.landing_page.LandingPageAgent.run", new=mock_run):
            client.post(
                "/extract",
                json={"url": "https://sport-links.net", "page_type": "landing_page"},
            )

        mock_run.assert_awaited_once()
        assert mock_run.call_args.args[0] == "https://sport-links.net"

    # ── hosting ──────────────────────────────────────────────────────────────

    def test_hosting_page_routes_to_hosting_agent(self, client: TestClient):
        result = _extraction_result()
        with patch("src.agents.hosting_page.HostingPageAgent.run", new=AsyncMock(return_value=result)):
            response = client.post(
                "/extract",
                json={"url": "https://hosting.example.com/video/1", "page_type": "hosting_page"},
            )

        assert response.status_code == 200
        assert response.json()["page_type"] == "hosting_page"
        assert response.json()["status"] == "success"

    def test_hosting_agent_returns_streams(self, client: TestClient):
        result = _extraction_result(
            streams=[
                StreamURL(url="https://cdn.example.com/stream.m3u8", protocol="hls"),
                StreamURL(url="https://cdn.example.com/stream.mpd", protocol="dash"),
            ]
        )
        with patch("src.agents.hosting_page.HostingPageAgent.run", new=AsyncMock(return_value=result)):
            response = client.post(
                "/extract",
                json={"url": "https://hosting.example.com/video/1", "page_type": "hosting_page"},
            )

        data = response.json()
        assert len(data["streams"]) == 2
        assert data["streams"][0]["protocol"] == "hls"
        assert data["streams"][1]["protocol"] == "dash"

    def test_hosting_agent_partial_status(self, client: TestClient):
        result = _extraction_result(status=ExtractionStatus.PARTIAL, streams=[])
        with patch("src.agents.hosting_page.HostingPageAgent.run", new=AsyncMock(return_value=result)):
            response = client.post(
                "/extract",
                json={"url": "https://hosting.example.com/video/1", "page_type": "hosting_page"},
            )

        assert response.status_code == 200
        assert response.json()["status"] == "partial"

    # ── embedded ─────────────────────────────────────────────────────────────

    def test_embedded_page_routes_to_embedded_agent(self, client: TestClient):
        result = _extraction_result(page_type=PageType.EMBEDDED, agent_type=AgentType.EMBEDDED_PAGE)
        with patch("src.agents.embedded_page.EmbeddedPageAgent.run", new=AsyncMock(return_value=result)):
            response = client.post(
                "/extract",
                json={"url": "https://embed.example.com/player", "page_type": "embedded_page"},
            )

        assert response.status_code == 200
        assert response.json()["page_type"] == "embedded_page"

    def test_embedded_agent_receives_correct_url(self, client: TestClient):
        result = _extraction_result(
            url="https://player.stream.io/embed/abc123",
            page_type=PageType.EMBEDDED,
            agent_type=AgentType.EMBEDDED_PAGE,
        )
        mock_run = AsyncMock(return_value=result)
        with patch("src.agents.embedded_page.EmbeddedPageAgent.run", new=mock_run):
            client.post(
                "/extract",
                json={"url": "https://player.stream.io/embed/abc123", "page_type": "embedded_page"},
            )

        mock_run.assert_awaited_once()
        assert mock_run.call_args.args[0] == "https://player.stream.io/embed/abc123"

    # ── invalid page_type ────────────────────────────────────────────────────

    def test_invalid_page_type_rejected_by_schema(self, client: TestClient):
        response = client.post(
            "/extract",
            json={"url": "https://example.com", "page_type": "unknown_type"},
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# POST /run → full orchestrator pipeline
# ---------------------------------------------------------------------------

class TestRunEndpoint:
    def test_run_calls_orchestrator_and_returns_pipeline_result(self, client: TestClient):
        result = _pipeline_result()
        with (
            patch("src.agents.orchestrator.run_pipeline", new=AsyncMock(return_value=result)),
            patch("src.api.app.RunRepository") as mock_repo_cls,
            patch("src.api.app.get_session") as mock_get_session,
        ):
            session = MagicMock()
            mock_get_session.return_value = session
            response = client.post("/run", json={"url": "https://streaming.example.com"})

        assert response.status_code == 200
        data = response.json()
        assert data["run_id"] == "run-test-1"
        assert data["url"] == "https://streaming.example.com"
        assert data["final_status"] == "success"

    def test_run_persists_result(self, client: TestClient):
        result = _pipeline_result()
        with (
            patch("src.agents.orchestrator.run_pipeline", new=AsyncMock(return_value=result)),
            patch("src.api.app.RunRepository") as mock_repo_cls,
            patch("src.api.app.get_session") as mock_get_session,
        ):
            session = MagicMock()
            mock_get_session.return_value = session
            client.post("/run", json={"url": "https://streaming.example.com"})

        mock_repo_cls.return_value.save.assert_called_once()

    def test_run_includes_streams_in_response(self, client: TestClient):
        result = _pipeline_result()
        with (
            patch("src.agents.orchestrator.run_pipeline", new=AsyncMock(return_value=result)),
            patch("src.api.app.RunRepository"),
            patch("src.api.app.get_session", return_value=MagicMock()),
        ):
            response = client.post("/run", json={"url": "https://streaming.example.com"})

        data = response.json()
        assert len(data["all_streams"]) == 1
        assert data["all_streams"][0]["url"] == "https://cdn.example.com/stream.m3u8"

    def test_run_with_failed_pipeline_still_returns_200(self, client: TestClient):
        result = PipelineResult(
            run_id="run-failed",
            url="https://streaming.example.com",
            final_status=ExtractionStatus.FAILED,
        )
        with (
            patch("src.agents.orchestrator.run_pipeline", new=AsyncMock(return_value=result)),
            patch("src.api.app.RunRepository"),
            patch("src.api.app.get_session", return_value=MagicMock()),
        ):
            response = client.post("/run", json={"url": "https://streaming.example.com"})

        assert response.status_code == 200
        assert response.json()["final_status"] == "failed"


# ---------------------------------------------------------------------------
# POST /ui/agents/test → background single-agent test (any profile)
# ---------------------------------------------------------------------------

class TestUiAgentTestEndpoint:
    def test_returns_run_id_and_root_actor(self, client: TestClient):
        response = client.post(
            "/ui/agents/test",
            json={"agent": "classification", "url": "https://streaming.example.com"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["root_actor"] == "classification"
        assert data["run_id"]
        assert data["job_status"] in {"queued", "running", "retrying"}

    def test_background_job_is_enqueued(self, client: TestClient):
        response = client.post(
            "/ui/agents/test",
            json={"agent": "hosting", "url": "https://hosting.example.com/video/1"},
        )
        assert response.status_code == 200
        assert response.json()["job_status"] in {"queued", "running", "retrying"}

    @pytest.mark.parametrize("agent_name", ["classification", "landing", "hosting", "embedded"])
    def test_all_agent_profiles_are_accepted(self, client: TestClient, agent_name: str):
        response = client.post(
            "/ui/agents/test",
            json={"agent": agent_name, "url": "https://example.com"},
        )

        assert response.status_code == 200
        assert response.json()["root_actor"] == agent_name

    def test_unknown_agent_still_enqueues_job(self, client: TestClient):
        """The endpoint persists the job; agent resolution happens when worker executes it."""
        response = client.post(
            "/ui/agents/test",
            json={"agent": "nonexistent_agent", "url": "https://example.com"},
        )

        assert response.status_code == 200

    def test_blocks_launch_when_runtime_preflight_fails(self, api_settings: Settings):
        from src.api import app as api_app

        with (
            patch.object(api_app, "_settings", api_settings),
            patch.object(api_app, "setup_tracing_from_settings"),
            patch.object(api_app, "create_tables"),
            patch.object(api_app, "_auto_sync_provider_pricing"),
            patch.object(
                api_app,
                "probe_browser",
                return_value={
                    "healthy": False,
                    "configured_ws_endpoint": api_settings.browser_ws_endpoint,
                    "probe_url": "http://browser.local:9222/json/version",
                    "error": "connection refused",
                },
            ),
            patch.object(
                api_app,
                "probe_mcp",
                return_value={
                    "healthy": True,
                    "probe_url": "http://mcp.local:3000/health",
                    "profiles": ["classification", "landing", "hosting", "embedded"],
                },
            ),
        ):
            with TestClient(api_app.app) as test_client:
                response = test_client.post(
                    "/ui/agents/test",
                    json={"agent": "classification", "url": "https://streaming.example.com"},
                )

        assert response.status_code == 503
        payload = response.json()
        assert payload["detail"]["message"] == "Runtime dependencies are not ready for a new run."
        assert payload["detail"]["runtime"]["preflight"]["launch_ready"] is False


# ---------------------------------------------------------------------------
# POST /ui/workflows/run → background full pipeline run
# ---------------------------------------------------------------------------

class TestUiWorkflowRunEndpoint:
    def test_returns_run_id_and_orchestrator_actor(self, client: TestClient):
        response = client.post(
            "/ui/workflows/run",
            json={"url": "https://streaming.example.com"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["root_actor"] == "orchestrator"
        assert data["run_id"]
        assert data["job_status"] in {"queued", "running", "retrying"}

    def test_each_call_produces_unique_run_id(self, client: TestClient):
        run_ids: list[str] = []
        for _ in range(3):
            r = client.post("/ui/workflows/run", json={"url": "https://streaming.example.com"})
            run_ids.append(r.json()["run_id"])

        assert len(set(run_ids)) == 3

    def test_background_job_is_enqueued(self, client: TestClient):
        response = client.post("/ui/workflows/run", json={"url": "https://streaming.example.com"})
        assert response.status_code == 200
        assert response.json()["job_status"] in {"queued", "running", "retrying"}

    def test_blocks_launch_when_runtime_preflight_fails(self, api_settings: Settings):
        from src.api import app as api_app

        with (
            patch.object(api_app, "_settings", api_settings),
            patch.object(api_app, "setup_tracing_from_settings"),
            patch.object(api_app, "create_tables"),
            patch.object(api_app, "_auto_sync_provider_pricing"),
            patch.object(
                api_app,
                "probe_browser",
                return_value={
                    "healthy": False,
                    "configured_ws_endpoint": api_settings.browser_ws_endpoint,
                    "probe_url": "http://browser.local:9222/json/version",
                    "error": "connection refused",
                },
            ),
            patch.object(
                api_app,
                "probe_mcp",
                return_value={
                    "healthy": True,
                    "probe_url": "http://mcp.local:3000/health",
                    "profiles": ["classification", "landing", "hosting", "embedded"],
                },
            ),
        ):
            with TestClient(api_app.app) as test_client:
                response = test_client.post(
                    "/ui/workflows/run",
                    json={"url": "https://streaming.example.com"},
                )

        assert response.status_code == 503
        payload = response.json()
        assert payload["detail"]["runtime"]["browser"]["healthy"] is False
        assert payload["detail"]["runtime"]["preflight"]["blocking_reasons"][0]["kind"] == "browser_unhealthy"


class TestPricingSyncEndpoint:
    def test_sync_pricing_endpoint_unsupported_provider(self, client: TestClient):
        response = client.post("/ui/pricing/sync", json={"provider": "mistral"})
        assert response.status_code == 400
        assert "supports" in response.json()["detail"].lower()

    def test_sync_pricing_endpoint_persists_rows(self, client: TestClient):
        from src.models.schemas import PricingConfig

        rows = [
            PricingConfig(
                provider="openrouter",
                model_name="openai/gpt-4o-mini",
                input_per_million=0.15,
                output_per_million=0.6,
                active=True,
                notes="synced",
            )
        ]

        with (
            patch("src.api.app.fetch_provider_pricing", return_value=rows),
            patch("src.api.app._refresh_pricing_from_db"),
            patch("src.api.app.OperatorConsoleRepository") as mock_repo_cls,
            patch("src.api.app.get_session") as mock_get_session,
        ):
            session = MagicMock()
            mock_get_session.return_value = session
            mock_repo_cls.return_value.upsert_pricing_configs.return_value = 1

            response = client.post("/ui/pricing/sync", json={"provider": "openrouter"})

            assert response.status_code == 200
            payload = response.json()
            assert payload["provider"] == "openrouter"

            mock_repo_cls.return_value.upsert_pricing_configs.assert_called_once()


# ---------------------------------------------------------------------------
# Background agent runner: _background_agent internal logic
# ---------------------------------------------------------------------------

class TestBackgroundAgentRunner:
    """Tests that _background_agent correctly drives each agent and records
    the result on the RunObserver."""

    @pytest.mark.asyncio
    async def test_classification_agent_background_run(self, api_settings: Settings):
        from src.api.app import _background_agent
        from src.utils.observability import run_registry

        result = _classification_result()
        with (
            patch.object(api_settings.__class__, "from_yaml", return_value=api_settings),
            patch("src.api.app._settings", api_settings),
            patch("src.api.app.get_observability_status") as mock_obs,
            patch("src.agents.classification.ClassificationAgent.run", new=AsyncMock(return_value=result)),
        ):
            from src.utils.observability import ObservabilityStatus
            mock_obs.return_value = ObservabilityStatus(
                enabled=False, project="test", pricing_models=[], default_dataset_name="test-ds"
            )
            await _background_agent("run-bg-cls", "classification", "https://streaming.example.com")

        trace = run_registry.get("run-bg-cls")
        assert trace is not None
        assert trace.completed is True
        assert trace.metrics.success is True

    @pytest.mark.asyncio
    async def test_hosting_agent_background_run_success(self, api_settings: Settings):
        from src.api.app import _background_agent
        from src.utils.observability import run_registry

        result = _extraction_result()
        with (
            patch("src.api.app._settings", api_settings),
            patch("src.api.app.get_observability_status") as mock_obs,
            patch("src.agents.hosting_page.HostingPageAgent.run", new=AsyncMock(return_value=result)),
        ):
            from src.utils.observability import ObservabilityStatus
            mock_obs.return_value = ObservabilityStatus(
                enabled=False, project="test", pricing_models=[], default_dataset_name="test-ds"
            )
            await _background_agent("run-bg-hosting", "hosting", "https://hosting.example.com/video/1")

        trace = run_registry.get("run-bg-hosting")
        assert trace is not None
        assert trace.completed is True
        assert trace.metrics.success is True

    @pytest.mark.asyncio
    async def test_failed_agent_marks_run_as_failed(self, api_settings: Settings):
        from src.api.app import _background_agent
        from src.utils.observability import run_registry

        with (
            patch("src.api.app._settings", api_settings),
            patch("src.api.app.get_observability_status") as mock_obs,
            patch("src.agents.classification.ClassificationAgent.run", new=AsyncMock(side_effect=RuntimeError("LLM timeout"))),
        ):
            from src.utils.observability import ObservabilityStatus
            mock_obs.return_value = ObservabilityStatus(
                enabled=False, project="test", pricing_models=[], default_dataset_name="test-ds"
            )
            await _background_agent("run-bg-fail", "classification", "https://streaming.example.com")

        trace = run_registry.get("run-bg-fail")
        assert trace is not None
        assert trace.completed is True
        assert trace.metrics.success is False
        assert trace.metrics.failure_mode == "RuntimeError"
