"""Optional Scrapling static link discovery.

Scrapling is distributed under the BSD-3-Clause license. It remains an
optional dependency here and is imported only when this pre-pass is enabled.
"""

from __future__ import annotations

from importlib import import_module
from typing import Final
from urllib.parse import urldefrag, urljoin, urlparse

_MAX_CANDIDATE_LINKS: Final = 100


def collect_static_candidate_links(url: str) -> list[str]:
    try:
        fetcher = import_module("scrapling.fetchers").Fetcher
    except ModuleNotFoundError:
        return []

    page = fetcher.get(url)
    if page.status >= 400:
        return []

    candidates: list[str] = []
    seen: set[str] = set()
    for raw_link in page.css("a::attr(href)").getall():
        link = str(raw_link).strip()
        if not link or link.startswith("#"):
            continue
        normalized, _fragment = urldefrag(urljoin(url, link))
        if urlparse(normalized).scheme not in {"http", "https"} or normalized in seen:
            continue
        seen.add(normalized)
        candidates.append(normalized)
        if len(candidates) >= _MAX_CANDIDATE_LINKS:
            break
    return candidates
