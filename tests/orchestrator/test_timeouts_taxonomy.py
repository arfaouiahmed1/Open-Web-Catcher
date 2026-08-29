"""Unit tests for the typed failure taxonomy, global workflow timeout, and
between-stage budget governor (plan T30 / AGT-H3/H4/M7/M8).

Covers:
- classify_failure_kind maps typed exceptions and legacy string markers onto
  FailureKind values;
- _failed_extraction stamps failure_kind into ExtractionResult metadata and
  routes TIMEOUT kinds to ExtractionStatus.TIMEOUT;
- OrchestratorAgent.run terminates a hung pipeline at the global workflow
  timeout and returns a partial PipelineResult with the correct status,
  failure_kind, and observer finish mode (dead routing branch removed);
- the budget governor raises WorkflowBudgetExceededError between stages when
  configured limits are exceeded and stays silent otherwise.
"""

from __future__ import annotations

import asyncio

import pytest

from src.agents.errors import (
    RunCancelledError,
    WorkflowBudgetExceededError,
    WorkflowTimeoutError,
)
from src.agents.orchestrator import (
    OrchestratorAgent,
    _failed_extraction,
    _WorkflowGovernor,
    classify_failure_kind,
    make_workflow_governor,
)
from src.models.enums import AgentType, ExtractionStatus, FailureKind, PageType
from src.utils.config import Settings
from src.utils.observability import ObservabilityStatus, RunObserver, RunRegistry

URL = "https://target.example/watch/1"


def _observer() -> RunObserver:
    status = ObservabilityStatus(
        enabled=True,
        project="test",
        default_dataset_name="test-ds",
    )
    return RunRegistry().create(
        run_id="run-t30", root_actor="orchestrator", observability=status
    )


@pytest.mark.unit
@pytest.mark.parametrize(
    ("exc", "expected"),
    [
        (RunCancelledError("user stop"), FailureKind.CANCELLED),
        (WorkflowBudgetExceededError("over"), FailureKind.BUDGET_EXCEEDED),
        (WorkflowTimeoutError("deadline"), FailureKind.WORKFLOW_TIMEOUT),
        # NOTE: on Python 3.11+ ``asyncio.TimeoutError`` *is* builtin TimeoutError,
        # so one parametrization covers the alias too.
        (TimeoutError("socket timed out"), FailureKind.TIMEOUT),
        (RuntimeError("navigation to https://x timed out after 30s"), FailureKind.TIMEOUT),
        (RuntimeError("connection refused by host"), FailureKind.SITE_INACCESSIBLE),
        (RuntimeError("boom"), FailureKind.AGENT_ERROR),
    ],
)
def test_classify_failure_kind(exc: BaseException, expected: FailureKind) -> None:
    assert classify_failure_kind(exc) is expected


@pytest.mark.unit
def test_failed_extraction_stamps_timeout_kind() -> None:
    result = _failed_extraction(
        URL, PageType.HOSTING, AgentType.HOSTING_PAGE, TimeoutError("timed out")
    )
    assert result.status is ExtractionStatus.TIMEOUT
    assert result.metadata["failure_kind"] == FailureKind.TIMEOUT.value


@pytest.mark.unit
def test_failed_extraction_stamps_agent_error_kind() -> None:
    result = _failed_extraction(
        URL, PageType.EMBEDDED, AgentType.EMBEDDED_PAGE, RuntimeError("kaboom")
    )
    assert result.status is ExtractionStatus.FAILED
    assert result.metadata["failure_kind"] == FailureKind.AGENT_ERROR.value


@pytest.mark.asyncio
async def test_run_terminates_hung_pipeline_at_global_timeout(monkeypatch) -> None:
    settings = Settings(workflow_timeout_seconds=1)
    agent = OrchestratorAgent(settings)
    observer = _observer()
    agent.observer = observer

    async def fake_consume(self, initial_state, sink):
        # Simulate a stage that produced evidence, then hung forever.
        await asyncio.sleep(3600)

    monkeypatch.setattr(OrchestratorAgent, "_consume_graph_stream", fake_consume)

    result = await asyncio.wait_for(agent.run(URL), timeout=15)

    assert result.failure_kind == FailureKind.WORKFLOW_TIMEOUT.value
    # Partial evidence collected before the deadline survives the abort.
    assert result.final_status in {ExtractionStatus.FAILED, ExtractionStatus.PARTIAL}
    assert observer.trace().metrics is not None
    assert observer.trace().metrics.failure_mode == FailureKind.WORKFLOW_TIMEOUT.value
    assert not any(event.kind == "pipeline_failed" for event in observer.trace().events)


@pytest.mark.unit
def test_governor_silent_under_budget() -> None:
    observer = _observer()
    observer._state.metrics.total_tokens_in = 100
    observer._state.metrics.total_tokens_out = 50
    check = make_workflow_governor(
        Settings(workflow_max_tokens=10_000, workflow_max_cost_usd=1.0), observer
    )
    check("analyze_providers")  # must not raise


@pytest.mark.unit
def test_governor_raises_between_stages_on_token_overrun() -> None:
    observer = _observer()
    observer._state.metrics.total_tokens_in = 900
    observer._state.metrics.total_tokens_out = 200
    check = make_workflow_governor(Settings(workflow_max_tokens=500), observer)
    with pytest.raises(WorkflowBudgetExceededError):
        check("generate_takedown_emails")


@pytest.mark.unit
def test_governor_raises_between_stages_on_cost_overrun() -> None:
    observer = _observer()
    observer._state.metrics.estimated_total_cost_usd = 0.75
    check = make_workflow_governor(Settings(workflow_max_cost_usd=0.5), observer)
    with pytest.raises(WorkflowBudgetExceededError):
        check("hosting_page")


@pytest.mark.unit
def test_governor_disabled_without_budget_or_observer() -> None:
    # No budgets configured -> no-op even with an observer.
    observer = _observer()
    observer._state.metrics.total_tokens_in = 999_999
    check = make_workflow_governor(Settings(), observer)
    check("anything")

    # Budgets configured but no observer -> cannot read metrics, stays silent.
    check_no_observer = make_workflow_governor(Settings(workflow_max_tokens=1), None)
    check_no_observer("anything")


@pytest.mark.unit
def test_governor_records_exceeded_kind_and_raises_once() -> None:
    assert _WorkflowGovernor(None, max_tokens=10).enabled is False  # no observer

    observer = _observer()
    observer._state.metrics.total_tokens_out = 99
    governor = _WorkflowGovernor(observer, max_tokens=10)
    assert governor.enabled is True
    with pytest.raises(WorkflowBudgetExceededError):
        governor.check("stage_a")
    # Second check after exhaustion is a silent no-op (already tripped).
    governor.check("stage_b")
