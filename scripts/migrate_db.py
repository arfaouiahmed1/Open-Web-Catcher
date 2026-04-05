"""Database migration script — creates/upgrades tables."""

from __future__ import annotations

import typer

app = typer.Typer()


@app.command()
def main():
    from src.storage.database import create_tables
    create_tables()
    typer.echo("Database tables created/verified.")


if __name__ == "__main__":
    app()
