"""operator console pricing and dataset tables

Explicit DDL for the operator-console table families. This revision replaces
the old decorative ``Base.metadata.create_all`` body. The evaluation tables it
used to create were removed from ``src/storage/models.py`` and are gone for
good; legacy databases that still carry them are handled by the stamp
procedure in docs/operations/migration-safety.md.

Revision ID: 20260407_0002
Revises: 20260407_0001
Create Date: 2026-04-07 00:00:00

Ownership notes:
- pricing_configs is created with full current metadata; the guarded revision
  20260503_0010 re-checks its columns and skips them when already present.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "20260407_0002"
down_revision = "20260407_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "pricing_configs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=False),
        sa.Column("model_name", sa.String(length=128), nullable=False),
        sa.Column("input_per_million", sa.Float(), nullable=False),
        sa.Column("output_per_million", sa.Float(), nullable=False),
        sa.Column("cached_input_per_million", sa.Float(), nullable=False),
        sa.Column("cache_write_per_million", sa.Float(), nullable=False),
        sa.Column("context_window", sa.Integer(), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("provider", "model_name", name="uq_pricing_configs_provider_model"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_pricing_configs_provider"), "pricing_configs", ["provider"], unique=False)
    op.create_index(op.f("ix_pricing_configs_model_name"), "pricing_configs", ["model_name"], unique=False)
    op.create_index(op.f("ix_pricing_configs_active"), "pricing_configs", ["active"], unique=False)

    op.create_table(
        "dataset_sites",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("canonical_url", sa.String(length=1024), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("language", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=32), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("total_runs", sa.Integer(), nullable=False),
        sa.Column("successful_runs", sa.Integer(), nullable=False),
        sa.Column("failed_runs", sa.Integer(), nullable=False),
        sa.Column("last_tested_at", sa.DateTime(), nullable=True),
        sa.Column("last_success_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_dataset_sites_canonical_url"), "dataset_sites", ["canonical_url"], unique=True)
    op.create_index(op.f("ix_dataset_sites_source"), "dataset_sites", ["source"], unique=False)
    op.create_index(op.f("ix_dataset_sites_language"), "dataset_sites", ["language"], unique=False)
    op.create_index(op.f("ix_dataset_sites_label"), "dataset_sites", ["label"], unique=False)
    op.create_index(op.f("ix_dataset_sites_last_tested_at"), "dataset_sites", ["last_tested_at"], unique=False)
    op.create_index(op.f("ix_dataset_sites_created_at"), "dataset_sites", ["created_at"], unique=False)

    op.create_table(
        "dataset_batches",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("batch_id", sa.String(length=64), nullable=False),
        sa.Column("batch_name", sa.String(length=128), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("source", sa.String(length=32), nullable=False),
        sa.Column("language_filter", sa.String(length=32), nullable=False),
        sa.Column("label_filter", sa.String(length=32), nullable=False),
        sa.Column("requested_count", sa.Integer(), nullable=False),
        sa.Column("completed_count", sa.Integer(), nullable=False),
        sa.Column("passed_count", sa.Integer(), nullable=False),
        sa.Column("failed_count", sa.Integer(), nullable=False),
        sa.Column("cancelled_count", sa.Integer(), nullable=False),
        sa.Column("urls_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_dataset_batches_batch_id"), "dataset_batches", ["batch_id"], unique=True)
    op.create_index(op.f("ix_dataset_batches_batch_name"), "dataset_batches", ["batch_name"], unique=False)
    op.create_index(op.f("ix_dataset_batches_status"), "dataset_batches", ["status"], unique=False)
    op.create_index(op.f("ix_dataset_batches_source"), "dataset_batches", ["source"], unique=False)
    op.create_index(op.f("ix_dataset_batches_language_filter"), "dataset_batches", ["language_filter"], unique=False)
    op.create_index(op.f("ix_dataset_batches_label_filter"), "dataset_batches", ["label_filter"], unique=False)
    op.create_index(op.f("ix_dataset_batches_created_at"), "dataset_batches", ["created_at"], unique=False)

    op.create_table(
        "dataset_site_runs",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("batch_id", sa.Integer(), nullable=False),
        sa.Column("site_id", sa.Integer(), nullable=True),
        sa.Column("run_id", sa.String(length=64), nullable=False),
        sa.Column("url", sa.Text(), nullable=False),
        sa.Column("language", sa.String(length=32), nullable=False),
        sa.Column("label", sa.String(length=32), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False),
        sa.Column("final_status", sa.String(length=32), nullable=False),
        sa.Column("stream_count", sa.Integer(), nullable=False),
        sa.Column("total_cost_usd", sa.Float(), nullable=False),
        sa.Column("error_text", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("started_at", sa.DateTime(), nullable=True),
        sa.Column("finished_at", sa.DateTime(), nullable=True),
        sa.ForeignKeyConstraint(
            ["batch_id"],
            ["dataset_batches.id"],
            name="fk_dataset_site_runs_batch_id_dataset_batches",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["site_id"],
            ["dataset_sites.id"],
            name="fk_dataset_site_runs_site_id_dataset_sites",
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_dataset_site_runs_batch_id"), "dataset_site_runs", ["batch_id"], unique=False)
    op.create_index(op.f("ix_dataset_site_runs_site_id"), "dataset_site_runs", ["site_id"], unique=False)
    op.create_index(op.f("ix_dataset_site_runs_run_id"), "dataset_site_runs", ["run_id"], unique=True)
    op.create_index(op.f("ix_dataset_site_runs_language"), "dataset_site_runs", ["language"], unique=False)
    op.create_index(op.f("ix_dataset_site_runs_label"), "dataset_site_runs", ["label"], unique=False)
    op.create_index(op.f("ix_dataset_site_runs_status"), "dataset_site_runs", ["status"], unique=False)
    op.create_index(op.f("ix_dataset_site_runs_final_status"), "dataset_site_runs", ["final_status"], unique=False)
    op.create_index(op.f("ix_dataset_site_runs_created_at"), "dataset_site_runs", ["created_at"], unique=False)


def downgrade() -> None:
    # Reverse dependency order; dropping a table drops its indexes with it.
    op.drop_table("dataset_site_runs")
    op.drop_table("dataset_batches")
    op.drop_table("dataset_sites")
    op.drop_table("pricing_configs")
