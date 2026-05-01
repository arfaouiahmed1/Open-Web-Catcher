"""add context_window column to llm_calls"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260501_0009"
down_revision = "20260426_0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("llm_calls")}
    if "context_window" not in columns:
        op.add_column("llm_calls", sa.Column("context_window", sa.Integer(), nullable=True))


def downgrade() -> None:
    op.drop_column("llm_calls", "context_window")
