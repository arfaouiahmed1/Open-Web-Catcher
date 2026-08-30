"""prompt_versions activation index (plan T35)

Revision ID: 20260826_0021
Revises: 20260826_0020
Create Date: 2026-08-26

CHAIN NOTE: chained after the wave-3 UTC-backfill revision
(20260826_0020, authored by a sibling worker) so the branch stays linear.

T35 adds /admin/prompt-versions list/activate-rollback. The PromptVersionRecord
`active` column already exists (ORM default True); what was missing is an index
supporting the two hot queries the rollback endpoint runs: "the active version
for agent X" and "deactivate all other versions of agent X". This revision adds
that composite index, guarded like revisions 0003-0018 because SQLite test
databases are created from ORM metadata and may already carry it.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "20260826_0021"
down_revision = "20260826_0020"
branch_labels = None
depends_on = None

INDEX_NAME = "ix_prompt_versions_agent_active"


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {
        index["name"]
        for index in inspector.get_indexes("prompt_versions")
    }
    if INDEX_NAME not in existing:
        op.create_index(
            INDEX_NAME,
            "prompt_versions",
            ["agent_id", "active"],
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = {
        index["name"]
        for index in inspector.get_indexes("prompt_versions")
    }
    if INDEX_NAME in existing:
        op.drop_index(INDEX_NAME, table_name="prompt_versions")
