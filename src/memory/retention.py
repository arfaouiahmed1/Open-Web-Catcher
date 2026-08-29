"""Memory retention tick (plan task 19, batch W4).

Scheduled cleanup that deletes expired site hints and orphaned logo
embeddings, exposing count metrics for observability.

Public API
----------
``run_retention_tick(repository, session=None)`` returns::

    {"hints_pruned": int, "embeddings_orphaned": int}

Duck-typed contract for ``repository`` (the real ``SiteHintRepository``
lands with plan task 18 — see ``TODO(plan-T19-integrate)``)::

    prune_expired(now: datetime | None = None) -> int   # rows deleted

Orphan sweep
------------
Embeddings in ``logo_embeddings`` whose ``source_screenshot_id`` no longer
resolves to a row in ``run_screenshots`` are deleted. The query is written
against the table schema agreed for plan task 18; until that migration
exists the sweep degrades to a no-op (missing table -> 0) instead of
raising, so this module is safe to wire up before/alongside task 18.

Registration scaffold
---------------------
There is no periodic-job registry in ``src/api/app.py`` today: background
work runs either through the DB-backed job queue (``_background_worker_loop``,
driven by ``background_jobs`` rows) or as one-shot startup cleanup in
``lifespan()`` (see ``RunRepository.cleanup_old_artifacts``). Registration
therefore belongs in ``lifespan()`` next to the artifact cleanup, e.g.::

    from src.memory.retention import run_retention_tick
    ...
    retention_counts = run_retention_tick(SiteHintRepository(session), session)

TODO(plan-T19-integrate): swap the duck-typed repository for the real
``SiteHintRepository`` (task 18) at the call site above, and decide whether
the tick should also run periodically inside ``_background_worker_loop``
(idle branch) rather than once per startup.
"""

from __future__ import annotations

import logging
from typing import Any, Final, Protocol

from sqlalchemy import text
from sqlalchemy.exc import OperationalError, ProgrammingError
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

#: Embeddings pointing at a screenshot id that no longer exists.
_ORPHAN_EMBEDDINGS_SQL: Final[str] = """
DELETE FROM logo_embeddings
WHERE source_screenshot_id IS NOT NULL
  AND source_screenshot_id NOT IN (SELECT id FROM run_screenshots)
"""


class SiteHintRepositoryProtocol(Protocol):
    """Minimal interface retention needs; real repo satisfies it structurally."""

    def prune_expired(self, now: Any = None) -> int:  # pragma: no cover - protocol
        ...


def _prune_orphaned_embeddings(session: Session) -> int:
    """Delete embeddings whose source screenshot is gone; return rowcount.

    Missing-table errors are swallowed (task 18 owns that migration), but any
    other failure propagates so misconfiguration surfaces loudly.
    """
    try:
        result = session.execute(text(_ORPHAN_EMBEDDINGS_SQL))
        session.commit()
    except (OperationalError, ProgrammingError) as exc:
        # Table(s) not created yet (pre-task-18 database): treat as no-op.
        logger.debug("Skipping embedding orphan sweep: %s", exc)
        session.rollback()
        return 0
    return int(result.rowcount or 0)


def run_retention_tick(
    repository: SiteHintRepositoryProtocol,
    session: Session | None = None,
) -> dict[str, int]:
    """Run one retention pass; return deletion counts for metrics/logs."""
    hints_pruned = int(repository.prune_expired() or 0)
    embeddings_orphaned = _prune_orphaned_embeddings(session) if session is not None else 0
    counts = {"hints_pruned": hints_pruned, "embeddings_orphaned": embeddings_orphaned}
    if any(counts.values()):
        logger.info("Retention tick: %s", counts)
    return counts
