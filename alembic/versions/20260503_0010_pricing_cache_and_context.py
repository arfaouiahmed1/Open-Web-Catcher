"""add cached_input_per_million, cache_write_per_million, context_window to pricing_configs"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260503_0010"
down_revision = "20260501_0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("pricing_configs")}
    if "cached_input_per_million" not in columns:
        op.add_column(
            "pricing_configs",
            sa.Column("cached_input_per_million", sa.Float(), nullable=False, server_default="0.0"),
        )
    if "cache_write_per_million" not in columns:
        op.add_column(
            "pricing_configs",
            sa.Column("cache_write_per_million", sa.Float(), nullable=False, server_default="0.0"),
        )
    if "context_window" not in columns:
        op.add_column(
            "pricing_configs",
            sa.Column("context_window", sa.Integer(), nullable=False, server_default="0"),
        )


def downgrade() -> None:
    op.drop_column("pricing_configs", "context_window")
    op.drop_column("pricing_configs", "cache_write_per_million")
    op.drop_column("pricing_configs", "cached_input_per_million")
