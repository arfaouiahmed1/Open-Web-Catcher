"""add users table for API authentication

Revision ID: 20260822_0018
Revises: 20260822_0017
Create Date: 2026-08-22

Auth foundation (plan T3): operator accounts backing JWT login and role
gating. Column set mirrors src.storage.models.UserRecord exactly so the
autogenerate parity diff stays empty after this revision.

Guarded like revisions 0009-0016: early revisions (0003/0004/0005/0006/0011)
bootstrap missing model tables via ``Base.metadata.create_all``, so on fresh
databases the users table may already exist by the time this revision runs.
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision = "20260822_0018"
down_revision = "20260822_0017"
branch_labels = None
depends_on = None


def _users_missing_pieces(inspector: sa.Inspector) -> tuple[bool, bool]:
    tables = set(inspector.get_table_names())
    indexes = (
        {ix["name"] for ix in inspector.get_indexes("users")}
        if "users" in tables
        else set()
    )
    return "users" not in tables, "ix_users_email" not in indexes


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_missing, index_missing = _users_missing_pieces(inspector)

    if table_missing:
        op.create_table(
            "users",
            sa.Column("id", sa.Integer(), nullable=False),
            sa.Column("email", sa.String(length=255), nullable=False),
            sa.Column("password_hash", sa.String(length=255), nullable=False),
            sa.Column("role", sa.String(length=32), nullable=False),
            sa.Column("is_active", sa.Boolean(), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.CheckConstraint(
                "role IN ('admin', 'operator', 'viewer')", name="ck_users_role"
            ),
            sa.PrimaryKeyConstraint("id"),
        )
    if index_missing:
        op.create_index(op.f("ix_users_email"), "users", ["email"], unique=True)


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "users" in set(inspector.get_table_names()):
        if "ix_users_email" in {
            ix["name"] for ix in inspector.get_indexes("users")
        }:
            op.drop_index(op.f("ix_users_email"), table_name="users")
        op.drop_table("users")
