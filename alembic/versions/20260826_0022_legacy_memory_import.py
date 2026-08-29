"""One-shot legacy memory import into pgvector site_hints (plan task 18, phase 2)

Revision ID: 20260826_0022
Revises: 20260826_0021
Create Date: 2026-08-26

Before the legacy stores are decommissioned (``site_memory.db`` writes and the
JSON profiles store stop in this same wave), every accumulated row is imported
into ``site_hints`` so no cross-run memory is lost at cutover.

Sources (each skipped silently when absent, e.g. on fresh databases):

- SQLite ``data/site_memory.db`` → table ``site_memory_entries``
  (override with ``LEGACY_SITE_MEMORY_DB``).
- JSON ``data/site_memory_profiles.json`` → profile store
  (override with ``LEGACY_SITE_MEMORY_PROFILES_JSON``).

The heavy lifting lives in :func:`src.memory.legacy_import.import_legacy_site_memory`
so the round-trip is unit-testable against fixture stores.

NOTE: a concurrent lane may have landed ``20260826_0023`` also chained from
_0021; head-order reconciliation between the two wave-4 revisions is owned by
the orchestrator lane (mirrors the 0019/0020 situation).
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

import sqlalchemy as sa

from alembic import op

logger = logging.getLogger(__name__)

revision = "20260826_0022"
down_revision = "20260826_0021"
branch_labels = None
depends_on = None


def _legacy_db_path() -> Path:
    return Path(
        os.getenv("LEGACY_SITE_MEMORY_DB")
        or Path(__file__).resolve().parents[1] / "data" / "site_memory.db"
    )


def _legacy_profiles_path() -> Path:
    override = os.getenv("LEGACY_SITE_MEMORY_PROFILES_JSON")
    if override:
        return Path(override)
    db_path = _legacy_db_path()
    return db_path.with_name(f"{db_path.stem}_profiles.json")


def upgrade() -> None:
    bind = op.get_bind()

    db_path = _legacy_db_path()
    profiles_path = _legacy_profiles_path()
    if not db_path.exists() and not profiles_path.exists():
        logger.info(
            "No legacy memory stores found (%s, %s); nothing to import",
            db_path,
            profiles_path,
        )
        return

    # Import lazily: src.memory.long_term imports cleanly here, but keeping it
    # function-level avoids import cycles during non-upgrade alembic commands.
    from src.memory.legacy_import import import_legacy_site_memory

    # SiteHintRepository commits via its own transaction blocks; wrap the
    # migration connection in a Session that joins through savepoints so the
    # import lands atomically with this revision.
    session = sa.orm.Session(bind=bind, join_transaction_mode="create_savepoint")
    try:
        counts = import_legacy_site_memory(
            session,
            db_path=db_path if db_path.exists() else None,
            profiles_path=profiles_path if profiles_path.exists() else None,
        )
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()

    logger.info("Legacy memory import complete: %s", counts)


def downgrade() -> None:
    # One-shot data migration: legacy stores are deleted after cutover, so
    # there is nothing to restore rows INTO. Destructive removal of imported
    # hints is intentionally out of scope.
    logger.info("downgrade: no-op for one-shot legacy memory import")
