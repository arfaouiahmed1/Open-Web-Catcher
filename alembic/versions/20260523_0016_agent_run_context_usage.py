"""Persist per-agent context usage rollups.

Revision ID: 20260523_0016
Revises: 20260520_0015
Create Date: 2026-05-23 00:00:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "20260523_0016"
down_revision = "20260520_0015"
branch_labels = None
depends_on = None


def _columns(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {col["name"] for col in inspector.get_columns(table_name)}


def _add_if_missing(table_name: str, column: sa.Column) -> None:
    if column.name not in _columns(table_name):
        op.add_column(table_name, column)


def upgrade() -> None:
    _add_if_missing(
        "agent_runs",
        sa.Column("provider", sa.String(length=64), nullable=False, server_default=""),
    )
    _add_if_missing(
        "agent_runs",
        sa.Column("model_name", sa.String(length=128), nullable=False, server_default=""),
    )
    _add_if_missing(
        "agent_runs",
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "agent_runs",
        sa.Column("cached_input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "agent_runs",
        sa.Column("new_input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "agent_runs",
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "agent_runs",
        sa.Column("context_window", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "agent_runs",
        sa.Column("context_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "agent_runs",
        sa.Column("context_usage_pct", sa.Float(), nullable=False, server_default="0.0"),
    )


def downgrade() -> None:
    existing = _columns("agent_runs")
    for column_name in [
        "context_usage_pct",
        "context_tokens",
        "context_window",
        "output_tokens",
        "new_input_tokens",
        "cached_input_tokens",
        "input_tokens",
        "model_name",
        "provider",
    ]:
        if column_name in existing:
            op.drop_column("agent_runs", column_name)
