"""seed initial dataset sites data"""

from __future__ import annotations

from datetime import datetime

from alembic import op
from sqlalchemy import text

revision = "20260426_0007"
down_revision = "20260426_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    connection = op.get_bind()

    # Check if seed data already exists
    existing = connection.execute(
        text("SELECT COUNT(*) as count FROM dataset_sites WHERE source = 'csv_seed'")
    ).fetchone()

    if existing and existing[0] > 0:
        # Data already seeded, skip
        return

    # Seed initial dataset sites
    seed_data = [
        ("https://example.com", "https://example.com", "english", "Example", "Initial seed site", "csv_seed"),
        ("https://techcrunch.com", "https://techcrunch.com", "english", "TechCrunch", "Technology news", "csv_seed"),
        ("https://github.com", "https://github.com", "english", "GitHub", "Code hosting platform", "csv_seed"),
        ("https://stackoverflow.com", "https://stackoverflow.com", "english", "Stack Overflow", "Programming Q&A", "csv_seed"),
        ("https://wikipedia.org", "https://wikipedia.org", "english", "Wikipedia", "Encyclopedia", "csv_seed"),
    ]

    now = datetime.utcnow()

    for canonical_url, url, language, label, notes, source in seed_data:
        # Use INSERT ... ON CONFLICT to make idempotent
        connection.execute(
            text("""
                INSERT INTO dataset_sites (canonical_url, url, language, label, notes, source, total_runs, successful_runs, failed_runs, created_at, updated_at)
                VALUES (:canonical_url, :url, :language, :label, :notes, :source, 0, 0, 0, :now, :now)
                ON CONFLICT (canonical_url) DO UPDATE SET
                    updated_at = :now
                WHERE dataset_sites.source = :source
            """),
            {
                "canonical_url": canonical_url,
                "url": url,
                "language": language,
                "label": label,
                "notes": notes,
                "source": source,
                "now": now,
            }
        )

    connection.commit()


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(
        text("DELETE FROM dataset_sites WHERE source = 'csv_seed'")
    )
    connection.commit()
