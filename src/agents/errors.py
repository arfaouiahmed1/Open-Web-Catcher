"""Shared lightweight exceptions for agent control flow."""


class RunCancelledError(Exception):
    """Raised when a live run is cancelled from the UI."""


class BudgetExceededError(Exception):
    """Raised when the agent cannot make more tool calls."""


class WorkflowTimeoutError(Exception):
    """Raised when a pipeline run exceeds its global workflow timeout.

    Distinct from per-tool/per-agent timeouts so the orchestrator can report
    ``FailureKind.WORKFLOW_TIMEOUT`` and still return the partial evidence
    collected before the deadline (plan T30 / AGT-H3/H4).
    """

    def __init__(self, message: str = "Workflow exceeded global timeout") -> None:
        super().__init__(message)


class WorkflowBudgetExceededError(Exception):
    """Raised when a pipeline run exhausts its token/cost budget between stages.

    The orchestrator catches this to take the graceful partial-completion
    path instead of surfacing an opaque crash (plan T30 / AGT-M7/M8).
    """

    def __init__(self, message: str = "Workflow exhausted its budget") -> None:
        super().__init__(message)
