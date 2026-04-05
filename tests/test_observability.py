from __future__ import annotations

from src.models.enums import AgentType
from src.utils.config import Settings
from src.utils.observability import LangSmithStatus, RunRegistry, get_langsmith_status


def test_get_langsmith_status_reports_missing_key_warning():
    settings = Settings(
        google_api_key="test",
        langchain_tracing_v2=True,
        langchain_api_key="",
        langchain_project="open-web-catcher",
        langsmith_endpoint="https://api.smith.langchain.com",
    )

    status = get_langsmith_status(settings)

    assert status == LangSmithStatus(
        enabled=True,
        api_key_configured=False,
        project="open-web-catcher",
        endpoint="https://api.smith.langchain.com",
        tracing_env="true",
        warnings=["Tracing is enabled but LANGSMITH_API_KEY / LANGCHAIN_API_KEY is missing."],
    )


def test_run_registry_tracks_events_and_metrics():
    registry = RunRegistry(max_runs=2)
    observer = registry.create(
        run_id="run-1",
        root_actor="orchestrator",
        langsmith=LangSmithStatus(
            enabled=False,
            api_key_configured=False,
            project="open-web-catcher",
            endpoint="https://api.smith.langchain.com",
            tracing_env="false",
        ),
    )

    observer.set_url("https://example.com")
    observer.mark_agent(AgentType.ORCHESTRATOR)
    observer.emit("pipeline_started", "Pipeline started")
    observer.increment_tool_calls(2)
    observer.finish(success=True)

    trace = registry.get("run-1")

    assert trace is not None
    assert trace.metrics is not None
    assert trace.metrics.url == "https://example.com"
    assert trace.metrics.total_tool_calls == 2
    assert trace.metrics.agents_invoked == [AgentType.ORCHESTRATOR]
    assert trace.completed is True
    assert trace.events[0].message == "Pipeline started"
