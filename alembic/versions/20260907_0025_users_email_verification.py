"""add email-verification columns to users

Revision ID: 20260907_0025
Revises: 20260907_0024

Backs POST /api/auth/email/{verify-request,verify-confirm} and
GET /api/auth/email/status with a verified flag plus single-use hashed
tokens. Guarded add_column checks keep the revision idempotent.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "20260907_0025"
down_revision = "20260907_0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {col["name"] for col in inspector.get_columns("users")}
    if "email_verified" not in columns:
        op.add_column(
            "users",
            sa.Column("email_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    if "email_verification_token_hash" not in columns:
        op.add_column(
            "users",
            sa.Column("email_verification_token_hash", sa.String(length=128), nullable=False, server_default=""),
        )
    if "email_verification_expires_at" not in columns:
        op.add_column(
            "users",
            sa.Column("email_verification_expires_at", sa.DateTime(timezone=True), nullable=True),
        )


def downgrade() -> None:
    op.drop_column("users", "email_verification_expires_at")
    op.drop_column("users", "email_verification_token_hash")
    op.drop_column("users", "email_verified")
