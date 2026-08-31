from __future__ import annotations

from typing import Any

from src.utils import service_health


class _Response:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict[str, str]:
        return {
            "Browser": "Chrome/test",
            "webSocketDebuggerUrl": "ws://127.0.0.1:9224/devtools/browser/test",
        }


def test_probe_browser_uses_loopback_host_header_for_sidecar_proxy(monkeypatch: Any) -> None:
    captured: dict[str, Any] = {}

    def fake_get(url: str, **kwargs: Any) -> _Response:
        captured["url"] = url
        captured.update(kwargs)
        return _Response()

    monkeypatch.setattr(service_health.httpx, "get", fake_get)

    result = service_health.probe_browser("ws://owc-tools-playwright:9224")

    assert result["healthy"] is True
    assert captured["url"] == "http://owc-tools-playwright:9224/json/version"
    assert captured["headers"] == {"Host": "127.0.0.1"}


def test_probe_browser_keeps_default_host_for_loopback(monkeypatch: Any) -> None:
    captured: dict[str, Any] = {}

    def fake_get(url: str, **kwargs: Any) -> _Response:
        captured.update(kwargs)
        return _Response()

    monkeypatch.setattr(service_health.httpx, "get", fake_get)

    result = service_health.probe_browser("ws://127.0.0.1:9223")

    assert result["healthy"] is True
    assert captured["headers"] == {}
