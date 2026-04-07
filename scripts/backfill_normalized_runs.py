"""Backfill normalized Postgres-style tables from legacy run snapshots."""

from __future__ import annotations

from src.storage.database import create_tables, get_session
from src.storage.repositories import RunRepository


def main() -> None:
    create_tables()
    session = get_session()
    try:
        count = RunRepository(session).backfill_normalized_from_legacy()
        print(f"Backfilled {count} run(s).")
    finally:
        session.close()


if __name__ == "__main__":
    main()
