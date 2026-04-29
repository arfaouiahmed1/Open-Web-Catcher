"""import sites from datasets/sites.csv replacing placeholder seed data"""

from __future__ import annotations

import csv
from datetime import datetime
from pathlib import Path

from alembic import op
from sqlalchemy import text

revision = "20260426_0008"
down_revision = "20260426_0007"
branch_labels = None
depends_on = None

CSV_PATH = Path("datasets/sites.csv")


def upgrade() -> None:
    connection = op.get_bind()

    # Remove placeholder seed data
    connection.execute(text("DELETE FROM dataset_sites WHERE source = 'csv_seed'"))

    if not CSV_PATH.exists():
        return

    now = datetime.utcnow()
    rows = []
    with CSV_PATH.open(encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            url = (row.get("url") or "").strip()
            if not url:
                continue
            rows.append({
                "canonical_url": url,
                "url": url,
                "language": (row.get("language") or "").strip().lower() or "",
                "label": (row.get("label") or "").strip().lower() or "",
                "notes": (row.get("notes") or "").strip() or "",
                "source": "csv_import",
                "now": now,
            })

    for params in rows:
        connection.execute(
            text("""
                INSERT INTO dataset_sites
                    (canonical_url, url, language, label, notes, source,
                     total_runs, successful_runs, failed_runs, created_at, updated_at)
                VALUES
                    (:canonical_url, :url, :language, :label, :notes, :source,
                     0, 0, 0, :now, :now)
                ON CONFLICT (canonical_url) DO UPDATE SET
                    language = COALESCE(EXCLUDED.language, dataset_sites.language),
                    label    = COALESCE(EXCLUDED.label,    dataset_sites.label),
                    notes    = COALESCE(EXCLUDED.notes,    dataset_sites.notes),
                    source   = EXCLUDED.source,
                    updated_at = EXCLUDED.updated_at
            """),
            params,
        )

    connection.commit()


def downgrade() -> None:
    connection = op.get_bind()
    connection.execute(text("DELETE FROM dataset_sites WHERE source = 'csv_import'"))
    connection.commit()
