"""pgvector long-term site memory (plan task 18, phase 1)

Revision ID: 20260825_0019
Revises: 20260822_0018
Create Date: 2026-08-25

Adds the pgvector-backed relational memory schema:

- ``site_hints`` — one navigation hint per (domain, page_type) with a CLIP
  ViT-B/32 text embedding (``vector(512)``), summary/steps produced at write
  time by ``src.memory.site_hint_writer`` from ``build_site_memory_entry``
  output.
- ``logo_embeddings`` — channel-logo vectors captured from screenshots.

Dialect guards follow the c69a9ee239fd pattern: on PostgreSQL we enable the
``vector`` extension and create ivfflat ANN indexes; on SQLite test runs the
extension DDL and vector-specific indexes are skipped entirely and embeddings
degrade to JSON columns (mirroring ``EmbeddingVector`` in
``src.storage.models``, which compiles to ``vector(512)`` on PostgreSQL).

Guarded like revisions 0003-0018: early revisions bootstrap missing model
tables via ``Base.metadata.create_all``, so on fresh databases these tables
may already exist by the time this revision runs.

Column set mirrors the SQLAlchemy models exactly so the autogenerate parity
diff stays empty after this revision.
"""

from __future__ import annotations

import logging

import sqlalchemy as sa

from alembic import op
from src.storage.models import EMBEDDING_DIMENSIONS, SITE_HINT_PAGE_TYPES

logger = logging.getLogger(__name__)

revision = "20260825_0019"
down_revision = "20260822_0018"
branch_labels = None
depends_on = None


def _embedding_type(is_postgres: bool):  # type: ignore[no-untyped-def]
    """vector(512) on PostgreSQL; JSON fallback elsewhere (SQLite tests)."""
    if not is_postgres:
        return sa.JSON()
    try:
        from pgvector.sqlalchemy import Vector
    except ImportError:
        logger.warning(
            "pgvector package missing; site_hints.embedding falls back to JSON. "
            "Run `uv sync` to install the dependency added in pyproject.toml."
        )
        return sa.JSON()
    return Vector(EMBEDDING_DIMENSIONS)


def _create_ivfflat_indexes() -> None:
    """Cosine (<=>) ivfflat indexes; requires the vector extension."""
    op.create_index(
        "ix_site_hints_embedding_ivfflat",
        "site_hints",
        ["embedding"],
        postgresql_using="ivfflat",
        postgresql_ops={"embedding": "vector_cosine_ops"},
        postgresql_with={"lists": 100},
    )
    op.create_index(
        "ix_logo_embeddings_embedding_ivfflat",
        "logo_embeddings",
        ["embedding"],
        postgresql_using="ivfflat",
        postgresql_ops={"embedding": "vector_cosine_ops"},
        postgresql_with={"lists": 100},
    )


def upgrade() -> None:
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"

    if is_postgres:
        # Guarded like every extension-touching revision: SQLite has no
        # extensions, and an existing Postgres database may already have it.
        op.execute("CREATE EXTENSION IF NOT EXISTS vector")

    embedding = _embedding_type(is_postgres)
    page_type_enum = sa.Enum(
        *SITE_HINT_PAGE_TYPES,
        name="site_hint_page_type",
        native_enum=False,
        length=32,
    )

    tables = set(sa.inspect(bind).get_table_names())

    if "site_hints" not in tables:
        op.create_table(
            "site_hints",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("domain", sa.String(length=255), nullable=False),
            sa.Column(
                "page_type",
                page_type_enum,
                nullable=False,
                server_default="unknown",
            ),
            sa.Column("summary_text", sa.Text(), nullable=False, server_default=""),
            sa.Column("navigation_steps", sa.JSON(), nullable=False),
            sa.Column("selectors", sa.JSON(), nullable=False),
            sa.Column("success_rate", sa.Float(), nullable=False, server_default="0"),
            sa.Column("ttl_expires_at", sa.DateTime(), nullable=True),
            sa.Column("embedding", embedding, nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
            sa.UniqueConstraint("domain", "page_type", name="uq_site_hints_domain_page_type"),
            sa.CheckConstraint(
                "success_rate >= 0 AND success_rate <= 1",
                name="ck_site_hints_success_rate",
            ),
        )
        op.create_index(op.f("ix_site_hints_domain"), "site_hints", ["domain"])
        op.create_index(
            "ix_site_hints_domain_page_type",
            "site_hints",
            ["domain", "page_type"],
        )
        op.create_index(
            op.f("ix_site_hints_created_at"),
            "site_hints",
            ["created_at"],
        )

    if "logo_embeddings" not in tables:
        op.create_table(
            "logo_embeddings",
            sa.Column("id", sa.Integer(), primary_key=True),
            sa.Column("channel_label", sa.String(length=255), nullable=False),
            sa.Column("embedding", embedding, nullable=False),
            sa.Column("source_screenshot_id", sa.Integer(), nullable=True),
            sa.ForeignKeyConstraint(
                ["source_screenshot_id"],
                ["run_screenshots.id"],
                ondelete="SET NULL",
                name="fk_logo_embeddings_source_screenshot_id_run_screenshots",
            ),
            sa.Column(
                "created_at",
                sa.DateTime(),
                nullable=False,
                server_default=sa.func.now(),
            ),
        )
        op.create_index(
            op.f("ix_logo_embeddings_channel_label"),
            "logo_embeddings",
            ["channel_label"],
        )
        op.create_index(
            op.f("ix_logo_embeddings_source_screenshot_id"),
            "logo_embeddings",
            ["source_screenshot_id"],
        )

    if is_postgres:
        try:
            _create_ivfflat_indexes()
        except Exception:  # noqa: BLE001 - index is an optimization, not correctness
            logger.exception("ivfflat index creation failed; seq-scan cosine still works")


def downgrade() -> None:
    bind = op.get_bind()
    is_postgres = bind.dialect.name == "postgresql"

    if is_postgres:
        for table_name, index_name in (
            ("site_hints", "ix_site_hints_embedding_ivfflat"),
            ("logo_embeddings", "ix_logo_embeddings_embedding_ivfflat"),
        ):
            try:
                op.drop_index(index_name, table_name=table_name)
            except Exception:  # noqa: BLE001 - absent index must not block teardown
                logger.info("index %s not present; skipping drop", index_name)

    op.drop_table("logo_embeddings")
    op.drop_table("site_hints")
