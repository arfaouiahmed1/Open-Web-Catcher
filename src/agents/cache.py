"""Cache helpers extracted from the agent loop.

GeminiCacheManager  — manages Gemini explicit cached-content resources.
ToolResultCache     — in-process tool-result deduplication cache.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from datetime import datetime, timezone
from threading import Lock
from typing import Any

import httpx

from src.utils.config import Settings
from src.utils.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Helpers shared by both cache classes
# ---------------------------------------------------------------------------

def _to_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _parse_duration_seconds(value: Any) -> int:
    text = str(value or "").strip().lower()
    if not text:
        return 0
    if text.isdigit():
        return int(text)
    match = re.fullmatch(r"([0-9]+)\s*([smhd])", text)
    if not match:
        return 0
    amount = int(match.group(1))
    unit = match.group(2)
    return amount * {"s": 1, "m": 60, "h": 3600, "d": 86400}[unit]


def _parse_expire_epoch(expire_time: str) -> float | None:
    text = str(expire_time or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = f"{text[:-1]}+00:00"
    try:
        return datetime.fromisoformat(text).astimezone(timezone.utc).timestamp()
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# GeminiCacheManager
# ---------------------------------------------------------------------------

_REGISTRY: dict[str, dict[str, Any]] = {}
_REGISTRY_LOCK = Lock()
_DEFAULT_TTL_SECONDS = 30 * 60
_DEFAULT_REFRESH_LEAD_SECONDS = 2 * 60
_MAX_REGISTRY_ENTRIES = 256


def _evict_registry(now_epoch: float) -> None:
    stale = [k for k, v in _REGISTRY.items() if float(v.get("expires_at", 0) or 0) <= now_epoch]
    for k in stale:
        _REGISTRY.pop(k, None)
    max_entries = max(_MAX_REGISTRY_ENTRIES, 8)
    if len(_REGISTRY) <= max_entries:
        return
    ordered = sorted(_REGISTRY.items(), key=lambda item: float(item[1].get("created_at", 0) or 0))
    while len(ordered) > max_entries:
        oldest_key, _ = ordered.pop(0)
        _REGISTRY.pop(oldest_key, None)


def _normalize_gemini_model_name(model_name: str) -> str:
    model = str(model_name or "").strip()
    if not model:
        return ""
    if "/" in model and not model.startswith(("models/", "tunedModels/")):
        model = model.split("/", 1)[-1]
    if model.startswith(("models/", "tunedModels/")):
        return model
    return f"models/{model}"


def _gemini_display_name(cache_key: str) -> str:
    digest = hashlib.sha256(cache_key.encode("utf-8")).hexdigest()[:24]
    return f"owc-{digest}"


def _registry_key(prompt_metadata: dict[str, Any], seed_text: str, model_name: str) -> str:
    provider_cache_key = str(prompt_metadata.get("provider_cache_key", "") or "").strip()
    if provider_cache_key:
        return f"{model_name}:{provider_cache_key}"
    digest = hashlib.sha256(seed_text.encode("utf-8")).hexdigest()[:24]
    return f"{model_name}:auto:{digest}"


def _extract_gemini_cache_seed_text(system_prompt: str) -> str:
    text = str(system_prompt or "").strip()
    if not text:
        return ""
    marker = "\n\nTASK BRIEF\n"
    if marker in text:
        return text.split(marker, 1)[0].strip()
    return text


def _is_gemini_explicit_cache_enabled(settings: Settings, prompt_metadata: dict[str, Any]) -> bool:
    if not settings.provider_cache_enabled or not settings.prompt_cache_enabled:
        return False
    if not bool(prompt_metadata.get("provider_cache_eligible", False)):
        return False
    cache_mode = str(prompt_metadata.get("cache_mode", "") or "").strip().lower()
    if cache_mode not in {"provider_hook", "provider_active"}:
        return False
    return bool(getattr(settings, "gemini_explicit_cache_enabled", True))


def _gemini_ttl_seconds(settings: Settings, prompt_metadata: dict[str, Any]) -> int:
    ttl = _parse_duration_seconds(prompt_metadata.get("gemini_cache_ttl"))
    if ttl <= 0:
        ttl = _parse_duration_seconds(prompt_metadata.get("provider_cache_ttl"))
    if ttl <= 0:
        ttl = _to_int(prompt_metadata.get("gemini_cache_ttl_seconds"))
    if ttl <= 0:
        ttl = _to_int(getattr(settings, "gemini_explicit_cache_ttl_seconds", 0))
    if ttl <= 0:
        ttl = _DEFAULT_TTL_SECONDS
    return max(ttl, 60)


def _gemini_refresh_lead_seconds(settings: Settings, prompt_metadata: dict[str, Any], ttl_seconds: int) -> int:
    lead = _to_int(prompt_metadata.get("gemini_cache_refresh_lead_seconds"))
    if lead <= 0:
        lead = _to_int(getattr(settings, "gemini_explicit_cache_refresh_lead_seconds", 0))
    if lead <= 0:
        lead = min(_DEFAULT_REFRESH_LEAD_SECONDS, max(ttl_seconds // 5, 30))
    return max(lead, 5)


async def _create_gemini_cached_content_resource(
    *,
    api_key: str,
    model_name: str,
    cache_key: str,
    seed_text: str,
    ttl_seconds: int,
    timeout_seconds: int,
) -> tuple[str, float]:
    if not api_key or not model_name or not seed_text:
        return "", 0.0
    model = _normalize_gemini_model_name(model_name)
    payload = {
        "model": model,
        "displayName": _gemini_display_name(cache_key),
        "ttl": f"{ttl_seconds}s",
        "contents": [{"role": "user", "parts": [{"text": seed_text}]}],
    }
    url = "https://generativelanguage.googleapis.com/v1beta/cachedContents"
    async with httpx.AsyncClient(timeout=max(timeout_seconds, 5)) as client:
        response = await client.post(url, params={"key": api_key}, json=payload)
        response.raise_for_status()
        data = response.json() if response.content else {}
    if not isinstance(data, dict):
        return "", 0.0
    cached_content = str(data.get("name", "") or "").strip()
    expires_at = _parse_expire_epoch(str(data.get("expireTime", "") or ""))
    if expires_at is None:
        expires_at = time.time() + ttl_seconds
    return cached_content, float(expires_at)


class GeminiCacheManager:
    """Manages Gemini explicit cached-content resources.

    Thread-safe registry keyed by (model, prompt hash). Handles creation,
    TTL-based refresh, and eviction. Extracted from run_agent_loop to keep
    the agent loop focused on LLM/tool orchestration.
    """

    def clear_registry_for_tests(self) -> None:
        with _REGISTRY_LOCK:
            _REGISTRY.clear()

    async def resolve(
        self,
        settings: Settings,
        *,
        prompt_metadata: dict[str, Any],
        system_prompt: str,
        model_name: str,
        now_epoch: float | None = None,
    ) -> tuple[str, str]:
        """Return (cached_content_resource_name, source_label).

        source_label values: manual | provider_key | disabled | seed_too_small |
                             registry_hit | fallback_after_error | create_failed |
                             empty_resource | created | refreshed
        """
        cached_content = str(prompt_metadata.get("gemini_cached_content", "") or "").strip()
        if cached_content:
            return cached_content, "manual"

        provider_cache_key = str(prompt_metadata.get("provider_cache_key", "") or "").strip()
        if provider_cache_key.startswith("cachedContents/"):
            return provider_cache_key, "provider_key"

        if not _is_gemini_explicit_cache_enabled(settings, prompt_metadata):
            return "", "disabled"

        seed_text = _extract_gemini_cache_seed_text(system_prompt)
        min_chars = max(int(settings.prompt_cache_min_chars or 0), 0)
        if len(seed_text) < min_chars:
            return "", "seed_too_small"

        now = float(now_epoch if now_epoch is not None else time.time())
        ttl_seconds = _gemini_ttl_seconds(settings, prompt_metadata)
        refresh_lead = _gemini_refresh_lead_seconds(settings, prompt_metadata, ttl_seconds)
        cache_key = _registry_key(prompt_metadata, seed_text, model_name)

        with _REGISTRY_LOCK:
            entry = _REGISTRY.get(cache_key)
            if entry is not None:
                entry_name = str(entry.get("cached_content", "") or "").strip()
                expires_at = float(entry.get("expires_at", 0) or 0)
                if entry_name and (expires_at - now) > refresh_lead:
                    return entry_name, "registry_hit"

        try:
            created_name, expires_at = await _create_gemini_cached_content_resource(
                api_key=settings.google_api_key,
                model_name=model_name,
                cache_key=cache_key,
                seed_text=seed_text,
                ttl_seconds=ttl_seconds,
                timeout_seconds=max(int(settings.tool_timeout_seconds or 30), 5),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Gemini explicit cache create/refresh failed for %s: %s", cache_key, exc)
            with _REGISTRY_LOCK:
                fallback = _REGISTRY.get(cache_key)
                if fallback is not None:
                    fallback_name = str(fallback.get("cached_content", "") or "").strip()
                    fallback_expires = float(fallback.get("expires_at", 0) or 0)
                    if fallback_name and fallback_expires > now:
                        return fallback_name, "fallback_after_error"
            return "", "create_failed"

        if not created_name:
            return "", "empty_resource"

        with _REGISTRY_LOCK:
            prior = _REGISTRY.get(cache_key)
            _REGISTRY[cache_key] = {
                "cached_content": created_name,
                "expires_at": expires_at,
                "created_at": now,
                "ttl_seconds": ttl_seconds,
            }
            _evict_registry(now)
            return created_name, "created" if prior is None else "refreshed"


# ---------------------------------------------------------------------------
# ToolResultCache
# ---------------------------------------------------------------------------

_CACHE_ELIGIBLE_TOOLS = frozenset({
    "get_page_context",
    "query_elements",
    "get_element_detail",
    "get_frame_tree",
    "get_media_state",
    "inspect",
    "inspect_landing",
    "inspect_hosting",
    "inspect_embedded",
})

_STATE_MUTATING_TOOLS = frozenset({
    "navigate",
    "open_url",
    "go_back",
    "click_element",
    "click_css",
    "click_text",
    "click_xpath",
    "click_checkbox",
    "click_radio",
    "click_coordinates",
    "type_into",
    "select_option",
    "play_media",
    "swipe_region",
    "wait_for_page_state",
    "interact",
    "scroll_page",
    "scroll_to_element",
})


def _tool_cache_key(tool_name: str, tool_args: dict[str, Any], generation: int) -> str:
    payload = json.dumps(tool_args or {}, sort_keys=True, default=str)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return f"{generation}:{tool_name}:{digest}"


def _is_state_mutating_tool(tool_name: str) -> bool:
    return tool_name in _STATE_MUTATING_TOOLS


class ToolResultCache:
    """Per-agent-run tool result deduplication cache.

    A result is promoted to "cached" only after `min_identical_observations`
    consecutive identical executions. This guards against non-deterministic
    tools being served stale data.
    """

    def __init__(self, min_identical_observations: int = 2) -> None:
        self._min_obs = max(min_identical_observations, 2)
        self._store: dict[str, dict[str, Any]] = {}
        self._generation = 0
        self.hits = 0
        self.misses = 0
        self.bypasses = 0
        self.writes = 0
        self.invalidations = 0
        self.last_invalidation_reason = ""

    def is_eligible(self, tool_name: str) -> bool:
        return tool_name in _CACHE_ELIGIBLE_TOOLS

    @property
    def generation(self) -> int:
        return self._generation

    def invalidate(self, reason: str = "state_changed") -> None:
        self._generation += 1
        self.invalidations += 1
        self.last_invalidation_reason = str(reason or "state_changed")

    def get(self, tool_name: str, tool_args: dict[str, Any]) -> tuple[str | None, str]:
        """Return ``(cached_result, status)`` for the current page-state generation."""
        key = _tool_cache_key(tool_name, tool_args, self._generation)
        entry = self._store.get(key)
        if entry is None:
            self.misses += 1
            return None, "miss"
        if not entry.get("cached_result"):
            self.bypasses += 1
            return None, "unstable"
        if int(entry.get("stable_observations", 0)) < self._min_obs:
            self.bypasses += 1
            return None, "below_threshold"
        self.hits += 1
        return str(entry["cached_result"]), "hit"

    def update(self, tool_name: str, tool_args: dict[str, Any], result: str) -> None:
        """Record a live execution result; promote to cache when stable."""
        key = _tool_cache_key(tool_name, tool_args, self._generation)
        entry = self._store.get(key)
        if entry is None:
            self._store[key] = {
                "last_output": result,
                "stable_observations": 1,
                "cached_result": "",
                "generation": self._generation,
            }
        else:
            if result == entry.get("last_output"):
                entry["stable_observations"] = int(entry.get("stable_observations", 0)) + 1
            else:
                entry["last_output"] = result
                entry["stable_observations"] = 1
                entry["cached_result"] = ""

            entry = self._store[key]
            if int(entry.get("stable_observations", 0)) >= self._min_obs:
                if entry.get("cached_result") != result:
                    self.writes += 1
                entry["cached_result"] = result
                entry["last_output"] = result
