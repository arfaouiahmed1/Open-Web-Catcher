#!/usr/bin/env python3
"""OpenAPI response-schema coverage gate (plan task 13, slice 1).

Walks ``app.openapi()`` and reports every (method, route) whose 2xx responses
carry no schema. FastAPI only emits response schemas for routes that declare a
``response_model`` or a return-type annotation, so uncovered rows mark the
annotation work still owed.

Exit code: 0 when coverage >= 95%, 1 otherwise (report-only until the gate is
switched on after the annotation waves).
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from fastapi.routing import APIRoute  # noqa: E402

from src.api.app import app  # noqa: E402

THRESHOLD_PCT = 95.0

# No-schema-by-design routes: health probe, gated docs endpoints.
EXEMPT_EXACT: frozenset[str] = frozenset({"/health", "/openapi.json", "/docs", "/redoc"})
# Auth endpoints are contract-exempt per plan task 13.
EXEMPT_PREFIXES: tuple[str, ...] = ("/api/auth/",)
# Handlers returning StreamingResponse/SSE emit no JSON schema by design.
# Built from grep 'text/event-stream' src/api -> app.py:2974 (/ui/runs/{run_id}/stream)
# and datasets.py:450 (/api/datasets + /stream prefix).
SSE_ROUTES: frozenset[str] = frozenset({"/ui/runs/{run_id}/stream", "/api/datasets/stream"})

HTTP_METHODS: frozenset[str] = frozenset(
    {"get", "post", "put", "patch", "delete", "head", "options"}
)


@dataclass(frozen=True, slots=True)
class RouteRow:
    """One OpenAPI operation with its schema-coverage verdict."""

    method: str
    path: str
    handler: str
    covered: bool
    exempt: bool


def _handler_names() -> dict[tuple[str, str], str]:
    """Map (METHOD, path template) from the live route table to endpoint names."""
    names: dict[tuple[str, str], str] = {}
    for route in app.routes:
        if isinstance(route, APIRoute):
            for method in route.methods:
                names[(method.upper(), route.path)] = route.endpoint.__name__
    return names


def _has_response_schema(operation: dict[str, Any]) -> bool:
    """True when any 2xx response carries a schema ($ref or inline)."""
    for status, response in operation.get("responses", {}).items():
        if not str(status).startswith("2"):
            continue
        if "$ref" in response:
            return True
        content = response.get("content") or {}
        for media in content.values():
            if isinstance(media, dict) and "schema" in media:
                return True
    return False


def measure() -> tuple[list[RouteRow], float]:
    """Return every operation row plus eligible-route coverage percentage."""
    handlers = _handler_names()
    spec = app.openapi()
    rows: list[RouteRow] = []
    for path, operations in spec.get("paths", {}).items():
        for method, operation in operations.items():
            if method.lower() not in HTTP_METHODS:
                continue
            exempt = (
                path in EXEMPT_EXACT
                or path.startswith(EXEMPT_PREFIXES)
                or path in SSE_ROUTES
            )
            handler = handlers.get((method.upper(), path), "<unknown>")
            covered = _has_response_schema(operation)
            rows.append(RouteRow(method=method.upper(), path=path, handler=handler, covered=covered, exempt=exempt))
    eligible = [row for row in rows if not row.exempt]
    covered_count = sum(1 for row in eligible if row.covered)
    pct = (covered_count / len(eligible) * 100.0) if eligible else 100.0
    return rows, pct


def render_report(rows: list[RouteRow], pct: float) -> str:
    """Human-readable table of uncovered routes plus the summary line."""
    uncovered = sorted(
        (row for row in rows if not row.exempt and not row.covered),
        key=lambda row: (row.path, row.method),
    )
    lines = ["UNCOVERED ROUTES (no 2xx response schema)", ""]
    if uncovered:
        width_path = max(len(row.path) for row in uncovered)
        lines.append(f"{'METHOD':<7} {'PATH':<{width_path}} HANDLER")
        for row in uncovered:
            lines.append(f"{row.method:<7} {row.path:<{width_path}} {row.handler}")
    else:
        lines.append("(none)")
    exempt_count = sum(1 for row in rows if row.exempt)
    eligible_count = len(rows) - exempt_count
    lines.append("")
    lines.append(
        f"Coverage: {pct:.1f}% of {eligible_count} eligible routes "
        f"({exempt_count} exempt) | threshold: {THRESHOLD_PCT:.0f}%"
    )
    return "\n".join(lines)


def main() -> int:
    rows, pct = measure()
    print(render_report(rows, pct))
    return 0 if pct >= THRESHOLD_PCT else 1


if __name__ == "__main__":
    raise SystemExit(main())
