"""Add run decision and task records.

Revision ID: 20260505_0011
Revises: 20260503_0010
Create Date: 2026-05-05 11:45:00
"""

from __future__ import annotations

from alembic import op

from src.storage.models import Base


revision = "20260505_0011"
down_revision = "20260503_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(Base.metadata.sorted_tables):
        if table.name in {"run_decisions", "run_tasks"}:
            table.drop(bind=bind, checkfirst=True)
