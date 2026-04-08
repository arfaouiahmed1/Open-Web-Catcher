"""add tool playground call persistence"""

from __future__ import annotations

from alembic import op

from src.storage.models import Base

revision = "20260407_0003"
down_revision = "20260407_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(Base.metadata.sorted_tables):
        if table.name in {
            "tool_playground_calls",
        }:
            table.drop(bind=bind, checkfirst=True)
