"""Shared lightweight exceptions for agent control flow."""


class RunCancelledError(Exception):
    """Raised when a live run is cancelled from the UI."""


class BudgetExceededError(Exception):
    """Raised when the agent cannot make more tool calls."""
