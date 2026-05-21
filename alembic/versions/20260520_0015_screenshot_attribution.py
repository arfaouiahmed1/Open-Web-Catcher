"""Add per-agent screenshot attribution fields.

Revision ID: 20260520_0015
Revises: 20260515_0014
Create Date: 2026-05-20 10:00:00
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260520_0015"
down_revision = "20260515_0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("run_screenshots", sa.Column("agent_run_id", sa.Integer(), nullable=True))
    op.add_column("run_screenshots", sa.Column("actor", sa.String(length=128), nullable=False, server_default=""))
    op.add_column("run_screenshots", sa.Column("agent_type", sa.String(length=32), nullable=False, server_default=""))
    op.add_column("run_screenshots", sa.Column("invocation_index", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("run_screenshots", sa.Column("tool_name", sa.String(length=128), nullable=False, server_default=""))
    op.add_column("run_screenshots", sa.Column("target_url", sa.Text(), nullable=False, server_default=""))
    op.add_column("run_screenshots", sa.Column("seq", sa.Integer(), nullable=False, server_default="0"))
    op.create_index("ix_run_screenshots_agent_run_id", "run_screenshots", ["agent_run_id"])
    op.create_index("ix_run_screenshots_actor", "run_screenshots", ["actor"])
    op.create_index("ix_run_screenshots_agent_type", "run_screenshots", ["agent_type"])


def downgrade() -> None:
    op.drop_index("ix_run_screenshots_agent_type", table_name="run_screenshots")
    op.drop_index("ix_run_screenshots_actor", table_name="run_screenshots")
    op.drop_index("ix_run_screenshots_agent_run_id", table_name="run_screenshots")
    op.drop_column("run_screenshots", "seq")
    op.drop_column("run_screenshots", "target_url")
    op.drop_column("run_screenshots", "tool_name")
    op.drop_column("run_screenshots", "invocation_index")
    op.drop_column("run_screenshots", "agent_type")
    op.drop_column("run_screenshots", "actor")
    op.drop_column("run_screenshots", "agent_run_id")
