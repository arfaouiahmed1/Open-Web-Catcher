"""add operator console pricing and evaluation tables"""

from __future__ import annotations

from alembic import op

from src.storage.models import Base

revision = "20260407_0002"
down_revision = "20260407_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    Base.metadata.create_all(bind=bind)


def downgrade() -> None:
    bind = op.get_bind()
    for table in reversed(Base.metadata.sorted_tables):
        if table.name in {
            "pricing_configs",
            "evaluation_suites",
            "evaluation_cases",
            "evaluation_runs",
            "evaluation_case_results",
        }:
            table.drop(bind=bind, checkfirst=True)
