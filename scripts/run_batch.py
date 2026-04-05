"""Batch process a list of URLs from a JSON file."""

from __future__ import annotations

import json
from pathlib import Path

import typer

app = typer.Typer()


@app.command()
def main(
    input: str = typer.Option("data/test_cases/sites.json", help="Input JSON file with URLs"),
    output: str = typer.Option("data/raw/", help="Output directory for results"),
    limit: int = typer.Option(0, help="Max URLs to process (0 = all)"),
):
    from src.agents.orchestrator import run_pipeline
    from src.utils.config import Settings

    settings = Settings.from_yaml()
    cases = json.loads(Path(input).read_text())
    if limit:
        cases = cases[:limit]

    out_dir = Path(output)
    out_dir.mkdir(parents=True, exist_ok=True)

    for i, case in enumerate(cases, 1):
        url = case if isinstance(case, str) else case["url"]
        typer.echo(f"[{i}/{len(cases)}] Processing: {url}")
        try:
            result = run_pipeline(url=url, settings=settings)
            out_file = out_dir / f"{result.run_id}.json"
            out_file.write_text(result.model_dump_json(indent=2))
            typer.echo(f"  → {result.final_status} | streams: {len(result.streams)}")
        except Exception as e:
            typer.echo(f"  → ERROR: {e}", err=True)


if __name__ == "__main__":
    app()
