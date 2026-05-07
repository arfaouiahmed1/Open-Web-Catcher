"""Browser runtime normalization tests."""

from __future__ import annotations

from pathlib import Path

from src.utils.browser_runtime import DEFAULT_BROWSER_RUNTIME, normalize_browser_runtime


def test_normalize_browser_runtime_accepts_proxy_and_fingerprint_controls():
    payload = normalize_browser_runtime(
        {
            "puppeteer": {
                "fingerprint_fallback_strategy": "none",
                "proxy_enabled": True,
                "proxy_source_mode": "remote",
                "proxy_source_order": [
                    "speedx-http",
                    "speedx-http",
                    "openproxylist-socks5",
                ],
                "proxy_custom_list": [
                    "http://1.1.1.1:8080",
                    "http://1.1.1.1:8080",
                    "socks5://2.2.2.2:1080",
                ],
                "proxy_rotation_mode": "sticky",
                "proxy_selection_strategy": "random",
                "proxy_fallback_strategy": "fail",
                "proxy_fetch_timeout_ms": "9000",
                "proxy_validation_timeout_ms": 13000,
                "proxy_cache_ttl_ms": 700000,
                "proxy_max_candidates": 40,
                "proxy_test_url": "",
            }
        }
    )

    runtime = payload["puppeteer"]
    assert runtime["fingerprint_fallback_strategy"] == "none"
    assert runtime["proxy_enabled"] is True
    assert runtime["proxy_source_mode"] == "remote"
    assert runtime["proxy_source_order"] == ["speedx-http", "openproxylist-socks5"]
    assert runtime["proxy_custom_list"] == ["http://1.1.1.1:8080", "socks5://2.2.2.2:1080"]
    assert runtime["proxy_rotation_mode"] == "sticky"
    assert runtime["proxy_selection_strategy"] == "random"
    assert runtime["proxy_fallback_strategy"] == "fail"
    assert runtime["proxy_fetch_timeout_ms"] == 9000
    assert runtime["proxy_validation_timeout_ms"] == 13000
    assert runtime["proxy_cache_ttl_ms"] == 700000
    assert runtime["proxy_max_candidates"] == 40
    assert runtime["proxy_test_url"] == DEFAULT_BROWSER_RUNTIME["puppeteer"]["proxy_test_url"]


def test_normalize_browser_runtime_falls_back_on_invalid_proxy_choices():
    payload = normalize_browser_runtime(
        {
            "playwright": {
                "fingerprint_fallback_strategy": "weird",
                "proxy_source_mode": "mystery",
                "proxy_rotation_mode": "sometimes",
                "proxy_selection_strategy": "chaos",
                "proxy_fallback_strategy": "maybe",
                "proxy_fetch_timeout_ms": 50,
                "proxy_validation_timeout_ms": 50,
                "proxy_cache_ttl_ms": 50,
                "proxy_max_candidates": 0,
            }
        }
    )

    runtime = payload["playwright"]
    defaults = DEFAULT_BROWSER_RUNTIME["playwright"]
    assert runtime["fingerprint_fallback_strategy"] == defaults["fingerprint_fallback_strategy"]
    assert runtime["proxy_source_mode"] == defaults["proxy_source_mode"]
    assert runtime["proxy_rotation_mode"] == defaults["proxy_rotation_mode"]
    assert runtime["proxy_selection_strategy"] == defaults["proxy_selection_strategy"]
    assert runtime["proxy_fallback_strategy"] == defaults["proxy_fallback_strategy"]
    assert runtime["proxy_fetch_timeout_ms"] == 1000
    assert runtime["proxy_validation_timeout_ms"] == 1000
    assert runtime["proxy_cache_ttl_ms"] == 1000
    assert runtime["proxy_max_candidates"] == 1


def test_normalize_browser_runtime_accepts_media_and_iframe_recovery_controls():
    payload = normalize_browser_runtime(
        {
            "playwright": {
                "streaming_safe_mode": "always",
                "media_proxy_strategy": "proxy_first",
                "asset_diagnostics_enabled": False,
                "iframe_auto_recovery_enabled": False,
                "iframe_recovery_timeout_ms": "25000",
                "media_capture_timeout_ms": 45000,
                "media_retry_count": 5,
                "media_retry_backoff_ms": ["500", "1000", "bad", 2000],
                "media_cors_patch_enabled": True,
                "media_playback_verification_enabled": False,
            }
        }
    )

    runtime = payload["playwright"]
    assert runtime["streaming_safe_mode"] == "always"
    assert runtime["media_proxy_strategy"] == "proxy_first"
    assert runtime["asset_diagnostics_enabled"] is False
    assert runtime["iframe_auto_recovery_enabled"] is False
    assert runtime["iframe_recovery_timeout_ms"] == 25000
    assert runtime["media_capture_timeout_ms"] == 45000
    assert runtime["media_retry_count"] == 5
    assert runtime["media_retry_backoff_ms"] == [500, 1000, 2000]
    assert runtime["media_cors_patch_enabled"] is True
    assert runtime["media_playback_verification_enabled"] is False


def test_normalize_browser_runtime_rejects_invalid_streaming_policy_choices():
    payload = normalize_browser_runtime(
        {
            "puppeteer": {
                "streaming_safe_mode": "mystery",
                "media_proxy_strategy": "whatever",
            }
        }
    )

    runtime = payload["puppeteer"]
    defaults = DEFAULT_BROWSER_RUNTIME["puppeteer"]
    assert runtime["streaming_safe_mode"] == defaults["streaming_safe_mode"]
    assert runtime["media_proxy_strategy"] == defaults["media_proxy_strategy"]


def test_browser_runtime_defaults_stay_aligned_for_fingerprint_and_proxy_controls():
    puppeteer = DEFAULT_BROWSER_RUNTIME["puppeteer"]
    playwright = DEFAULT_BROWSER_RUNTIME["playwright"]
    shared_keys = (
        "adblock_allowlist_hosts",
        "fingerprint_rotation_mode",
        "fingerprint_fallback_strategy",
        "fingerprint_rotation_interval_ms",
        "fingerprint_rotation_max_uses",
        "fingerprint_recent_pool_size",
        "proxy_enabled",
        "proxy_source_mode",
        "proxy_rotation_mode",
        "proxy_selection_strategy",
        "proxy_fallback_strategy",
        "proxy_fetch_timeout_ms",
        "proxy_validation_timeout_ms",
        "proxy_cache_ttl_ms",
        "proxy_max_candidates",
        "proxy_test_url",
        "streaming_safe_mode",
        "media_proxy_strategy",
        "asset_diagnostics_enabled",
        "popup_blocking_enabled",
        "ubol_enabled",
        "iframe_sandbox_patch_enabled",
        "iframe_auto_recovery_enabled",
        "iframe_recovery_timeout_ms",
        "media_capture_timeout_ms",
        "media_retry_count",
        "media_retry_backoff_ms",
        "media_cors_patch_enabled",
        "media_playback_verification_enabled",
    )
    for key in shared_keys:
        assert puppeteer[key] == playwright[key], key


def test_browser_stacks_both_use_fingerprint_injector():
    workspace = Path(__file__).resolve().parents[1]
    puppeteer_source = (workspace / "tools" / "puppeteer" / "shared" / "browser.js").read_text(encoding="utf-8")
    playwright_source = (workspace / "tools" / "playwright" / "shared" / "browser.js").read_text(encoding="utf-8")

    assert "FingerprintInjector" in puppeteer_source
    assert "attachFingerprintToPuppeteer" in puppeteer_source
    assert "targetcreated" in puppeteer_source

    assert "FingerprintInjector" in playwright_source
    assert "attachFingerprintToPlaywright" in playwright_source
