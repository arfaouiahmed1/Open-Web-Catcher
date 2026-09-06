"""Contract tests for the dependency-injected core API routes."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

from src.api.contracts import ClassifyRequest, DatasetExportRequest
from src.api.routes.core import CoreRouteDependencies, create_core_router
import src.api.routes.core as core_routes

pytestmark = pytest.mark.unit


def _core_app() -> FastAPI:
    app = FastAPI()
    app.include_router(
        create_core_router(
            CoreRouteDependencies(
                get_settings=lambda: SimpleNamespace(
                    orchestrator_model="orchestrator-test",
                    agent_model="agent-test",
                    browser_ws_endpoint="ws://browser",
                    mcp_server_url="http://mcp",
                ),
                runtime_dependency_snapshot=lambda _settings: {
                    "browser": {"ok": True},
                    "mcp": {"ok": True},
                    "preflight": {"launch_ready": True},
                },
                background_job_health=lambda: {"ok": True},
                observability_status=lambda _settings: SimpleNamespace(
                    model_dump=lambda: {"enabled": True}
                ),
            )
        )
    )
    return app


def test_core_router_health_uses_injected_services() -> None:
    response = TestClient(_core_app()).get("/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["orchestrator_model"] == "orchestrator-test"
    assert payload["dependencies"]["background_jobs"]["ok"] is True


def test_core_router_serves_webp_blob(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        core_routes,
        "read_blob",
        lambda _ref: b"RIFF\x04\x00\x00\x00WEBP",
    )

    response = TestClient(_core_app()).get("/blobs/0123456789abcdef")

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/webp"


def test_extracted_contracts_reject_invalid_limits_and_urls() -> None:
    with pytest.raises(ValidationError):
        ClassifyRequest(url="")
    with pytest.raises(ValidationError):
        DatasetExportRequest(limit=0)
