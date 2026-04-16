"""add durable background jobs table"""

from __future__ import annotations

from alembic import op

from src.storage.models import Base

revision = "20260416_0005"
down_revision = "20260407_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(Base.metadata.sorted_tables):
        if table.name in {
            "background_jobs",
        }:
            table.drop(bind=bind, checkfirst=True)
