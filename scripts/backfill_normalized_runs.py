"""Backfill normalized Postgres-style tables from legacy run snapshots.

[DM-C1]: backfill_normalized_from_legacy commits PER RECORD and logs progress
every N records, so the final count printed here is backed by durable rows
instead of a transaction that session.close() would roll back.
"""

from __future__ import annotations

import logging

from src.storage.database import create_tables, get_session
from src.storage.repositories import RunRepository


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    create_tables()
    session = get_session()
    try:
        count = RunRepository(session).backfill_normalized_from_legacy()
        print(f"Backfilled {count} run(s).")
    finally:
        session.close()


if __name__ == "__main__":
    main()
