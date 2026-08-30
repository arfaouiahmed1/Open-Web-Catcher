"""add cache-semantics and thinking-billing columns to pricing_configs

Revision ID: 20260822_0017
Revises: c69a9ee239fd
Create Date: 2026-08-22

Cost math v2 (plan task 11): pricing rows must carry the per-family cache
accounting semantics (Gemini/OpenAI treat cached tokens as a subset of the
prompt total; Anthropic reports disjoint read/write buckets) plus the cache
write multiplier (Anthropic write = 1.25x read) and whether thinking tokens
are billed at the output rate.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260822_0017"
down_revision = "c69a9ee239fd"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("pricing_configs")}
    if "cache_write_multiplier" not in columns:
        op.add_column(
            "pricing_configs",
            sa.Column("cache_write_multiplier", sa.Float(), nullable=False, server_default="1.0"),
        )
    if "cached_is_subset_of_input" not in columns:
        op.add_column(
            "pricing_configs",
            sa.Column(
                "cached_is_subset_of_input",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            ),
        )
    if "thinking_billed_as_output" not in columns:
        op.add_column(
            "pricing_configs",
            sa.Column(
                "thinking_billed_as_output",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            ),
        )


def downgrade() -> None:
    op.drop_column("pricing_configs", "thinking_billed_as_output")
    op.drop_column("pricing_configs", "cached_is_subset_of_input")
    op.drop_column("pricing_configs", "cache_write_multiplier")
