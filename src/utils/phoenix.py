"""Helpers for resolving Phoenix tracing settings."""

from __future__ import annotations

import os
from urllib.parse import urlparse

from src.utils.config import Settings

_PLACEHOLDER_VALUES = {
    "",
    "your_api_key_here",
    "changeme",
    "replace-me",
}
_CLOUD_HOSTS = {
    "app.phoenix.arize.com",
}


def _clean_value(value: str | None) -> str:
    cleaned = (value or "").strip()
    if cleaned.lower() in _PLACEHOLDER_VALUES:
        return ""
    return cleaned


def _parse_bool(value: str | None) -> bool | None:
    if value is None:
        return None

    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return None


def resolve_phoenix_tracing(settings: Settings) -> bool:
    parsed = _parse_bool(os.getenv("PHOENIX_TRACING"))
    if parsed is not None:
        return parsed
    return bool(settings.phoenix_tracing)


def resolve_phoenix_api_key(settings: Settings) -> str:
    return _clean_value(os.getenv("PHOENIX_API_KEY")) or _clean_value(settings.phoenix_api_key)


def resolve_phoenix_project_name(settings: Settings) -> str:
    value = (os.getenv("PHOENIX_PROJECT_NAME") or settings.phoenix_project_name or "").strip()
    return value or "open-web-catcher"


def resolve_phoenix_collector_endpoint(settings: Settings) -> str:
    endpoint = _clean_value(os.getenv("PHOENIX_COLLECTOR_ENDPOINT")) or settings.phoenix_collector_endpoint
    return endpoint.rstrip("/")


def resolve_phoenix_ui_url(settings: Settings) -> str:
    ui_url = _clean_value(os.getenv("PHOENIX_UI_URL")) or settings.phoenix_ui_url
    if ui_url:
        return ui_url.rstrip("/")

    endpoint = resolve_phoenix_collector_endpoint(settings)
    parsed = urlparse(endpoint)
    if not parsed.scheme or not parsed.netloc:
        return ""

    return f"{parsed.scheme}://{parsed.netloc}"


def is_self_hosted_phoenix(settings: Settings) -> bool:
    endpoint = resolve_phoenix_collector_endpoint(settings)
    hostname = (urlparse(endpoint).hostname or "").lower()
    if not hostname:
        return False
    return hostname not in _CLOUD_HOSTS
