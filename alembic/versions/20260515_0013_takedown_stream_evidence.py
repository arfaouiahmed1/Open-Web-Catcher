"""Add correlated stream evidence to takedown emails.

Revision ID: 20260515_0013
Revises: 20260505_0012
Create Date: 2026-05-15 14:30:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "20260515_0013"
down_revision = "20260505_0012"
branch_labels = None
depends_on = None


def _columns(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {col["name"] for col in inspector.get_columns(table_name)}


def upgrade() -> None:
    if "stream_evidence_json" not in _columns("takedown_emails"):
        op.add_column(
            "takedown_emails",
            sa.Column("stream_evidence_json", sa.JSON(), nullable=False, server_default="[]"),
        )


def downgrade() -> None:
    if "stream_evidence_json" in _columns("takedown_emails"):
        op.drop_column("takedown_emails", "stream_evidence_json")
