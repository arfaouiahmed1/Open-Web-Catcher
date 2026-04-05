"""Long-term memory: cross-run SQLite-backed pattern storage."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
import sqlite3
from typing import Any


class LongTermMemory:
    """Stores and retrieves site patterns across pipeline runs.

    Schema:
        patterns(domain TEXT, pattern_type TEXT, data JSON, created_at TEXT)
    """

    def __init__(self, db_path: str = "data/open_web_catcher.db") -> None:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._bootstrap()

    def _bootstrap(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS patterns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT NOT NULL,
                pattern_type TEXT NOT NULL,
                data TEXT NOT NULL,
                created_at TEXT NOT NULL
            )
            """
        )
        self._conn.commit()

    def save_pattern(self, domain: str, pattern_type: str, data: dict[str, Any]) -> None:
        self._conn.execute(
            "INSERT INTO patterns (domain, pattern_type, data, created_at) VALUES (?, ?, ?, ?)",
            (domain, pattern_type, json.dumps(data), datetime.utcnow().isoformat()),
        )
        self._conn.commit()

    def get_patterns(self, domain: str, pattern_type: str | None = None) -> list[dict[str, Any]]:
        if pattern_type:
            rows = self._conn.execute(
                "SELECT data FROM patterns WHERE domain=? AND pattern_type=? ORDER BY created_at DESC",
                (domain, pattern_type),
            ).fetchall()
        else:
            rows = self._conn.execute(
                "SELECT data FROM patterns WHERE domain=? ORDER BY created_at DESC",
                (domain,),
            ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def close(self) -> None:
        self._conn.close()
