"""Extract JS code blocks from n8n workflow JSON files."""

from __future__ import annotations

import json
from pathlib import Path

import typer

app = typer.Typer()


@app.command()
def main(
    workflow: str = typer.Argument(..., help="Path to n8n workflow JSON file"),
    output_dir: str = typer.Option("tools_js/extracted/", help="Directory to write extracted JS files"),
):
    wf = json.loads(Path(workflow).read_text(encoding="utf-8"))
    nodes = wf.get("nodes", [])

    out = Path(output_dir)
    out.mkdir(parents=True, exist_ok=True)

    extracted = 0
    for node in nodes:
        node_type = node.get("type", "")
        params = node.get("parameters", {})

        # Code nodes
        js_code = params.get("jsCode") or params.get("code") or params.get("functionCode") or ""
        if js_code and node_type in ("n8n-nodes-base.code", "n8n-nodes-base.function"):
            name = node.get("name", f"node_{node['id']}").replace(" ", "_").lower()
            out_file = out / f"{name}.js"
            out_file.write_text(js_code, encoding="utf-8")
            typer.echo(f"Extracted: {out_file}")
            extracted += 1

    typer.echo(f"\nDone — {extracted} JS code blocks extracted to {out}/")


if __name__ == "__main__":
    app()
