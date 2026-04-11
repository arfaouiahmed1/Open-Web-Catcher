from __future__ import annotations

from src.models.enums import AgentType
from src.utils.config import Settings
from src.utils.instrumentation import resolve_model_pricing
from src.utils.observability import ObservabilityStatus, RunRegistry, get_observability_status


def test_get_observability_status_reports_missing_pricing_warning():
    settings = Settings(
        google_api_key="test",
        observability_enabled=True,
        observability_project_name="open-web-catcher",
        default_dataset_name="open-web-catcher-runs",
        model_pricing_json="{}",
    )

    status = get_observability_status(settings)

    assert status == ObservabilityStatus(
        provider="internal",
        enabled=True,
        project="open-web-catcher",
        pricing_models=[],
        default_dataset_name="open-web-catcher-runs",
        warnings=[
            "No model pricing config is set. Token metrics work, but cost estimates stay at 0 until MODEL_PRICING_JSON or pricing rows are configured."
        ],
    )


def test_run_registry_tracks_events_metrics_and_costs():
    registry = RunRegistry(max_runs=2)
    observer = registry.create(
        run_id="run-1",
        root_actor="orchestrator",
        observability=ObservabilityStatus(
            enabled=False,
            project="open-web-catcher",
            pricing_models=["gemini-2.5-flash"],
            default_dataset_name="open-web-catcher-runs",
        ),
    )

    observer.set_url("https://example.com")
    observer.mark_agent(AgentType.ORCHESTRATOR)
    observer.emit("pipeline_started", "Pipeline started")
    observer.add_llm_usage(
        {"prompt_tokens": 1000, "completion_tokens": 500},
        model_name="gemini-2.5-flash",
        provider="google",
        pricing={"provider": "google", "input_per_million": 1.0, "output_per_million": 2.0},
    )
    observer.increment_tool_calls(2)
    observer.finish(success=True)

    trace = registry.get("run-1")

    assert trace is not None
    assert trace.metrics is not None
    assert trace.metrics.url == "https://example.com"
    assert trace.metrics.total_tool_calls == 2
    assert trace.metrics.total_llm_calls == 1
    assert trace.metrics.total_tokens_in == 1000
    assert trace.metrics.total_tokens_out == 500
    assert trace.metrics.estimated_total_cost_usd == 0.002
    assert trace.metrics.agents_invoked == [AgentType.ORCHESTRATOR]
    assert trace.completed is True
    assert trace.events[0].message == "Pipeline started"


def test_model_pricing_resolution_handles_provider_prefixes_and_suffixes():
    settings = Settings(
        **{
            "MODEL_PRICING_JSON": '{"claude-sonnet-4-6":{"provider":"anthropic","input_per_million":3.0,"output_per_million":15.0}}'
        }
    )

    pricing = resolve_model_pricing(
        settings,
        model_name="claude-sonnet-4-6-20251001",
        provider="anthropic",
    )

    assert pricing["provider"] == "anthropic"
    assert pricing["input_per_million"] == 3.0
    assert pricing["output_per_million"] == 15.0
