"""Persist cached token and cost breakdowns.

Revision ID: 20260505_0012
Revises: 20260505_0011
Create Date: 2026-05-05 21:15:00
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "20260505_0012"
down_revision = "20260505_0011"
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
        "pipeline_runs",
        sa.Column("total_cached_input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "pipeline_runs",
        sa.Column("total_new_input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "pipeline_runs",
        sa.Column("total_cache_hit_calls", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "pipeline_runs",
        sa.Column("estimated_cached_input_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
    )
    _add_if_missing(
        "pipeline_runs",
        sa.Column("estimated_cache_write_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
    )

    _add_if_missing(
        "llm_calls",
        sa.Column("cached_input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "llm_calls",
        sa.Column("new_input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "llm_calls",
        sa.Column("cache_creation_input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "llm_calls",
        sa.Column("estimated_cached_input_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
    )
    _add_if_missing(
        "llm_calls",
        sa.Column("estimated_cache_write_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
    )

    _add_if_missing(
        "run_model_usage",
        sa.Column("cache_hit_calls", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "run_model_usage",
        sa.Column("cached_input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "run_model_usage",
        sa.Column("new_input_tokens", sa.Integer(), nullable=False, server_default="0"),
    )
    _add_if_missing(
        "run_model_usage",
        sa.Column("estimated_cached_input_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
    )
    _add_if_missing(
        "run_model_usage",
        sa.Column("estimated_cache_write_cost_usd", sa.Float(), nullable=False, server_default="0.0"),
    )


def downgrade() -> None:
    for table_name, column_names in {
        "run_model_usage": [
            "estimated_cache_write_cost_usd",
            "estimated_cached_input_cost_usd",
            "new_input_tokens",
            "cached_input_tokens",
            "cache_hit_calls",
        ],
        "llm_calls": [
            "estimated_cache_write_cost_usd",
            "estimated_cached_input_cost_usd",
            "cache_creation_input_tokens",
            "new_input_tokens",
            "cached_input_tokens",
        ],
        "pipeline_runs": [
            "estimated_cache_write_cost_usd",
            "estimated_cached_input_cost_usd",
            "total_cache_hit_calls",
            "total_new_input_tokens",
            "total_cached_input_tokens",
        ],
    }.items():
        existing = _columns(table_name)
        for column_name in column_names:
            if column_name in existing:
                op.drop_column(table_name, column_name)
