"""API route tests with agent runtime mocked out."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import ClassificationResult, ExtractionResult, PipelineResult
from src.utils.config import Settings


@pytest.fixture
def api_settings() -> Settings:
    return Settings(
        google_api_key="test-key",
        browser_ws_endpoint="ws://browser.local:9222/devtools/browser/shared",
        mcp_server_url="http://mcp.local:3000",
        database_url="sqlite:///:memory:",
    )


@pytest.fixture
def client(api_settings: Settings):
    from src.api import app as api_app

    with patch.object(api_app, "_settings", api_settings), \
         patch.object(api_app, "setup_tracing_from_settings"), \
         patch.object(api_app, "create_tables"), \
         patch.object(api_app, "probe_browser", return_value={"healthy": True}), \
         patch.object(api_app, "probe_mcp", return_value={"healthy": True}), \
         patch.object(api_app, "get_session"), \
         patch.object(api_app, "RunRepository"):
        with TestClient(api_app.app) as test_client:
            yield test_client


def test_health_reports_dependency_config(client: TestClient):
    response = client.get("/health")
    payload = response.json()

    assert response.status_code == 200
    assert payload["browser_ws_endpoint"] == "ws://browser.local:9222/devtools/browser/shared"
    assert payload["mcp_server_url"] == "http://mcp.local:3000"
    assert payload["dependencies"]["browser"]["healthy"] is True
    assert payload["dependencies"]["mcp"]["healthy"] is True


def test_extract_routes_to_hosting_agent(api_settings: Settings):
    from src.api import app as api_app

    extraction = ExtractionResult(
        url="https://hosting.example.com/video/1",
        page_type=PageType.HOSTING,
        status=ExtractionStatus.SUCCESS,
        agent_type=AgentType.HOSTING_PAGE,
    )

    with patch.object(api_app, "_settings", api_settings), \
         patch.object(api_app, "setup_tracing_from_settings"), \
         patch.object(api_app, "create_tables"), \
         patch("src.agents.hosting_page.HostingPageAgent.run", new=AsyncMock(return_value=extraction)):
        with TestClient(api_app.app) as test_client:
            response = test_client.post(
                "/extract",
                json={"url": "https://hosting.example.com/video/1", "page_type": "hosting_page"},
            )

    assert response.status_code == 200
    assert response.json()["page_type"] == "hosting_page"


def test_run_route_calls_orchestrator_and_persists_result(client: TestClient):
    result = PipelineResult(
        run_id="run-1",
        url="https://example.com",
        classification=ClassificationResult(
            url="https://example.com",
            page_type=PageType.HOSTING,
            confidence=Confidence.HIGH,
            reasoning="Test",
        ),
        final_status=ExtractionStatus.FAILED,
    )

    with patch("src.agents.orchestrator.run_pipeline", new=AsyncMock(return_value=result)), \
         patch("src.api.app.RunRepository") as mock_repo_cls, \
         patch("src.api.app.get_session") as mock_get_session:
        session = MagicMock()
        mock_get_session.return_value = session
        response = client.post("/run", json={"url": "https://example.com"})

    assert response.status_code == 200
    mock_repo_cls.return_value.save.assert_called_once()
    session.close.assert_called_once()
