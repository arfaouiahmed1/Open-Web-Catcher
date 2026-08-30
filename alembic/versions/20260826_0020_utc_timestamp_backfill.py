"""UTC end-to-end: timezone-aware timestamp columns + UTC backfill (plan T33)

Revision ID: 20260826_0020
Revises: 20260825_0019
Create Date: 2026-08-26

Every ``DateTime`` column in ``src.storage.models`` became
``DateTime(timezone=True)`` and writers switched from naive
``datetime.utcnow()`` to aware ``datetime.now(timezone.utc)``. This revision
migrates EXISTING rows:

- PostgreSQL: session ``TIME ZONE`` pinned to ``UTC``, then every timestamp
  column is altered to ``TIMESTAMPTZ``. With the session zone pinned, naive
  ``timestamp`` values are interpreted AS UTC during the cast (the historical
  write convention), so no data shift occurs.
- SQLite: values are ISO strings; naive ones (no offset/Z suffix) are
  rewritten with an explicit ``+00:00`` so the driver returns AWARE datetimes
  matching the new column type. No DDL needed — SQLite does not enforce the
  tz flag, and ORM-created test databases already carry the new type.

Column set is derived from ``Base.metadata`` so the migration cannot drift
from the models: any DateTime column added later is picked up automatically,
and tables absent from legacy databases (early revisions bootstrap via
``Base.metadata.create_all``) are skipped.

Revision 20260826_0021 also chains from 0019; ordering reconciliation between
the two wave-3 revisions is owned by the orchestrator.
"""

from __future__ import annotations

import logging
import re

import sqlalchemy as sa

from alembic import op
from src.storage.models import Base

logger = logging.getLogger(__name__)

revision = "20260826_0020"
down_revision = "20260825_0019"
branch_labels = None
depends_on = None

# Matches a trailing UTC designator or numeric offset on an ISO string.
_AWARE_RE = re.compile(r"(?:Z|[+-]\d{2}:?\d{2})$", re.IGNORECASE)


def _datetime_columns() -> list[tuple[str, str]]:
    """(table_name, column_name) pairs for every DateTime column, in stable order."""
    targets: list[tuple[str, str]] = []
    for table in sorted(Base.metadata.tables.values(), key=lambda t: t.name):
        for column in table.columns:
            if isinstance(column.type, sa.DateTime):
                targets.append((table.name, column.name))
    return targets


def _backfill_sqlite(bind, table: str, column: str) -> int:
    """Append '+00:00' to naive ISO timestamp strings; returns rows fixed."""
    rows = bind.execute(
        sa.text(f'SELECT id, "{column}" FROM "{table}"')  # noqa: S608 - identifiers from metadata
    ).fetchall()
    fixed = 0
    for row_id, value in rows:
        if not isinstance(value, str) or not value.strip() or _AWARE_RE.search(value):
            continue
        bind.execute(
            sa.text(f'UPDATE "{table}" SET "{column}" = :v WHERE id = :id'),  # noqa: S608
            {"v": value + "+00:00", "id": row_id},
        )
        fixed += 1
    return fixed


def upgrade() -> None:
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"
    existing_tables = set(sa.inspect(bind).get_table_names())

    if is_postgres:
        # Naive -> timestamptz casts interpret values in the SESSION zone;
        # pinning UTC makes the historical naive values read AS UTC.
        op.execute("SET TIME ZONE 'UTC'")

    for table, column in _datetime_columns():
        if table not in existing_tables:
            continue
        nullable = {
            c["name"]: c for c in sa.inspect(bind).get_columns(table)
        }[column]["nullable"]
        if is_postgres:
            op.alter_column(
                table,
                column,
                type_=sa.DateTime(timezone=True),
                existing_type=sa.DateTime(),
                existing_nullable=nullable,
            )
        else:
            try:
                fixed = _backfill_sqlite(bind, table, column)
                if fixed:
                    logger.info("utc backfill %s.%s: %s rows stamped +00:00", table, column, fixed)
            except sa.exc.SQLAlchemyError:  # pragma: no cover - defensive
                logger.exception("utc backfill skipped for %s.%s", table, column)


def downgrade() -> None:
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"
    existing_tables = set(sa.inspect(bind).get_table_names())

    if is_postgres:
        # Cast back with the session zone pinned to UTC so stored instants
        # become UTC wall-clock naive values — the pre-T33 convention.
        op.execute("SET TIME ZONE 'UTC'")
        for table, column in _datetime_columns():
            if table not in existing_tables:
                continue
            op.alter_column(
                table,
                column,
                type_=sa.DateTime(),
                existing_type=sa.DateTime(timezone=True),
            )
    # SQLite downgrade is a no-op: offsets stay on the strings, which remain
    # readable by both naive-era code paths and the aware ORM types.
