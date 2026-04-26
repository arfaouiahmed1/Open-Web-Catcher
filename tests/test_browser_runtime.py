"""Browser runtime normalization tests."""

from __future__ import annotations

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
