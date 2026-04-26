"""API route tests with agent runtime mocked out."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from src.models.enums import AgentType, Confidence, ExtractionStatus, PageType
from src.models.schemas import (
    ClassificationResult,
    EvaluationCaseResult,
    EvaluationRun,
    ExtractionResult,
    PipelineResult,
    PricingConfig,
)
from src.utils.config import Settings, build_browser_runtime_sync_status
from src.utils.observability import ObservabilityStatus, run_registry


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

    with patch.object(api_app, "_settings", api_settings), \
         patch.object(api_app, "setup_tracing_from_settings"), \
         patch.object(api_app, "create_tables"), \
         patch.object(api_app, "_auto_sync_provider_pricing"), \
         patch.object(api_app, "probe_browser", return_value={"healthy": True}), \
         patch.object(api_app, "probe_mcp", return_value={"healthy": True}):
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
         patch.object(api_app, "_auto_sync_provider_pricing"), \
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


def test_ui_overview_returns_operator_console_payload(client: TestClient):
    payload = {
        "summary": {"total_runs": 3, "success_rate": 0.67, "total_tokens": 1234, "total_cost_usd": 0.12},
        "trend": [],
        "model_breakdown": [],
        "provider_breakdown": [],
        "top_tools": [],
        "recent_runs": [],
        "evaluation_summary": {},
        "active_runs": [],
    }
    with patch("src.api.app.OperatorConsoleRepository") as mock_repo_cls, \
         patch("src.api.app.get_session") as mock_get_session:
        session = MagicMock()
        mock_get_session.return_value = session
        mock_repo_cls.return_value.get_overview.return_value = payload
        response = client.get("/ui/overview")

    assert response.status_code == 200
    assert response.json()["summary"]["total_runs"] == 3


def test_ui_pricing_update_persists_and_updates_runtime_settings(client: TestClient, api_settings: Settings):
    config = PricingConfig(
        provider="google",
        model_name="gemini-2.5-flash",
        input_per_million=1.25,
        output_per_million=2.5,
        notes="test",
    )

    with patch("src.api.app.OperatorConsoleRepository") as mock_repo_cls, \
         patch("src.api.app.get_session") as mock_get_session:
        session = MagicMock()
        mock_get_session.return_value = session
        mock_repo_cls.return_value.upsert_pricing_config.return_value = config
        response = client.put("/ui/pricing", json=config.model_dump(mode="json"))

    assert response.status_code == 200
    stored = json.loads(api_settings.model_pricing_json)
    assert stored["gemini-2.5-flash"]["provider"] == "google"


def test_ui_config_update_reports_persist_path(client: TestClient, api_settings: Settings):
    with patch.object(api_settings.__class__, "save_yaml", return_value=Path("data/settings.runtime.yaml")):
        response = client.put(
            "/ui/config",
            json={
                "llm_provider": "openai",
                "agent_model": "gpt-4o-mini",
                "orchestrator_model": "gpt-4o-mini",
                "gemini_temperature": 0.4,
                "llm_tuning": {
                    "provider_defaults": {
                        "openai": {"temperature": 0.3, "top_p": 0.9},
                    },
                    "model_overrides": {
                        "openai::gpt-4o-mini": {"max_tokens": 1024},
                    },
                },
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["llm_provider"] == "openai"
    assert payload["agent_model"] == "gpt-4o-mini"
    assert payload["llm_tuning"]["provider_defaults"]["openai"]["temperature"] == 0.3
    assert payload["llm_tuning"]["model_overrides"]["openai::gpt-4o-mini"]["max_tokens"] == 1024
    assert payload["config_persisted"] is True
    assert payload["config_persist_path"].replace("\\", "/").endswith("data/settings.runtime.yaml")
    assert "browser_runtime_sync_status" in payload


def test_ui_config_update_reports_persist_error(client: TestClient, api_settings: Settings):
    with patch.object(api_settings.__class__, "save_yaml", side_effect=OSError("read-only file system")):
        response = client.put(
            "/ui/config",
            json={
                "llm_provider": "openrouter",
                "agent_model": "openai/gpt-4o-mini",
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["llm_provider"] == "openrouter"
    assert payload["config_persisted"] is False
    assert "read-only" in payload["config_persist_error"].lower()


def test_ui_config_update_normalizes_browser_runtime(client: TestClient, api_settings: Settings):
    with patch.object(api_settings.__class__, "save_yaml", return_value=Path("data/settings.runtime.yaml")), \
         patch.object(api_settings.__class__, "save_browser_runtime_bridge", return_value=Path("data/browser.runtime.json")):
        response = client.put(
            "/ui/config",
            json={
                "browser_runtime": {
                    "puppeteer": {
                        "fingerprint_fallback_strategy": "none",
                        "proxy_enabled": True,
                        "proxy_source_mode": "remote",
                        "proxy_source_order": ["speedx-http", "openproxylist-socks5"],
                        "proxy_rotation_mode": "sticky",
                        "proxy_selection_strategy": "random",
                        "proxy_fallback_strategy": "fail",
                        "proxy_fetch_timeout_ms": 9000,
                        "proxy_validation_timeout_ms": 14000,
                        "proxy_cache_ttl_ms": 700000,
                        "proxy_max_candidates": 30,
                        "proxy_test_url": "https://example.com/ip",
                        "streaming_safe_mode": "always",
                        "media_proxy_strategy": "proxy_first",
                        "asset_diagnostics_enabled": False,
                        "iframe_auto_recovery_enabled": False,
                        "iframe_recovery_timeout_ms": 26000,
                        "media_capture_timeout_ms": 45000,
                        "media_retry_count": 4,
                        "media_retry_backoff_ms": [500, 1000, 2000],
                        "media_cors_patch_enabled": True,
                        "media_playback_verification_enabled": False,
                    }
                }
            },
        )

    assert response.status_code == 200
    runtime = response.json()["browser_runtime"]["puppeteer"]
    assert runtime["fingerprint_fallback_strategy"] == "none"
    assert runtime["proxy_enabled"] is True
    assert runtime["proxy_source_mode"] == "remote"
    assert runtime["proxy_source_order"] == ["speedx-http", "openproxylist-socks5"]
    assert runtime["proxy_rotation_mode"] == "sticky"
    assert runtime["proxy_selection_strategy"] == "random"
    assert runtime["proxy_fallback_strategy"] == "fail"
    assert runtime["proxy_fetch_timeout_ms"] == 9000
    assert runtime["proxy_validation_timeout_ms"] == 14000
    assert runtime["proxy_cache_ttl_ms"] == 700000
    assert runtime["proxy_max_candidates"] == 30
    assert runtime["proxy_test_url"] == "https://example.com/ip"
    assert runtime["streaming_safe_mode"] == "always"
    assert runtime["media_proxy_strategy"] == "proxy_first"
    assert runtime["asset_diagnostics_enabled"] is False
    assert runtime["iframe_auto_recovery_enabled"] is False
    assert runtime["iframe_recovery_timeout_ms"] == 26000
    assert runtime["media_capture_timeout_ms"] == 45000
    assert runtime["media_retry_count"] == 4
    assert runtime["media_retry_backoff_ms"] == [500, 1000, 2000]
    assert runtime["media_cors_patch_enabled"] is True
    assert runtime["media_playback_verification_enabled"] is False


def test_browser_runtime_sync_status_reports_bridge_metadata(tmp_path: Path):
    runtime_source = tmp_path / "settings.runtime.yaml"
    runtime_source.write_text("browser_runtime: {}\n", encoding="utf-8")
    bridge_path = tmp_path / "browser.runtime.json"
    bridge_path.write_text(
        json.dumps(
            {
                "runtime_sync": {
                    "source_path": str(runtime_source),
                    "bridge_path": str(bridge_path),
                    "synced_at": "2026-04-26T12:00:00+00:00",
                    "active_runtime_source": "runtime_yaml",
                }
            }
        ),
        encoding="utf-8",
    )

    status = build_browser_runtime_sync_status(
        runtime_json_path=bridge_path,
        yaml_path=tmp_path / "settings.yaml",
        runtime_yaml_path=runtime_source,
    )

    assert status["bridge_exists"] is True
    assert status["source_exists"] is True
    assert status["active_runtime_source"] == "runtime_yaml"
    assert status["synced_at"] == "2026-04-26T12:00:00+00:00"


def test_ui_config_update_supports_partial_tab_saves(client: TestClient, api_settings: Settings):
    api_settings.llm_provider = "openai"
    api_settings.agent_model = "gpt-4o-mini"
    api_settings.orchestrator_model = "gpt-4o"
    api_settings.browser_engine = "puppeteer"
    api_settings.deepeval_provider = "openai"
    api_settings.deepeval_model = "gpt-4o"

    with patch.object(api_settings.__class__, "save_yaml", return_value=Path("data/settings.runtime.yaml")), \
         patch.object(api_settings.__class__, "save_browser_runtime_bridge", return_value=Path("data/browser.runtime.json")):
        response = client.put(
            "/ui/config",
            json={
                "browser_engine": "playwright",
                "browser_runtime": {
                    "playwright": {
                        "launch_timeout_ms": 61000,
                    }
                },
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["browser_engine"] == "playwright"
    assert payload["browser_runtime"]["playwright"]["launch_timeout_ms"] == 61000
    assert payload["llm_provider"] == "openai"
    assert payload["agent_model"] == "gpt-4o-mini"
    assert payload["orchestrator_model"] == "gpt-4o"
    assert payload["deepeval_provider"] == "openai"
    assert payload["deepeval_model"] == "gpt-4o"


def test_ui_provider_models_returns_catalog(client: TestClient):
    catalog = {
        "provider": "openai",
        "name": "OpenAI",
        "key_env": "OPENAI_API_KEY",
        "api_key_set": True,
        "source": "provider_api",
        "error": "",
        "models": [{"id": "gpt-5", "label": "gpt-5"}],
        "hyperparameters": [{"key": "temperature", "type": "number"}],
    }

    with patch("src.api.app.get_provider_model_catalog", return_value=catalog) as mock_catalog:
        response = client.get("/ui/providers/models", params={"provider": "openai"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["provider"] == "openai"
    assert payload["models"][0]["id"] == "gpt-5"
    mock_catalog.assert_called_once()


def test_ui_evaluation_lab_reports_deepeval_readiness(client: TestClient, api_settings: Settings):
    api_settings.openrouter_api_key = "sk-or-test"

    with patch("src.api.app.importlib.util.find_spec", side_effect=lambda name: object() if name in {"deepeval", "openai"} else None):
        response = client.get("/ui/evaluations/lab")

    assert response.status_code == 200
    payload = response.json()
    assert payload["ready"] is True
    assert payload["deepeval_available"] is True
    assert payload["openai_package_available"] is True
    assert payload["openrouter_api_key_configured"] is True
    assert payload["metrics"][0]["id"] == "hallucination"
    assert payload["commands"]["deepeval"] == "deepeval test run tests/test_deepeval_metrics.py"


def test_ui_evaluation_run_supports_manual_batches(client: TestClient):
    def build_case_result(case, *_args, **_kwargs) -> EvaluationCaseResult:
        return EvaluationCaseResult(
            case_id=case.id,
            case_name=case.name,
            status="passed",
            target_type=case.target_type,
            latency_ms=250.0,
            total_cost_usd=0.02,
            hallucination_score=1.0,
            tool_accuracy_score=1.0,
            reliability_score=1.0,
            output={"url": case.input.get("url", ""), "final_status": "success"},
            trace={"events": [{"kind": "tool_call_started", "details": {"tool_name": "open_url"}}]},
        )

    def finalize_run(run_id: str, *, case_results, summary, status: str = "completed") -> EvaluationRun:
        return EvaluationRun(
            run_id=run_id,
            name="Smoke batch",
            mode=summary["mode"],
            status=status,
            success_rate=1.0,
            hallucination_rate=0.0,
            tool_accuracy_rate=1.0,
            reliability_rate=1.0,
            avg_latency_ms=250.0,
            avg_cost_usd=0.02,
            case_count=len(case_results),
            pass_count=summary["pass_count"],
            summary=summary,
            case_results=case_results,
        )

    with patch("src.api.app.get_session", return_value=MagicMock()) as mock_get_session, \
         patch("src.api.app.OperatorConsoleRepository") as mock_repo_cls, \
         patch("src.api.app._execute_evaluation_case", side_effect=build_case_result):
        repo = MagicMock()
        repo.finalize_evaluation_run.side_effect = finalize_run
        mock_repo_cls.return_value = repo

        response = client.post(
            "/ui/evaluations/run",
            json={
                "batch_name": "Smoke batch",
                "mode": "live",
                "urls": [
                    "https://alpha.example/live",
                    "https://beta.example/watch",
                ],
            },
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["summary"]["source"] == "manual_batch"
    assert payload["summary"]["input_urls"] == [
        "https://alpha.example/live",
        "https://beta.example/watch",
    ]
    repo.create_evaluation_run.assert_called_once()
    create_args = repo.create_evaluation_run.call_args.args
    assert create_args[0] is None
    assert create_args[1] == "Smoke batch"
    assert create_args[2] == "live"
    mock_get_session.return_value.close.assert_called_once()


def test_ui_database_tables_returns_allowlist(client: TestClient):
    response = client.get("/ui/database/tables")

    assert response.status_code == 200
    assert "pipeline_runs" in response.json()["tables"]
    assert "evaluation_runs" in response.json()["tables"]
    assert "tool_playground_calls" in response.json()["tables"]


def test_ui_workflow_run_returns_generated_run_id(client: TestClient):
    response = client.post("/ui/workflows/run", json={"url": "https://example.com/watch"})

    assert response.status_code == 200
    assert response.json()["root_actor"] == "orchestrator"
    assert response.json()["run_id"]
    assert response.json()["job_status"] in {"queued", "running", "retrying"}


def test_ui_workflow_run_honors_idempotency_key(client: TestClient):
    payload = {"url": "https://example.com/watch", "idempotency_key": "same-request"}
    first = client.post("/ui/workflows/run", json=payload)
    second = client.post("/ui/workflows/run", json=payload)

    assert first.status_code == 200
    assert second.status_code == 200
    if first.json().get("fallback") == "in_memory" or second.json().get("fallback") == "in_memory":
        assert first.json()["idempotency_key"] == "same-request"
        assert second.json()["idempotency_key"] == "same-request"
    else:
        assert first.json()["run_id"] == second.json()["run_id"]


def test_ui_run_detail_returns_active_trace(client: TestClient):
    run_id = "ui-active-run"
    observer = run_registry.create(
        run_id=run_id,
        root_actor="orchestrator",
        observability=ObservabilityStatus(
            enabled=False,
            project="test",
            pricing_models=[],
            default_dataset_name="open-web-catcher-runs",
        ),
    )
    observer.emit("pipeline_started", "Pipeline started")

    response = client.get(f"/ui/runs/{run_id}")

    assert response.status_code == 200
    assert response.json()["active_trace"]["run_id"] == run_id


def test_ui_run_stream_emits_sse_payload(client: TestClient):
    run_id = "ui-stream-run"
    observer = run_registry.create(
        run_id=run_id,
        root_actor="orchestrator",
        observability=ObservabilityStatus(
            enabled=False,
            project="test",
            pricing_models=[],
            default_dataset_name="open-web-catcher-runs",
        ),
    )
    observer.emit("pipeline_started", "Pipeline started")
    observer.finish(success=True)

    with client.stream("GET", f"/ui/runs/{run_id}/stream") as response:
        body = "".join(chunk.decode("utf-8") for chunk in response.iter_raw())

    assert response.status_code == 200
    assert "\"run_id\": \"" + run_id + "\"" in body
    assert "\"completed\": true" in body.lower()


@pytest.mark.asyncio
async def test_stream_trace_returns_immediately_when_client_disconnected():
    from src.api import app as api_app

    class _DisconnectedRequest:
        async def is_disconnected(self) -> bool:
            return True

    stream = api_app._stream_trace("missing-run", request=_DisconnectedRequest())
    with pytest.raises(StopAsyncIteration):
        await anext(stream)


def test_ui_tool_call_returns_result_and_persisted_record(client: TestClient):
    with patch("src.api.app._execute_tool_call_with_telemetry", new=AsyncMock(return_value={
        "call_id": "tool-call-1",
        "result": {"ok": True},
        "record": {"call_id": "tool-call-1", "status": "success"},
    })):
        response = client.post(
            "/ui/tools/call",
            json={"profile": "hosting", "tool_name": "capture_streams", "args": {"frame_path": "root"}},
        )

    assert response.status_code == 200
    assert response.json()["call_id"] == "tool-call-1"
    assert response.json()["record"]["status"] == "success"


@pytest.mark.asyncio
async def test_playground_tool_calls_reuse_mcp_session(api_settings: Settings):
    from src.api import app as api_app

    open_count = 0
    tool = MagicMock()
    tool.name = "open_url"
    tool.ainvoke = AsyncMock(return_value={"ok": True})

    @asynccontextmanager
    async def fake_agent_tools(profile: str, settings: Settings, observer=None):
        nonlocal open_count
        open_count += 1
        yield [tool]

    with patch.object(api_app, "_settings", api_settings), patch("src.api.app.agent_tools", side_effect=fake_agent_tools):
        await api_app._close_all_playground_tool_sessions()
        await api_app._call_mcp_tool("hosting", "open_url", {"url": "https://example.com"}, reuse_playground_session=True)
        await api_app._call_mcp_tool("hosting", "open_url", {"url": "https://example.com"}, reuse_playground_session=True)
        await api_app._close_all_playground_tool_sessions()

    assert open_count == 1
    assert tool.ainvoke.await_count == 2


def test_ui_tool_history_returns_repository_payload(client: TestClient):
    payload = {
        "total": 2,
        "rows": [
            {"call_id": "call-2", "profile": "hosting", "tool_name": "capture_streams", "status": "error"},
            {"call_id": "call-1", "profile": "hosting", "tool_name": "capture_streams", "status": "success"},
        ],
    }
    with patch("src.api.app.OperatorConsoleRepository") as mock_repo_cls, \
         patch("src.api.app.get_session") as mock_get_session:
        session = MagicMock()
        mock_get_session.return_value = session
        mock_repo_cls.return_value.list_tool_playground_calls.return_value = payload
        response = client.get("/ui/tools/history?profile=hosting")

    assert response.status_code == 200
    assert response.json()["total"] == 2
    assert response.json()["rows"][0]["call_id"] == "call-2"


def test_ui_provider_lookup_returns_rows_and_stats(client: TestClient):
    payload = [
        {
            "lookup_id": "lookup-1",
            "stream_url": "https://cdn.example.com/live/master.m3u8",
            "hostname": "cdn.example.com",
            "ip": "1.2.3.4",
            "provider": "Cloudflare, Inc.",
            "country": "US",
            "abuse_email": "abuse@cloudflare.com",
        }
    ]
    with patch("src.api.app._provider_lookup_urls", return_value=payload):
        response = client.post(
            "/ui/providers/lookup",
            json={"stream_urls": ["https://cdn.example.com/live/master.m3u8"]},
        )

    assert response.status_code == 200
    assert response.json()["rows"][0]["provider"] == "Cloudflare, Inc."
    assert response.json()["stats"]["resolved_ips"] == 1


def test_ui_provider_history_returns_repository_payload(client: TestClient):
    payload = {
        "total": 2,
        "rows": [{"lookup_id": "lookup-1", "provider": "Cloudflare, Inc."}],
        "summary": {"total_checks": 2},
        "top_providers": [{"provider": "Cloudflare, Inc.", "count": 1}],
        "top_countries": [{"country": "US", "count": 1}],
    }
    with patch("src.api.app.OperatorConsoleRepository") as mock_repo_cls, \
         patch("src.api.app.get_session") as mock_get_session:
        session = MagicMock()
        mock_get_session.return_value = session
        mock_repo_cls.return_value.get_provider_lookup_history.return_value = payload
        response = client.get("/ui/providers/history")

    assert response.status_code == 200
    assert response.json()["summary"]["total_checks"] == 2
    assert response.json()["top_providers"][0]["provider"] == "Cloudflare, Inc."
