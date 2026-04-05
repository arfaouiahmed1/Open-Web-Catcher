"""Tracing setup helpers for Phoenix with an optional LangSmith fallback."""

from __future__ import annotations

import os

from src.utils.config import Settings
from src.utils.phoenix import (
    resolve_phoenix_api_key,
    resolve_phoenix_collector_endpoint,
    resolve_phoenix_project_name,
    resolve_phoenix_tracing,
)
from src.utils.langsmith import (
    resolve_langsmith_api_key,
    resolve_langsmith_endpoint,
    resolve_langsmith_project,
    resolve_langsmith_tracing,
)
from src.utils.logging import get_logger

logger = get_logger(__name__)
_phoenix_registered = False


def setup_phoenix_tracing(
    project: str = "open-web-catcher",
    api_key: str = "",
    enabled: bool = False,
    endpoint: str = "http://localhost:6006",
) -> None:
    """Configure Phoenix tracing and auto-instrument supported libraries."""
    global _phoenix_registered

    os.environ["PHOENIX_PROJECT_NAME"] = project
    os.environ["PHOENIX_COLLECTOR_ENDPOINT"] = endpoint
    if api_key:
        os.environ["PHOENIX_API_KEY"] = api_key

    if not enabled:
        logger.debug("Phoenix tracing disabled")
        return

    try:
        from phoenix.otel import register
    except Exception as exc:  # pragma: no cover - import guard
        logger.warning("Phoenix tracing requested but dependencies are unavailable: %s", exc)
        return

    if _phoenix_registered:
        logger.debug("Phoenix tracing already registered")
        return

    register(project_name=project, auto_instrument=True, batch=False)
    _phoenix_registered = True
    logger.info("Phoenix tracing enabled for project '%s' -> %s", project, endpoint)


def setup_tracing(
    project: str = "open-web-catcher",
    api_key: str = "",
    enabled: bool = False,
    endpoint: str = "https://api.smith.langchain.com",
) -> None:
    """Configure LangSmith tracing environment variables.

    Sets both the modern `LANGSMITH_*` variables and the older `LANGCHAIN_*`
    aliases used by parts of the LangChain ecosystem.
    """
    tracing_value = "true" if enabled else "false"
    os.environ["LANGSMITH_TRACING"] = tracing_value
    os.environ["LANGCHAIN_TRACING_V2"] = tracing_value
    os.environ["LANGSMITH_PROJECT"] = project
    os.environ["LANGCHAIN_PROJECT"] = project
    os.environ["LANGSMITH_ENDPOINT"] = endpoint

    if not enabled:
        logger.debug("LangSmith tracing disabled")
        return

    if not api_key:
        logger.warning("LANGSMITH_API_KEY not set; tracing will fail")
    else:
        os.environ["LANGSMITH_API_KEY"] = api_key
        os.environ["LANGCHAIN_API_KEY"] = api_key

    logger.info("LangSmith tracing enabled for project '%s'", project)


def setup_tracing_from_settings(settings: Settings) -> None:
    if resolve_phoenix_tracing(settings):
        setup_phoenix_tracing(
            project=resolve_phoenix_project_name(settings),
            api_key=resolve_phoenix_api_key(settings),
            enabled=True,
            endpoint=resolve_phoenix_collector_endpoint(settings),
        )
        return

    setup_tracing(
        project=resolve_langsmith_project(settings),
        api_key=resolve_langsmith_api_key(settings),
        enabled=resolve_langsmith_tracing(settings),
        endpoint=resolve_langsmith_endpoint(settings),
    )
