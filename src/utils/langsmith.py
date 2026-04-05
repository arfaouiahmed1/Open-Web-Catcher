"""Helpers for resolving LangSmith settings across cloud and self-hosted setups."""

from __future__ import annotations

import os
from urllib.parse import urlparse, urlunparse

from src.utils.config import Settings

_PLACEHOLDER_VALUES = {
    "",
    "your_langsmith_api_key_here",
    "your_api_key_here",
    "changeme",
    "replace-me",
}
_CLOUD_API_HOSTS = {
    "api.smith.langchain.com",
    "eu.api.smith.langchain.com",
}
_CLOUD_UI_HOSTS = {
    "smith.langchain.com",
    "eu.smith.langchain.com",
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


def resolve_langsmith_tracing(settings: Settings) -> bool:
    for env_name in ("LANGCHAIN_TRACING_V2", "LANGSMITH_TRACING"):
        parsed = _parse_bool(os.getenv(env_name))
        if parsed is not None:
            return parsed
    return bool(settings.langchain_tracing_v2)


def resolve_langsmith_api_key(settings: Settings) -> str:
    for candidate in (
        os.getenv("LANGSMITH_API_KEY"),
        os.getenv("LANGCHAIN_API_KEY"),
        settings.langchain_api_key,
    ):
        cleaned = _clean_value(candidate)
        if cleaned:
            return cleaned
    return ""


def resolve_langsmith_project(settings: Settings) -> str:
    for candidate in (
        os.getenv("LANGSMITH_PROJECT"),
        os.getenv("LANGCHAIN_PROJECT"),
        settings.langchain_project,
    ):
        cleaned = (candidate or "").strip()
        if cleaned:
            return cleaned
    return "open-web-catcher"


def resolve_langsmith_endpoint(settings: Settings) -> str:
    endpoint = _clean_value(os.getenv("LANGSMITH_ENDPOINT")) or settings.langsmith_endpoint
    return endpoint.rstrip("/")


def resolve_langsmith_ui_url(settings: Settings) -> str:
    explicit = _clean_value(os.getenv("LANGSMITH_UI_URL")) or _clean_value(settings.langsmith_ui_url)
    if explicit:
        return explicit.rstrip("/")

    endpoint = resolve_langsmith_endpoint(settings)
    parsed = urlparse(endpoint)
    if not parsed.scheme or not parsed.netloc:
        return ""

    netloc = parsed.netloc
    path = parsed.path.rstrip("/")

    if netloc.startswith("api."):
        netloc = netloc[4:]
        path = ""
    elif path.endswith("/api/v1"):
        path = path[:-7]
    elif path.endswith("/api"):
        path = path[:-4]

    return urlunparse((parsed.scheme, netloc, path, "", "", "")).rstrip("/")


def is_self_hosted_langsmith(settings: Settings) -> bool:
    endpoint = resolve_langsmith_endpoint(settings)
    hostname = urlparse(endpoint).hostname or ""
    hostname = hostname.lower()
    if not hostname:
        return False
    return hostname not in _CLOUD_API_HOSTS and hostname not in _CLOUD_UI_HOSTS
