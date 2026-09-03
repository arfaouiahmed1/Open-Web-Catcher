"""Scrapling static page context collection (plan step 8).

Promotes Scrapling to an explicit bounded prepass lane for classification and
landing agents before opening full Playwright MCP contexts.

Scrapling is distributed under BSD-3-Clause and is imported lazily.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from importlib import import_module
from typing import Any, Final
from urllib.parse import urldefrag, urljoin, urlparse

_MAX_CANDIDATE_LINKS: Final = 100

FORBIDDEN_HOST_PATTERNS = [
  re.compile(r"^localhost$", re.IGNORECASE),
  re.compile(r"^127(?:\.\d+){3}$"),
  re.compile(r"^::1$"),
  re.compile(r"^169\.254\."),
  re.compile(r"^10\."),
  re.compile(r"^172\.(?:1[6-9]|2\d|3[01])\."),
  re.compile(r"^192\.168\."),
  re.compile(r"^metadata\.google\.internal$", re.IGNORECASE),
]


@dataclass
class StaticPrepassResult:
    """Structured output from the static prepass lane."""

    url: str
    status: str  # 'ok' | 'js_shell' | 'blocked' | 'error' | 'timeout' | 'empty'
    access_state: str  # 'open' | 'challenge' | 'blocked' | 'error'
    links: list[str] = field(default_factory=list)
    canonical_url: str | None = None
    forms: list[dict[str, Any]] = field(default_factory=list)
    iframes: list[str] = field(default_factory=list)
    scripts: list[str] = field(default_factory=list)
    visible_headings: list[str] = field(default_factory=list)
    candidate_url_patterns: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)
    bytes_fetched: int = 0
    fetch_duration_seconds: float = 0.0
    error: str | None = None


def is_safe_static_url(url: str) -> bool:
    """Check URL against forbidden schemes and private IP destinations."""
    try:
        parsed = urlparse(url.strip())
    except Exception:
        return False

    if parsed.scheme.lower() not in {"http", "https"}:
        return False

    hostname = (parsed.hostname or "").lower()
    if not hostname:
        return False

    for pattern in FORBIDDEN_HOST_PATTERNS:
        if pattern.search(hostname):
            return False

    return True


async def collect_static_page_context(
    url: str,
    *,
    timeout_seconds: float = 8.0,
    max_bytes: int = 2_000_000,
) -> StaticPrepassResult:
    """Collect page context via Scrapling AsyncFetcher before opening Playwright.

    Returns a StaticPrepassResult with links, iframes, headings, and access state.
    """
    start_time = time.perf_counter()

    if not is_safe_static_url(url):
        return StaticPrepassResult(
            url=url,
            status="blocked",
            access_state="blocked",
            error="Unsafe URL or private destination",
            fetch_duration_seconds=round(time.perf_counter() - start_time, 3),
        )

    try:
        fetchers_mod = import_module("scrapling.fetchers")
        AsyncFetcher = getattr(fetchers_mod, "AsyncFetcher", None)
        Fetcher = getattr(fetchers_mod, "Fetcher", None)
    except ModuleNotFoundError:
        return StaticPrepassResult(
            url=url,
            status="empty",
            access_state="open",
            error="Scrapling not installed",
            fetch_duration_seconds=round(time.perf_counter() - start_time, 3),
        )

    try:
        # Fetch asynchronously or in thread if AsyncFetcher unavailable
        if AsyncFetcher is not None and hasattr(AsyncFetcher, "get"):
            coro = AsyncFetcher.get(url, timeout=timeout_seconds)
            page = await asyncio.wait_for(coro, timeout=timeout_seconds)
        elif Fetcher is not None and hasattr(Fetcher, "get"):
            page = await asyncio.wait_for(
                asyncio.to_thread(Fetcher.get, url),
                timeout=timeout_seconds,
            )
        else:
            return StaticPrepassResult(
                url=url,
                status="empty",
                access_state="open",
                error="No suitable Scrapling fetcher found",
                fetch_duration_seconds=round(time.perf_counter() - start_time, 3),
            )
    except TimeoutError:
        return StaticPrepassResult(
            url=url,
            status="timeout",
            access_state="error",
            error=f"Static fetch timed out after {timeout_seconds}s",
            fetch_duration_seconds=round(time.perf_counter() - start_time, 3),
        )
    except Exception as exc:
        return StaticPrepassResult(
            url=url,
            status="error",
            access_state="error",
            error=str(exc),
            fetch_duration_seconds=round(time.perf_counter() - start_time, 3),
        )

    duration = round(time.perf_counter() - start_time, 3)

    http_status = getattr(page, "status", 200)
    if http_status in {403, 429, 451}:
        return StaticPrepassResult(
            url=url,
            status="blocked",
            access_state="blocked",
            error=f"HTTP {http_status}",
            fetch_duration_seconds=duration,
        )
    if http_status >= 400:
        return StaticPrepassResult(
            url=url,
            status="error",
            access_state="error",
            error=f"HTTP {http_status}",
            fetch_duration_seconds=duration,
        )

    # Check for challenge or captcha in text
    page_text = ""
    try:
        page_text = str(getattr(page, "text", "") or "")
    except Exception:
        pass

    challenge_signatures = ("cloudflare", "turnstile", "ddos-guard", "cf-challenge")
    if any(sig in page_text.lower() for sig in challenge_signatures):
        return StaticPrepassResult(
            url=url,
            status="blocked",
            access_state="challenge",
            fetch_duration_seconds=duration,
        )

    # Extract links
    candidates: list[str] = []
    seen: set[str] = set()
    try:
        raw_links = page.css("a::attr(href)").getall()
        for raw_link in raw_links:
            link = str(raw_link).strip()
            if not link or link.startswith("#"):
                continue
            normalized, _ = urldefrag(urljoin(url, link))
            if urlparse(normalized).scheme not in {"http", "https"} or normalized in seen:
                continue
            seen.add(normalized)
            candidates.append(normalized)
            if len(candidates) >= _MAX_CANDIDATE_LINKS:
                break
    except Exception:
        pass

    # Extract iframes
    iframes: list[str] = []
    try:
        raw_iframes = page.css("iframe::attr(src)").getall()
        for src in raw_iframes:
            if src and str(src).strip():
                iframes.append(urljoin(url, str(src).strip()))
    except Exception:
        pass

    # Extract headings
    headings: list[str] = []
    try:
        for h in page.css("h1, h2, h3").getall():
            text = re.sub(r"<[^>]+>", "", str(h)).strip()
            if text:
                headings.append(text[:120])
    except Exception:
        pass

    # Detect JS shell: minimal body text with multiple script tags
    scripts: list[str] = []
    try:
        scripts = [str(s) for s in page.css("script::attr(src)").getall() if s]
    except Exception:
        pass

    body_text_length = len(re.sub(r"\s+", "", page_text))
    if body_text_length < 150 and len(scripts) >= 2 and not candidates:
        status = "js_shell"
    elif candidates:
        status = "ok"
    else:
        status = "empty"

    return StaticPrepassResult(
        url=url,
        status=status,
        access_state="open",
        links=candidates,
        iframes=iframes,
        scripts=scripts,
        visible_headings=headings[:10],
        bytes_fetched=len(page_text.encode("utf-8")),
        fetch_duration_seconds=duration,
    )


def collect_static_candidate_links(url: str) -> list[str]:
    """Synchronous link collection for backward compatibility."""
    try:
        fetcher = import_module("scrapling.fetchers").Fetcher
    except ModuleNotFoundError:
        return []

    try:
        page = fetcher.get(url)
    except Exception:
        return []

    if getattr(page, "status", 200) >= 400:
        return []

    candidates: list[str] = []
    seen: set[str] = set()
    try:
        for raw_link in page.css("a::attr(href)").getall():
            link = str(raw_link).strip()
            if not link or link.startswith("#"):
                continue
            normalized, _ = urldefrag(urljoin(url, link))
            if urlparse(normalized).scheme not in {"http", "https"} or normalized in seen:
                continue
            seen.add(normalized)
            candidates.append(normalized)
            if len(candidates) >= _MAX_CANDIDATE_LINKS:
                break
    except Exception:
        pass
    return candidates
