"""CLI entry point for Open Web Catcher."""

from __future__ import annotations

import typer
from rich.console import Console

app = typer.Typer(name="open-web-catcher", help="Extract streaming URLs from illegal streaming sites.")
console = Console()


@app.command()
def run(
    url: str = typer.Argument(..., help="Target URL to process"),
    config: str = typer.Option("configs/settings.yaml", help="Path to settings.yaml"),
    verbose: bool = typer.Option(False, "--verbose", "-v", help="Enable verbose output"),
):
    """Run the full multi-agent pipeline on a URL."""
    from src.utils.config import Settings
    from src.utils.logging import setup_logging
    from src.agents.orchestrator import run_pipeline

    settings = Settings(_env_file=".env")  # type: ignore[call-arg]
    setup_logging(level=settings.log_level, log_file=settings.log_file)

    console.print(f"[bold green]Processing:[/bold green] {url}")
    result = run_pipeline(url=url, settings=settings)
    console.print_json(result.model_dump_json(indent=2))


@app.command()
def serve(
    host: str = typer.Option("0.0.0.0", help="Uvicorn host"),
    port: int = typer.Option(8000, help="Uvicorn port"),
    reload: bool = typer.Option(False, "--reload", help="Enable auto-reload (dev mode)"),
):
    """Launch the FastAPI server via uvicorn."""
    import uvicorn

    uvicorn.run("src.api.app:app", host=host, port=port, reload=reload)


if __name__ == "__main__":
    app()
