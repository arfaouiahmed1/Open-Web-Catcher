"""LangSmith callback setup + local fallback."""

from __future__ import annotations

import os

from src.utils.logging import get_logger

logger = get_logger(__name__)


def setup_tracing(
    project: str = "open-web-catcher",
    api_key: str = "",
    enabled: bool = False,
) -> None:
    """Configure LangSmith tracing environment variables.

    When enabled=False (default), tracing is a no-op.
    """
    if not enabled:
        os.environ["LANGCHAIN_TRACING_V2"] = "false"
        logger.debug("LangSmith tracing disabled")
        return

    if not api_key:
        logger.warning("LANGCHAIN_API_KEY not set; tracing will fail")

    os.environ["LANGCHAIN_TRACING_V2"] = "true"
    os.environ["LANGCHAIN_API_KEY"] = api_key
    os.environ["LANGCHAIN_PROJECT"] = project
    logger.info("LangSmith tracing enabled for project '%s'", project)
