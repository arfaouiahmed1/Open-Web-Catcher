"""Export metrics from the database to CSV for notebook analysis."""

from __future__ import annotations

import csv
from pathlib import Path

import typer

app = typer.Typer()


@app.command()
def main(
    output: str = typer.Option("data/processed/metrics.csv", help="Output CSV path"),
    limit: int = typer.Option(1000, help="Max rows to export"),
):
    from src.storage.database import get_session
    from src.storage.repositories import RunRepository

    session = get_session()
    repo = RunRepository(session)
    records = repo.list_recent(limit=limit)

    out = Path(output)
    out.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = [
        "run_id", "url", "page_type", "status", "streams_found",
        "tokens_in", "tokens_out", "tool_calls", "duration_seconds",
        "success", "failure_mode", "created_at",
    ]
    with open(out, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for r in records:
            writer.writerow({field: getattr(r, field, "") for field in fieldnames})

    typer.echo(f"Exported {len(records)} records to {out}")
    session.close()


if __name__ == "__main__":
    app()
