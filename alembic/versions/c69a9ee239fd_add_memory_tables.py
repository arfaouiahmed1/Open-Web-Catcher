"""add memory tables

Revision ID: c69a9ee239fd
Revises: 20260523_0016
Create Date: 2026-05-23 00:00:00

The memory tables this revision is named for are created explicitly by
20260407_0001 (see the ownership note there); the old auto-generated body also
dropped evaluation_* tables absent from current models and re-created existing
indexes, which crashed fresh databases. What remains here is the
run_screenshots -> agent_runs foreign key that 20260520_0015 could not attach
when it added the bare column.

The foreign key is created and dropped through batch mode with an explicit
name so it works on SQLite (which cannot ALTER TABLE ADD/DROP CONSTRAINT) and
on PostgreSQL alike.
"""

from __future__ import annotations

from alembic import op

revision = "c69a9ee239fd"
down_revision = "20260523_0016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("run_screenshots") as batch_op:
        batch_op.create_foreign_key(
            "fk_run_screenshots_agent_run_id_agent_runs",
            "agent_runs",
            ["agent_run_id"],
            ["id"],
            ondelete="SET NULL",
        )


def downgrade() -> None:
    # Drop by explicit name via batch mode (SQLite cannot DROP CONSTRAINT on a
    # FOREIGN KEY outside of table-recreate batch mode).
    with op.batch_alter_table("run_screenshots") as batch_op:
        batch_op.drop_constraint(
            "fk_run_screenshots_agent_run_id_agent_runs", type_="foreignkey"
        )
