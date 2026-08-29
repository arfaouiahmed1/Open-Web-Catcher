# src/storage

Owns persistence: SQLAlchemy models (`models.py`), repositories as the single write path (`repositories.py`, `dataset_repository.py`), UI read models (`ui_repository.py`), and session/migration bootstrap (`database.py`).

Status note: writes must go through repositories only; the silent `create_all` fallback is gone and Alembic is the migration path. pgvector tables for long-term memory are planned, not present: see [ADR-002](../../docs/adr/ADR-002-redis-run-state.md) and `.omo/plans/full-audit.md` batch W4.

Update this file when changing tables or columns (with an Alembic migration), repository transactions, or read-model payloads.
