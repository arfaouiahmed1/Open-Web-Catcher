"""add TOTP fields to users

Revision ID: 20260907_0026
Revises: 20260907_0025
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "20260907_0026"
down_revision = "20260907_0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("users")}
    if "totp_secret" not in columns:
        op.add_column(
            "users",
            sa.Column("totp_secret", sa.String(length=512), nullable=False, server_default=""),
        )
    if "totp_enabled" not in columns:
        op.add_column(
            "users",
            sa.Column("totp_enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    if "totp_backup_codes" not in columns:
        op.add_column(
            "users",
            sa.Column("totp_backup_codes", sa.Text(), nullable=False, server_default="[]"),
        )


def downgrade() -> None:
    op.drop_column("users", "totp_backup_codes")
    op.drop_column("users", "totp_enabled")
    op.drop_column("users", "totp_secret")
