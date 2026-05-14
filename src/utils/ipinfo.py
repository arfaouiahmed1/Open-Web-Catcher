"""IPInfo + RDAP/Whois lookup for stream URL providers.

Uses ipinfo.io for IP geolocation and org info, then enriches the result with
RDAP ownership/contact data so the orchestrator can surface Whois-style evidence
and abuse contacts in run history without involving an LLM.
"""

from __future__ import annotations

import ipaddress
import json
import re
import socket
from urllib.parse import urlparse

import httpx

from src.models.schemas import ProviderInfo
from src.utils.logging import get_logger

logger = get_logger(__name__)

IPINFO_BASE = "https://ipinfo.io"
RDAP_BASE = "https://rdap.org/ip"
TIMEOUT = 8.0


def resolve_ip(hostname: str) -> str:
    """Resolve a hostname to its IPv4 address. Returns '' on failure."""
    try:
        return socket.gethostbyname(hostname)
    except socket.gaierror:
        return ""


def lookup_stream_url(stream_url: str, ipinfo_token: str = "") -> ProviderInfo:
    """Resolve one stream URL into provider and abuse-contact evidence."""
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

    ipinfo_data: dict[str, str] = {}
    try:
        resp = httpx.get(
            f"{IPINFO_BASE}/{ip}/json",
            params={"token": ipinfo_token} if ipinfo_token else {},
            timeout=TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        ipinfo_data = data if isinstance(data, dict) else {}
    except httpx.HTTPError as e:
        logger.warning("IPInfo request failed for %s: %s", ip, e)
        ipinfo_data = {}

    rdap_data = _lookup_rdap(ip)

    org = str(ipinfo_data.get("org", "") or "").strip()
    rdap_org = _extract_rdap_org(rdap_data)
    if not org and rdap_org:
        org = rdap_org

    provider = _clean_provider(org) if org else rdap_org
    abuse_email = _extract_abuse_email(ipinfo_data) or _extract_rdap_abuse_email(rdap_data)
    country = str(ipinfo_data.get("country", "") or "").strip()
    region = str(ipinfo_data.get("region", "") or "").strip()
    city = str(ipinfo_data.get("city", "") or "").strip()
    resolved_hostname = str(ipinfo_data.get("hostname", "") or hostname).strip() or hostname
    whois_raw = _serialize_whois_payload(rdap_data)

    return ProviderInfo(
        stream_url=stream_url,
        ip=ip,
        hostname=resolved_hostname,
        org=org,
        provider=provider,
        country=country,
        region=region,
        city=city,
        abuse_email=abuse_email,
        whois_raw=whois_raw,
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
    seen_hosts: dict[str, ProviderInfo] = {}
    results: list[ProviderInfo] = []

    for url in stream_urls:
        hostname = urlparse(url).hostname or ""
        host_key = hostname.strip().lower()
        cached = seen_hosts.get(host_key) if host_key else None
        if cached is not None:
            results.append(cached.model_copy(update={"stream_url": url}))
            continue

        info = lookup_stream_url(url, ipinfo_token=ipinfo_token)
        if host_key:
            seen_hosts[host_key] = info.model_copy()

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


def _lookup_rdap(ip: str) -> dict:
    """Best-effort RDAP lookup for Whois-style ownership/contact data."""
    try:
        resp = httpx.get(f"{RDAP_BASE}/{ip}", timeout=TIMEOUT, follow_redirects=True)
        resp.raise_for_status()
        payload = resp.json()
        return payload if isinstance(payload, dict) else {}
    except httpx.HTTPError as exc:
        logger.debug("RDAP request failed for %s: %s", ip, exc)
        return {}


def _iter_rdap_entities(payload: dict) -> list[dict]:
    stack = list(payload.get("entities", []) if isinstance(payload, dict) else [])
    entities: list[dict] = []
    while stack:
        entity = stack.pop(0)
        if not isinstance(entity, dict):
            continue
        entities.append(entity)
        nested = entity.get("entities", [])
        if isinstance(nested, list) and nested:
            stack.extend(nested)
    return entities


def _vcard_values(entity: dict, property_name: str) -> list[str]:
    vcard = entity.get("vcardArray")
    if not (isinstance(vcard, list) and len(vcard) >= 2 and isinstance(vcard[1], list)):
        return []
    values: list[str] = []
    for row in vcard[1]:
        if not (isinstance(row, list) and len(row) >= 4):
            continue
        if str(row[0] or "").strip().lower() != property_name.lower():
            continue
        value = str(row[3] or "").strip()
        if value:
            values.append(value)
    return values


def _extract_rdap_abuse_email(payload: dict) -> str:
    abuse_candidates: list[str] = []
    generic_candidates: list[str] = []
    for entity in _iter_rdap_entities(payload):
        emails = _vcard_values(entity, "email")
        if not emails:
            continue
        roles = {
            str(role or "").strip().lower()
            for role in entity.get("roles", [])
            if isinstance(role, str)
        }
        if "abuse" in roles:
            abuse_candidates.extend(emails)
        generic_candidates.extend(emails)
    for candidate in [*abuse_candidates, *generic_candidates]:
        if "@" in candidate:
            return candidate
    return ""


def _extract_rdap_org(payload: dict) -> str:
    top_level_name = str(payload.get("name", "") or "").strip()
    if top_level_name:
        return top_level_name
    for entity in _iter_rdap_entities(payload):
        for property_name in ("fn", "org"):
            values = _vcard_values(entity, property_name)
            if values:
                return values[0]
    return ""


def _serialize_whois_payload(payload: dict) -> str:
    if not payload:
        return ""
    try:
        return json.dumps(payload, ensure_ascii=False)[:12000]
    except Exception:
        return ""
