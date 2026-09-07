"""add WebAuthn passkey credentials and challenges

Revision ID: 20260907_0027
Revises: 20260907_0026
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "20260907_0027"
down_revision = "20260907_0026"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    tables = set(inspector.get_table_names())
    if "webauthn_credentials" not in tables:
        op.create_table(
            "webauthn_credentials",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=False),
            sa.Column("credential_id", sa.String(length=512), nullable=False),
            sa.Column("public_key", sa.Text(), nullable=False),
            sa.Column("sign_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("transports", sa.JSON(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
            sa.PrimaryKeyConstraint("id"),
            sa.UniqueConstraint("credential_id"),
        )
        op.create_index("ix_webauthn_credentials_user_id", "webauthn_credentials", ["user_id"])
        op.create_index(
            "ix_webauthn_credentials_credential_id",
            "webauthn_credentials",
            ["credential_id"],
            unique=True,
        )
    if "webauthn_challenges" not in tables:
        op.create_table(
            "webauthn_challenges",
            sa.Column("id", sa.String(length=64), nullable=False),
            sa.Column("user_id", sa.Integer(), nullable=True),
            sa.Column("email", sa.String(length=255), nullable=False),
            sa.Column("purpose", sa.String(length=32), nullable=False),
            sa.Column("challenge", sa.String(length=128), nullable=False),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("used", sa.Boolean(), nullable=False, server_default=sa.false()),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.PrimaryKeyConstraint("id"),
        )
        op.create_index("ix_webauthn_challenges_user_id", "webauthn_challenges", ["user_id"])
        op.create_index("ix_webauthn_challenges_email", "webauthn_challenges", ["email"])
        op.create_index("ix_webauthn_challenges_purpose", "webauthn_challenges", ["purpose"])
        op.create_index("ix_webauthn_challenges_expires_at", "webauthn_challenges", ["expires_at"])
        op.create_index("ix_webauthn_challenges_used", "webauthn_challenges", ["used"])


def downgrade() -> None:
    op.drop_index("ix_webauthn_challenges_used", table_name="webauthn_challenges")
    op.drop_index("ix_webauthn_challenges_expires_at", table_name="webauthn_challenges")
    op.drop_index("ix_webauthn_challenges_purpose", table_name="webauthn_challenges")
    op.drop_index("ix_webauthn_challenges_email", table_name="webauthn_challenges")
    op.drop_index("ix_webauthn_challenges_user_id", table_name="webauthn_challenges")
    op.drop_table("webauthn_challenges")
    op.drop_index("ix_webauthn_credentials_credential_id", table_name="webauthn_credentials")
    op.drop_index("ix_webauthn_credentials_user_id", table_name="webauthn_credentials")
    op.drop_table("webauthn_credentials")
