"""Add channel metadata fields to takedown emails."""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260515_0014"
down_revision = "20260515_0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("takedown_emails")}
    if "channel_name" not in columns:
        op.add_column(
            "takedown_emails",
            sa.Column("channel_name", sa.String(length=255), nullable=False, server_default=""),
        )
        op.create_index(
            "ix_takedown_emails_channel_name",
            "takedown_emails",
            ["channel_name"],
            unique=False,
        )
    if "rights_owner_reference_url" not in columns:
        op.add_column(
            "takedown_emails",
            sa.Column("rights_owner_reference_url", sa.Text(), nullable=False, server_default=""),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    columns = {column["name"] for column in inspector.get_columns("takedown_emails")}
    indexes = {index["name"] for index in inspector.get_indexes("takedown_emails")}
    if "ix_takedown_emails_channel_name" in indexes:
        op.drop_index("ix_takedown_emails_channel_name", table_name="takedown_emails")
    if "rights_owner_reference_url" in columns:
        op.drop_column("takedown_emails", "rights_owner_reference_url")
    if "channel_name" in columns:
        op.drop_column("takedown_emails", "channel_name")
