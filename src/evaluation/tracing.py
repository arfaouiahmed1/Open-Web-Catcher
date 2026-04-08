"""Internal observability bootstrap helpers."""

from __future__ import annotations

from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)


def setup_tracing_from_settings(settings: Settings) -> None:
    if settings.observability_enabled:
        logger.info(
            "Internal observability enabled for project '%s'",
            settings.observability_project_name,
        )
    else:
        logger.info("Internal observability disabled")
