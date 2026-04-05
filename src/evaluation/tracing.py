"""LangSmith callback setup + local fallback."""

from __future__ import annotations

import os

from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)


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
    setup_tracing(
        project=settings.langchain_project,
        api_key=settings.langchain_api_key,
        enabled=settings.langchain_tracing_v2,
        endpoint=settings.langsmith_endpoint,
    )
