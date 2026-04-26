"""add dataset operator console tables"""

from __future__ import annotations

from alembic import op

from src.storage.models import Base

revision = "20260426_0006"
down_revision = "20260416_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(Base.metadata.sorted_tables):
        if table.name in {
            "dataset_site_runs",
            "dataset_batches",
            "dataset_sites",
        }:
            table.drop(bind=bind, checkfirst=True)
