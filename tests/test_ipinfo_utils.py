import httpx

from src.models.schemas import ProviderInfo
from src.utils import ipinfo as ipinfo_utils


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self._payload


def test_lookup_stream_url_enriches_with_rdap_abuse_and_whois(monkeypatch) -> None:
    monkeypatch.setattr(ipinfo_utils, "resolve_ip", lambda hostname: "1.2.3.4")

    def fake_get(url, params=None, timeout=None, follow_redirects=False):
        if url.startswith(ipinfo_utils.IPINFO_BASE):
            return _FakeResponse(
                {
                    "hostname": "edge.example.net",
                    "org": "AS64500 Example CDN",
                    "country": "NL",
                    "region": "North Holland",
                    "city": "Amsterdam",
                }
            )
        if url.startswith(ipinfo_utils.RDAP_BASE):
            return _FakeResponse(
                {
                    "name": "Example Network",
                    "entities": [
                        {
                            "roles": ["abuse"],
                            "vcardArray": [
                                "vcard",
                                [["email", {}, "text", "abuse@example.net"]],
                            ],
                        }
                    ],
                }
            )
        raise AssertionError(url)

    monkeypatch.setattr(ipinfo_utils.httpx, "get", fake_get)

    result = ipinfo_utils.lookup_stream_url("https://stream.example.net/master.m3u8")

    assert result.ip == "1.2.3.4"
    assert result.hostname == "edge.example.net"
    assert result.provider == "Example CDN"
    assert result.abuse_email == "abuse@example.net"
    assert "Example Network" in result.whois_raw


def test_lookup_stream_url_uses_rdap_org_when_ipinfo_fails(monkeypatch) -> None:
    monkeypatch.setattr(ipinfo_utils, "resolve_ip", lambda hostname: "5.6.7.8")

    def fake_get(url, params=None, timeout=None, follow_redirects=False):
        if url.startswith(ipinfo_utils.IPINFO_BASE):
            raise httpx.HTTPError("boom")
        if url.startswith(ipinfo_utils.RDAP_BASE):
            return _FakeResponse(
                {
                    "name": "Fallback Hosting",
                    "entities": [
                        {
                            "roles": ["technical"],
                            "vcardArray": [
                                "vcard",
                                [["email", {}, "text", "noc@fallback-hosting.test"]],
                            ],
                        }
                    ],
                }
            )
        raise AssertionError(url)

    monkeypatch.setattr(ipinfo_utils.httpx, "get", fake_get)

    result = ipinfo_utils.lookup_stream_url("https://fallback-hosting.test/video.mpd")

    assert result.ip == "5.6.7.8"
    assert result.org == "Fallback Hosting"
    assert result.provider == "Fallback Hosting"
    assert result.abuse_email == "noc@fallback-hosting.test"
    assert "Fallback Hosting" in result.whois_raw


def test_lookup_multiple_reuses_previous_host_result(monkeypatch) -> None:
    calls = []

    def fake_lookup(stream_url: str, ipinfo_token: str = "") -> ProviderInfo:
        calls.append(stream_url)
        return ProviderInfo(
            stream_url=stream_url,
            ip="9.9.9.9",
            hostname="cdn.example.net",
            provider="Example CDN",
        )

    monkeypatch.setattr(ipinfo_utils, "lookup_stream_url", fake_lookup)

    results = ipinfo_utils.lookup_multiple(
        [
            "https://cdn.example.net/master.m3u8",
            "https://cdn.example.net/backup.m3u8",
        ],
        deduplicate_by_provider=False,
    )

    assert len(calls) == 1
    assert len(results) == 2
    assert results[1].stream_url == "https://cdn.example.net/backup.m3u8"
    assert results[1].provider == "Example CDN"
