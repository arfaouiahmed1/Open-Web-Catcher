from __future__ import annotations

from src.api.datasets import _classify_site_health, _health_probe_url, _health_probe_urls


def test_health_probe_url_accepts_http_urls_and_plain_hosts() -> None:
    assert _health_probe_url("https://example.com/live") == "https://example.com/live"
    assert _health_probe_urls("https://example.com/live") == [
        "https://example.com/live",
        "http://example.com/live",
    ]
    assert _health_probe_url("example.com/live") == "https://example.com/live"
    assert _health_probe_urls("example.com/live") == [
        "https://example.com/live",
        "http://example.com/live",
    ]
    assert _health_probe_url("javascript:alert(1)") == ""


def test_site_health_classification_uses_green_or_yellow_tones() -> None:
    working = _classify_site_health(
        200,
        content_type="text/html",
        sample_text="<html><body><h1>Live sports streams</h1><p>Schedule and links.</p></body></html>",
        sample_size=78,
    )
    blocked = _classify_site_health(403)
    timeout = _classify_site_health(error="timeout")

    assert working["status"] == "working"
    assert working["tone"] == "success"
    assert working["working"] is True
    assert blocked["status"] == "blocked_access"
    assert blocked["tone"] == "warning"
    assert blocked["working"] is True
    assert blocked["delete_candidate"] is False
    assert timeout["status"] == "down"
    assert timeout["tone"] == "warning"
    assert timeout["working"] is False


def test_site_health_marks_fake_success_content_as_not_working() -> None:
    seized = _classify_site_health(
        200,
        content_type="text/html",
        sample_text="This domain name has been seized by the Federal Bureau of Investigation.",
        sample_size=72,
    )
    image_only = _classify_site_health(
        200,
        content_type="image/png",
        sample_text="",
        sample_size=512,
    )
    tiny = _classify_site_health(
        200,
        content_type="text/html",
        sample_text="OK",
        sample_size=2,
    )

    assert seized["status"] == "seized"
    assert seized["working"] is False
    assert image_only["status"] == "asset_only"
    assert image_only["working"] is False
    assert tiny["status"] == "empty"
    assert tiny["working"] is False


def test_site_health_keeps_anti_bot_pages_out_of_delete_candidates() -> None:
    guarded = _classify_site_health(
        200,
        content_type="text/html",
        sample_text="<html><body><h1>Just a moment...</h1><p>Checking your browser before accessing this site. Enable JavaScript and cookies.</p></body></html>",
        sample_size=138,
    )

    assert guarded["status"] == "anti_bot"
    assert guarded["tone"] == "warning"
    assert guarded["working"] is True
    assert guarded["delete_candidate"] is False
