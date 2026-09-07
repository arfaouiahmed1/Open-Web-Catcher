"""add password-reset columns to users

Revision ID: 20260907_0024
Revises: 20260826_0023

Backs the POST /api/auth/password-reset/{request,confirm} endpoints with
single-use hashed tokens plus expiry. Guarded add_column checks keep the
revision idempotent on databases where the table was bootstrapped via
Base.metadata.create_all.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "20260907_0024"
down_revision = "20260826_0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("users")}
    if "password_reset_token_hash" not in columns:
        op.add_column(
            "users",
            sa.Column("password_reset_token_hash", sa.String(length=128), nullable=False, server_default=""),
        )
    if "password_reset_expires_at" not in columns:
        op.add_column(
            "users",
            sa.Column("password_reset_expires_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("users", "password_reset_expires_at")
    op.drop_column("users", "password_reset_token_hash")
