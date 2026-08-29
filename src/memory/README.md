# src/memory

Owns the two memory tiers: short-term run signals (`short_term.py`) and accumulated per-domain knowledge (`long_term.py`).

Status note: today this module writes to `site_memory.db` (SQLite) and JSON profile stores, which clobber across processes. The target design replaces them with a Redis run store and Postgres `site_hints` plus pgvector tables. That move is planned, not started: see [ADR-002](../../docs/adr/ADR-002-redis-run-state.md) and `.omo/plans/full-audit.md` batch W4.

Update this file when changing storage backends, key/TTL schemes, eviction rules, or the hint write/read path.
