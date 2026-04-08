"""add provider lookup check persistence"""

from __future__ import annotations

from alembic import op

from src.storage.models import Base

revision = "20260407_0004"
down_revision = "20260407_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(Base.metadata.sorted_tables):
        if table.name in {
            "provider_lookup_checks",
        }:
            table.drop(bind=bind, checkfirst=True)
