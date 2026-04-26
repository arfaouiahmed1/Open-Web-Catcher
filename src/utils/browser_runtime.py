"""Browser-runtime defaults and normalization helpers."""

from __future__ import annotations

from copy import deepcopy
from typing import Any

BROWSER_IDS = ("puppeteer", "playwright")
MCP_PROFILE_IDS = ("classification", "landing", "hosting", "embedded")
DEFAULT_PROXY_SOURCE_ORDER = [
    "openproxylist-https",
    "openproxylist-socks5",
    "speedx-http",
    "speedx-socks5",
]

DEFAULT_BROWSER_RUNTIME: dict[str, dict[str, Any]] = {
    "puppeteer": {
        "launch_timeout_ms": 45000,
        "extra_launch_args": [],
        "adblock_enabled": False,
        "adblock_allowlist_hosts": [],
        "adblock_excluded_categories": ["nsfw", "gambling"],
        "adblock_auto_recovery_enabled": True,
        "adblock_auto_recovery_on_abort": True,
        "adblock_auto_recovery_retry": True,
        "fingerprint_rotation_mode": "origin",
        "fingerprint_fallback_strategy": "profile",
        "fingerprint_rotation_interval_ms": 180000,
        "fingerprint_rotation_max_uses": 6,
        "fingerprint_recent_pool_size": 12,
        "proxy_enabled": False,
        "proxy_source_mode": "hybrid",
        "proxy_source_order": list(DEFAULT_PROXY_SOURCE_ORDER),
        "proxy_custom_list": [],
        "proxy_rotation_mode": "session",
        "proxy_selection_strategy": "ordered",
        "proxy_fallback_strategy": "direct",
        "proxy_fetch_timeout_ms": 8000,
        "proxy_validation_timeout_ms": 12000,
        "proxy_cache_ttl_ms": 600000,
        "proxy_max_candidates": 25,
        "proxy_test_url": "https://api.ipify.org?format=json",
        "ubol_enabled": True,
        "stream_cors_patch_enabled": False,
        "stream_cors_include_credentials": False,
        "iframe_sandbox_patch_enabled": True,
        "iframe_auto_recovery_enabled": True,
        "iframe_recovery_timeout_ms": 20000,
        "media_capture_timeout_ms": 30000,
        "media_retry_count": 3,
        "media_retry_backoff_ms": [1000, 2000, 4000],
        "media_cors_patch_enabled": False,
        "media_playback_verification_enabled": True,
    },
    "playwright": {
        "launch_timeout_ms": 45000,
        "extra_launch_args": [],
        "adblock_enabled": True,
        "adblock_allowlist_hosts": [],
        "adblock_excluded_categories": ["nsfw", "gambling"],
        "adblock_auto_recovery_enabled": True,
        "adblock_auto_recovery_on_abort": True,
        "adblock_auto_recovery_retry": True,
        "fingerprint_rotation_mode": "origin",
        "fingerprint_fallback_strategy": "profile",
        "fingerprint_rotation_interval_ms": 180000,
        "fingerprint_rotation_max_uses": 6,
        "fingerprint_recent_pool_size": 12,
        "proxy_enabled": False,
        "proxy_source_mode": "hybrid",
        "proxy_source_order": list(DEFAULT_PROXY_SOURCE_ORDER),
        "proxy_custom_list": [],
        "proxy_rotation_mode": "session",
        "proxy_selection_strategy": "ordered",
        "proxy_fallback_strategy": "direct",
        "proxy_fetch_timeout_ms": 8000,
        "proxy_validation_timeout_ms": 12000,
        "proxy_cache_ttl_ms": 600000,
        "proxy_max_candidates": 25,
        "proxy_test_url": "https://api.ipify.org?format=json",
        "iframe_sandbox_patch_enabled": True,
        "iframe_auto_recovery_enabled": True,
        "iframe_recovery_timeout_ms": 20000,
        "media_capture_timeout_ms": 30000,
        "media_retry_count": 3,
        "media_retry_backoff_ms": [1000, 2000, 4000],
        "media_cors_patch_enabled": False,
        "media_playback_verification_enabled": True,
    },
}


def normalize_browser_runtime(value: Any) -> dict[str, dict[str, Any]]:
    """Normalize persisted per-browser runtime settings."""

    normalized = deepcopy(DEFAULT_BROWSER_RUNTIME)
    if not isinstance(value, dict):
        return normalized

    for browser in BROWSER_IDS:
        raw = value.get(browser, {})
        if not isinstance(raw, dict):
            continue
        current = normalized[browser]
        current["launch_timeout_ms"] = _coerce_int(raw.get("launch_timeout_ms"), current["launch_timeout_ms"], minimum=1000)
        current["extra_launch_args"] = _coerce_string_list(raw.get("extra_launch_args"))
        current["adblock_enabled"] = _coerce_bool(raw.get("adblock_enabled"), current["adblock_enabled"])
        current["adblock_allowlist_hosts"] = _coerce_string_list(raw.get("adblock_allowlist_hosts"))
        current["adblock_excluded_categories"] = _coerce_string_list(
            raw.get("adblock_excluded_categories"),
            fallback=current["adblock_excluded_categories"],
        )
        current["adblock_auto_recovery_enabled"] = _coerce_bool(
            raw.get("adblock_auto_recovery_enabled"),
            current["adblock_auto_recovery_enabled"],
        )
        current["adblock_auto_recovery_on_abort"] = _coerce_bool(
            raw.get("adblock_auto_recovery_on_abort"),
            current["adblock_auto_recovery_on_abort"],
        )
        current["adblock_auto_recovery_retry"] = _coerce_bool(
            raw.get("adblock_auto_recovery_retry"),
            current["adblock_auto_recovery_retry"],
        )
        current["fingerprint_rotation_mode"] = _coerce_choice(
            raw.get("fingerprint_rotation_mode"),
            allowed={"never", "page", "origin", "interval"},
            fallback=current["fingerprint_rotation_mode"],
        )
        current["fingerprint_fallback_strategy"] = _coerce_choice(
            raw.get("fingerprint_fallback_strategy"),
            allowed={"profile", "none"},
            fallback=current["fingerprint_fallback_strategy"],
        )
        current["fingerprint_rotation_interval_ms"] = _coerce_int(
            raw.get("fingerprint_rotation_interval_ms"),
            current["fingerprint_rotation_interval_ms"],
            minimum=1000,
        )
        current["fingerprint_rotation_max_uses"] = _coerce_int(
            raw.get("fingerprint_rotation_max_uses"),
            current["fingerprint_rotation_max_uses"],
            minimum=1,
        )
        current["fingerprint_recent_pool_size"] = _coerce_int(
            raw.get("fingerprint_recent_pool_size"),
            current["fingerprint_recent_pool_size"],
            minimum=1,
        )
        current["proxy_enabled"] = _coerce_bool(raw.get("proxy_enabled"), current["proxy_enabled"])
        current["proxy_source_mode"] = _coerce_choice(
            raw.get("proxy_source_mode"),
            allowed={"remote", "custom", "hybrid"},
            fallback=current["proxy_source_mode"],
        )
        current["proxy_source_order"] = _coerce_string_list(
            raw.get("proxy_source_order"),
            fallback=current["proxy_source_order"],
        )
        current["proxy_custom_list"] = _coerce_string_list(raw.get("proxy_custom_list"))
        current["proxy_rotation_mode"] = _coerce_choice(
            raw.get("proxy_rotation_mode"),
            allowed={"never", "session", "sticky", "failure"},
            fallback=current["proxy_rotation_mode"],
        )
        current["proxy_selection_strategy"] = _coerce_choice(
            raw.get("proxy_selection_strategy"),
            allowed={"ordered", "random"},
            fallback=current["proxy_selection_strategy"],
        )
        current["proxy_fallback_strategy"] = _coerce_choice(
            raw.get("proxy_fallback_strategy"),
            allowed={"direct", "fail"},
            fallback=current["proxy_fallback_strategy"],
        )
        current["proxy_fetch_timeout_ms"] = _coerce_int(
            raw.get("proxy_fetch_timeout_ms"),
            current["proxy_fetch_timeout_ms"],
            minimum=1000,
        )
        current["proxy_validation_timeout_ms"] = _coerce_int(
            raw.get("proxy_validation_timeout_ms"),
            current["proxy_validation_timeout_ms"],
            minimum=1000,
        )
        current["proxy_cache_ttl_ms"] = _coerce_int(
            raw.get("proxy_cache_ttl_ms"),
            current["proxy_cache_ttl_ms"],
            minimum=1000,
        )
        current["proxy_max_candidates"] = _coerce_int(
            raw.get("proxy_max_candidates"),
            current["proxy_max_candidates"],
            minimum=1,
        )
        current["proxy_test_url"] = _coerce_string(
            raw.get("proxy_test_url"),
            fallback=current["proxy_test_url"],
        )
        current["iframe_sandbox_patch_enabled"] = _coerce_bool(
            raw.get("iframe_sandbox_patch_enabled"),
            current["iframe_sandbox_patch_enabled"],
        )
        current["iframe_auto_recovery_enabled"] = _coerce_bool(
            raw.get("iframe_auto_recovery_enabled"),
            current["iframe_auto_recovery_enabled"],
        )
        current["iframe_recovery_timeout_ms"] = _coerce_int(
            raw.get("iframe_recovery_timeout_ms"),
            current["iframe_recovery_timeout_ms"],
            minimum=5000,
        )
        current["media_capture_timeout_ms"] = _coerce_int(
            raw.get("media_capture_timeout_ms"),
            current["media_capture_timeout_ms"],
            minimum=5000,
        )
        current["media_retry_count"] = _coerce_int(
            raw.get("media_retry_count"),
            current["media_retry_count"],
            minimum=0,
        )
        current["media_retry_backoff_ms"] = _coerce_int_list(
            raw.get("media_retry_backoff_ms"),
            fallback=current["media_retry_backoff_ms"],
            minimum=0,
        )
        current["media_cors_patch_enabled"] = _coerce_bool(
            raw.get("media_cors_patch_enabled"),
            current["media_cors_patch_enabled"],
        )
        current["media_playback_verification_enabled"] = _coerce_bool(
            raw.get("media_playback_verification_enabled"),
            current["media_playback_verification_enabled"],
        )
        if browser == "puppeteer":
            current["ubol_enabled"] = _coerce_bool(raw.get("ubol_enabled"), current["ubol_enabled"])
            current["stream_cors_patch_enabled"] = _coerce_bool(
                raw.get("stream_cors_patch_enabled"),
                current["stream_cors_patch_enabled"],
            )
            current["stream_cors_include_credentials"] = _coerce_bool(
                raw.get("stream_cors_include_credentials"),
                current["stream_cors_include_credentials"],
            )

    return normalized


def normalize_disabled_tools_by_browser_profile(
    value: Any,
    *,
    legacy: Any = None,
) -> dict[str, dict[str, list[str]]]:
    """Normalize per-browser MCP tool toggles.

    Legacy profile-only config is copied to both browsers so existing installs
    keep their previous behavior until operators split the settings.
    """

    normalized = {
        browser: {profile: [] for profile in MCP_PROFILE_IDS}
        for browser in BROWSER_IDS
    }

    legacy_profiles = _normalize_profile_tool_map(legacy)
    if legacy_profiles:
        for browser in BROWSER_IDS:
            for profile, tools in legacy_profiles.items():
                normalized[browser][profile] = list(tools)

    if not isinstance(value, dict):
        return normalized

    top_level_profiles = _normalize_profile_tool_map(value)
    if top_level_profiles:
        for browser in BROWSER_IDS:
            for profile, tools in top_level_profiles.items():
                normalized[browser][profile] = list(tools)

    for browser in BROWSER_IDS:
        raw_profiles = value.get(browser, {})
        if not isinstance(raw_profiles, dict):
            continue
        for profile, tools in _normalize_profile_tool_map(raw_profiles).items():
            normalized[browser][profile] = list(tools)

    return normalized


def _normalize_profile_tool_map(value: Any) -> dict[str, list[str]]:
    if not isinstance(value, dict):
        return {}

    normalized: dict[str, list[str]] = {}
    for profile in MCP_PROFILE_IDS:
        tools = value.get(profile)
        if tools is None:
            continue
        normalized[profile] = _coerce_string_list(tools)
    return normalized


def _coerce_bool(value: Any, fallback: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
    return fallback


def _coerce_int(value: Any, fallback: int, *, minimum: int = 1) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return fallback
    return max(minimum, parsed)


def _coerce_choice(value: Any, *, allowed: set[str], fallback: str) -> str:
    candidate = str(value or "").strip().lower()
    return candidate if candidate in allowed else fallback


def _coerce_string(value: Any, *, fallback: str) -> str:
    candidate = str(value or "").strip()
    return candidate or fallback


def _coerce_string_list(value: Any, *, fallback: list[str] | None = None) -> list[str]:
    rows: list[str] = []
    if isinstance(value, str):
        rows = [item.strip() for item in value.split(",")]
    elif isinstance(value, (list, tuple, set)):
        rows = [str(item or "").strip() for item in value]
    elif fallback is not None:
        rows = list(fallback)

    deduped: list[str] = []
    seen: set[str] = set()
    for item in rows:
        if not item:
            continue
        normalized = item.lower()
        if normalized in seen:
            continue
        seen.add(normalized)
        deduped.append(item)
    return deduped


def _coerce_int_list(
    value: Any,
    *,
    fallback: list[int] | None = None,
    minimum: int = 0,
) -> list[int]:
    rows: list[Any] = []
    if isinstance(value, str):
        rows = [item.strip() for item in value.split(",")]
    elif isinstance(value, (list, tuple, set)):
        rows = list(value)
    elif fallback is not None:
        rows = list(fallback)

    normalized: list[int] = []
    for item in rows:
        try:
            parsed = int(item)
        except (TypeError, ValueError):
            continue
        normalized.append(max(minimum, parsed))

    return normalized or list(fallback or [])
