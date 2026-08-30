#!/usr/bin/env python3
"""Export the backend OpenAPI schema to a committed JSON file (plan task 38).

The generated ``openapi.json`` is committed at the repository root so that
``web`` type codegen (``npm run types:gen``) and CI never need a live backend.

Usage:
    python scripts/export_openapi.py                 # writes ./openapi.json
    OPENAPI_EXPORT_OUT=path/to/out.json python ...   # custom destination

The output is byte-deterministic for a given backend version: keys are sorted,
unicode is escaped, and the file ends with exactly one trailing newline.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

DEFAULT_OUT = REPO_ROOT / "openapi.json"


def build_schema() -> dict:
    # Imported lazily so --help stays cheap and so the docstring above does not
    # pay the app-import cost.
    from src.api.app import app

    return app.openapi()


def render_schema(schema: dict) -> bytes:
    text = json.dumps(schema, indent=2, sort_keys=True, ensure_ascii=True)
    return (text + "\n").encode("utf-8")


def main() -> int:
    out_path = Path(
        os.environ.get("OPENAPI_EXPORT_OUT") or DEFAULT_OUT
    )
    if not out_path.is_absolute():
        out_path = Path.cwd() / out_path

    schema = build_schema()
    payload = render_schema(schema)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    previous = out_path.read_bytes() if out_path.exists() else None
    if previous != payload:
        out_path.write_bytes(payload)

    route_count = sum(
        len(methods) for methods in schema.get("paths", {}).values()
    )
    print(f"[export-openapi] routes: {route_count}")
    print(f"[export-openapi] wrote {out_path} ({len(payload)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
