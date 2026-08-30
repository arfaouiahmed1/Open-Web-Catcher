"""RunPlan emission + step-transition helpers (plan task 27).

Wireable-by-anyone module so the RunPlan artifact can be produced WITHOUT
touching ``src/agents/orchestrator.py`` (locked to another worker this wave).
Every entry point takes an explicit ``observer`` and ``session``:

    from src.orchestrator.run_plan import emit_run_plan, transition_run_step

    emit_run_plan(observer, session, run_id, strategy, steps)   # at run start
    transition_run_step(observer, session, run_id, "s2", "in_progress")  # per node

Wiring later is one import plus one call per node body — no orchestrator.py
edits required.

TODO(plan-T27-wire): the three deferred call sites for next wave are:
  1. orchestrator run start -> emit_run_plan(...) right after the observer is
     created (before the first node runs).
  2. each pipeline node body entry -> transition_run_step(..., "in_progress").
  3. each pipeline node body exit -> transition_run_step(..., terminal status
     "done"/"failed"/"skipped" based on the node outcome).
Until those land, fixture-run transitions only occur when a caller invokes
these helpers directly (tests do; production nodes do not yet).
"""

from __future__ import annotations

from typing import Any

from sqlalchemy.orm import Session

from src.storage.repositories import RunPlanRepository
from src.utils.observability import RunObserver, RuntimeEvent

#: SSE-visible event kinds this module emits through the observer.
RUN_PLAN_CREATED_KIND = "run_plan_created"
PLAN_STEP_UPDATE_KIND = "plan_step_update"

__all__ = [
    "PLAN_STEP_UPDATE_KIND",
    "RUN_PLAN_CREATED_KIND",
    "emit_run_plan",
    "transition_run_step",
]


def _normalize_steps(steps: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Validate/normalize the declarative step list before persistence."""
    normalized: list[dict[str, Any]] = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError(f"plan step at index {index} must be a mapping")
        step_id = str(step.get("id", "")).strip()
        if not step_id:
            raise ValueError(f"plan step at index {index} is missing an 'id'")
        normalized.append(
            {
                "id": step_id,
                "title": str(step.get("title", "")),
                "criteria": str(step.get("criteria", "")),
                "budget": step.get("budget"),
            }
        )
    return normalized


def emit_run_plan(
    observer: RunObserver | None,
    session: Session,
    run_id: str,
    strategy: str,
    steps: list[dict[str, Any]],
) -> RuntimeEvent | None:
    """Persist the plan declaration and announce it on the run trace.

    Writes the ``run_plans`` row plus one pending ``plan_steps`` row per entry
    (idempotent per run), then emits a single ``run_plan_created`` event whose
    details carry the full document — that event rides the existing SSE poll
    loop to every /ui/runs/{id}/stream client. ``observer=None`` persists
    without announcing (useful for backfills and pure-persistence callers).
    """
    normalized = _normalize_steps(steps)
    repo = RunPlanRepository(session)
    repo.create_plan(run_id, strategy, normalized)

    if observer is None:
        return None
    return observer.emit(
        RUN_PLAN_CREATED_KIND,
        f"run plan declared ({len(normalized)} steps)",
        details={
            "run_id": run_id,
            "strategy": str(strategy or ""),
            "steps": normalized,
        },
    )


def transition_run_step(
    observer: RunObserver | None,
    session: Session,
    run_id: str,
    step_id: str,
    status: str,
) -> RuntimeEvent | None:
    """Move one plan step to ``status`` and emit its SSE carrier event.

    Persists via :meth:`RunPlanRepository.transition_step` (raises ValueError
    on unknown statuses/steps) and mirrors the transition as a
    ``plan_step_update`` event on the trace so stream clients see live progress.
    """
    record = RunPlanRepository(session).transition_step(run_id, step_id, status)

    if observer is None:
        return None
    return observer.emit(
        PLAN_STEP_UPDATE_KIND,
        f"plan step '{step_id}' -> {record.status}",
        details={
            "run_id": run_id,
            "step_id": record.step_id,
            "status": record.status,
            "position": int(record.position),
        },
    )
