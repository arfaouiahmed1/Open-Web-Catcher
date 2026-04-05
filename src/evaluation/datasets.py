"""Test dataset loader and golden test cases."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


DEFAULT_CASES_PATH = Path("data/test_cases/sites.json")


def load_test_cases(path: str | Path = DEFAULT_CASES_PATH) -> list[dict[str, Any]]:
    """Load golden test cases from a JSON file.

    Expected format:
        [
          {
            "url": "https://example.com/movie/123",
            "expected_type": "landing_page",
            "expected_streams": [],
            "notes": "..."
          },
          ...
        ]
    """
    p = Path(path)
    if not p.exists():
        return []
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def save_test_cases(cases: list[dict[str, Any]], path: str | Path = DEFAULT_CASES_PATH) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(cases, f, indent=2, ensure_ascii=False)
