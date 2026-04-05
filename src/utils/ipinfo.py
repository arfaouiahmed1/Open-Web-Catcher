"""IPInfo + basic Whois lookup for stream URL providers.

Uses ipinfo.io (free tier — 50k req/month) for IP geolocation and org info.
Falls back to socket.getfqdn for hostname resolution.

No LLM involved — purely deterministic API calls.
"""

from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlparse

import httpx

from src.models.schemas import ProviderInfo
from src.utils.logging import get_logger

logger = get_logger(__name__)

IPINFO_BASE = "https://ipinfo.io"
TIMEOUT = 8.0


def resolve_ip(hostname: str) -> str:
    """Resolve a hostname to its IPv4 address. Returns '' on failure."""
    try:
        return socket.gethostbyname(hostname)
    except socket.gaierror:
        return ""


def lookup_stream_url(stream_url: str, ipinfo_token: str = "") -> ProviderInfo:
    """Full provider lookup for a streaming URL.

    1. Parse hostname from URL.
    2. Resolve to IP.
    3. Call ipinfo.io/json for org, country, abuse contact.
    4. Return ProviderInfo.
    """
    parsed = urlparse(stream_url)
    hostname = parsed.hostname or ""

    # Skip obviously non-routable URLs
    if not hostname or hostname in ("localhost", "127.0.0.1"):
        return ProviderInfo(stream_url=stream_url)

    ip = resolve_ip(hostname)
    if not ip:
        logger.warning("Could not resolve IP for %s", hostname)
        return ProviderInfo(stream_url=stream_url, hostname=hostname)

    # Skip RFC1918 private addresses
    try:
        if ipaddress.ip_address(ip).is_private:
            return ProviderInfo(stream_url=stream_url, ip=ip, hostname=hostname)
    except ValueError:
        pass

    url = f"{IPINFO_BASE}/{ip}/json"
    params = {"token": ipinfo_token} if ipinfo_token else {}

    try:
        resp = httpx.get(url, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        data: dict = resp.json()
    except httpx.HTTPError as e:
        logger.warning("IPInfo request failed for %s: %s", ip, e)
        return ProviderInfo(stream_url=stream_url, ip=ip, hostname=hostname)

    org = data.get("org", "")           # e.g. "AS12345 Cloudflare, Inc."
    provider = _clean_provider(org)
    abuse_email = _extract_abuse_email(data)

    return ProviderInfo(
        stream_url=stream_url,
        ip=ip,
        hostname=data.get("hostname", hostname),
        org=org,
        provider=provider,
        country=data.get("country", ""),
        region=data.get("region", ""),
        city=data.get("city", ""),
        abuse_email=abuse_email,
    )


def lookup_multiple(
    stream_urls: list[str],
    ipinfo_token: str = "",
    deduplicate_by_provider: bool = True,
) -> list[ProviderInfo]:
    """Lookup providers for a list of stream URLs.

    If deduplicate_by_provider=True, only one lookup per unique provider org
    is returned (avoids hitting the same CDN dozens of times).
    """
    seen_providers: set[str] = set()
    results: list[ProviderInfo] = []

    for url in stream_urls:
        info = lookup_stream_url(url, ipinfo_token=ipinfo_token)

        if deduplicate_by_provider and info.provider:
            if info.provider in seen_providers:
                # Still record the URL but reuse provider data
                info_copy = info.model_copy()
                results.append(info_copy)
                continue
            seen_providers.add(info.provider)

        results.append(info)
        logger.debug("Looked up %s → %s (%s)", url, info.provider, info.country)

    return results


# ── Helpers ───────────────────────────────────────────────────────────────────

def _clean_provider(org: str) -> str:
    """Strip the ASN prefix from 'AS12345 Provider Name'."""
    return re.sub(r"^AS\d+\s+", "", org).strip()


def _extract_abuse_email(data: dict) -> str:
    """Try to find an abuse contact email from ipinfo response."""
    # ipinfo 'abuse' field (paid tier)
    abuse = data.get("abuse", {})
    if isinstance(abuse, dict):
        return abuse.get("email", "")
    # Sometimes it's a plain string
    if isinstance(abuse, str) and "@" in abuse:
        return abuse
    return ""
