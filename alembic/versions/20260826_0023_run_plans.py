"""run_plans + plan_steps (plan task 27)

Revision ID: 20260826_0023
Revises: 20260826_0022
Create Date: 2026-08-26

T27 adds the RunPlan artifact: ``run_plans`` stores the declarative plan
document emitted at run start ({strategy, steps: [{id, title, criteria,
budget}]}) and ``plan_steps`` carries live per-step status that the SSE
/ui/runs/{id}/stream endpoint mirrors as plan_step_update events. Table
creation is guarded like revisions 0003-0018 because SQLite test databases
are created from ORM metadata and may already carry both tables.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "20260826_0023"
down_revision = "20260826_0022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if "run_plans" not in existing_tables:
        op.create_table(
            "run_plans",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "run_id",
                sa.String(length=64),
                sa.ForeignKey("runs.run_id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("strategy", sa.String(length=64), nullable=False, server_default=""),
            sa.Column("plan", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        )
        op.create_index("ix_run_plans_run_id", "run_plans", ["run_id"], unique=True)
        op.create_index("ix_run_plans_created_at", "run_plans", ["created_at"])

    if "plan_steps" not in existing_tables:
        op.create_table(
            "plan_steps",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column(
                "run_id",
                sa.String(length=64),
                sa.ForeignKey("runs.run_id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("step_id", sa.String(length=64), nullable=False),
            sa.Column("position", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("title", sa.Text(), nullable=False),
            sa.Column("criteria", sa.Text(), nullable=False),
            sa.Column("budget", sa.JSON(), nullable=True),
            sa.Column("status", sa.String(length=32), nullable=False, server_default="pending"),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("run_id", "step_id", name="uq_plan_steps_run_step"),
        )
        op.create_index("ix_plan_steps_run_id", "plan_steps", ["run_id"])
        op.create_index("ix_plan_steps_status", "plan_steps", ["status"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing_tables = set(inspector.get_table_names())

    if "plan_steps" in existing_tables:
        existing_indexes = {index["name"] for index in inspector.get_indexes("plan_steps")}
        for index_name in ("ix_plan_steps_status", "ix_plan_steps_run_id"):
            if index_name in existing_indexes:
                op.drop_index(index_name, table_name="plan_steps")
        op.drop_table("plan_steps")

    if "run_plans" in existing_tables:
        existing_indexes = {index["name"] for index in inspector.get_indexes("run_plans")}
        for index_name in ("ix_run_plans_created_at", "ix_run_plans_run_id"):
            if index_name in existing_indexes:
                op.drop_index(index_name, table_name="run_plans")
        op.drop_table("run_plans")
