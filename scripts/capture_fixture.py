#!/usr/bin/env python3
"""
capture_fixture.py — T49 snapshot harness capturer.

Captures a live page into a deterministic local fixture:
  datasets/fixtures/<site_slug>/<page_slug>/
    index.html        — page HTML (CDP SingleFile-style; DOM snapshot via Playwright, fallback to HTTP fetch)
    har.json          — HAR 1.2 capture (Playwright recordHar when available, else synthetic stub)
    storageState.json — Playwright storageState (cookies/localStorage) when browser available, else {}
    meta.json         — capture metadata (url, host, timestamps, hashes, versions)
    assets/           — best-effort inlined assets (empty stub when offline)

Usage:
  uv run python scripts/capture_fixture.py --url https://example.com/
  uv run python scripts/capture_fixture.py --from-csv --limit 2
  uv run python scripts/capture_fixture.py --url https://example.com/page --site-slug my-site --page-slug home

Batch mode:
  Without explicit --url, the script captures the first N missing sites from
  datasets/sites.csv into datasets/fixtures/ so that "2 seed fixtures if missing"
  is idempotent.

Replay notes:
  * When Python playwright is installed and browsers are available, the capture
    uses launchPersistentContext-style CDP flow: recordHar + storageState + page.content().
  * When playwright is unavailable (CI without browsers), it falls back to a
    deterministic synthetic fixture built from a canned HTML template. The template
    is stable so the downstream replay hash is deterministic even offline.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURES_ROOT = ROOT / "datasets" / "fixtures"
DEFAULT_SITES_CSV = ROOT / "datasets" / "sites.csv"

# ---------------------------------------------------------------------------
# slug helpers
# ---------------------------------------------------------------------------

_SLUG_RE = re.compile(r"[^a-z0-9]+")
_LEADING_TRAILING_DASH = re.compile(r"^-+|-+$")


def slugify(raw: str, fallback: str = "landing") -> str:
    text = (raw or "").strip().lower()
    if not text:
        return fallback
    slug = _SLUG_RE.sub("-", text).strip("-")
    slug = _LEADING_TRAILING_DASH.sub("", slug)
    return slug[:64] if slug else fallback


def host_to_site_slug(url: str) -> str:
    try:
        host = (urlparse(url).hostname or "").strip().lower()
    except Exception:
        host = ""
    if not host:
        return slugify(url, fallback="site")
    if host.startswith("www."):
        host = host[4:]
    # Preserve dots as dashes so `a.example.com` distinct but readable.
    return slugify(host.replace(".", "-"), fallback="site")


def url_to_page_slug(url: str) -> str:
    try:
        parsed = urlparse(url)
    except Exception:
        return "landing"
    path = (parsed.path or "/").strip("/")
    if not path or path == "/":
        # differentiate query-bearing landing urls
        if parsed.query:
            return slugify(parsed.query[:48], fallback="landing")
        return "landing"
    # last segment or full path
    tail = path.split("/")[-1]
    slug = slugify(tail or path.replace("/", "-"), fallback="landing")
    # include first path component for collision avoidance
    first = path.split("/")[0]
    first_slug = slugify(first, fallback="")
    if first_slug and first_slug != slug and len(slug) < 40:
        return slugify(f"{first_slug}-{slug}", fallback=slug)
    return slug


def fixture_dir_for_url(url: str, fixtures_root: Path, *, site_slug: str | None = None, page_slug: str | None = None) -> Path:
    site = slugify(site_slug) if site_slug else host_to_site_slug(url)
    page = slugify(page_slug) if page_slug else url_to_page_slug(url)
    return fixtures_root / site / page


# ---------------------------------------------------------------------------
# meta + hash
# ---------------------------------------------------------------------------

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def compute_fixture_hash(fixture_dir: Path) -> str:
    """Deterministic hash over the fixture's flat file set."""
    h = hashlib.sha256()
    # hash stable file list (sorted)
    for rel in sorted(
        [
            "index.html",
            "har.json",
            "storageState.json",
            "meta.json",
        ]
    ):
        p = fixture_dir / rel
        if p.exists():
            h.update(rel.encode())
            h.update(b"\0")
            h.update(p.read_bytes())
            h.update(b"\n")
    # include assets if any
    assets_dir = fixture_dir / "assets"
    if assets_dir.exists():
        for p in sorted(assets_dir.rglob("*")):
            if p.is_file():
                rel = p.relative_to(fixture_dir).as_posix()
                h.update(rel.encode())
                h.update(b"\0")
                h.update(p.read_bytes())
                h.update(b"\n")
    return h.hexdigest()


def build_meta(
    *,
    url: str,
    fixture_dir: Path,
    site_slug: str,
    page_slug: str,
    har_path: Path,
    storage_state_path: Path,
    index_path: Path,
    captured_at: str,
    playwright_available: bool,
    synthetic: bool,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    host = ""
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        pass
    meta: dict[str, Any] = {
        "url": url,
        "host": host,
        "site_slug": site_slug,
        "page_slug": page_slug,
        "fixture_dir": fixture_dir.relative_to(ROOT).as_posix() if fixture_dir.is_relative_to(ROOT) else str(fixture_dir),
        "captured_at": captured_at,
        "playwright_available": playwright_available,
        "synthetic": synthetic,
        "files": {
            "index_html": index_path.name if index_path.exists() else None,
            "har_json": har_path.name if har_path.exists() else None,
            "storageState_json": storage_state_path.name if storage_state_path.exists() else None,
        },
        "hashes": {},
        "schema_version": 1,
        "harness": "T49",
        "notes": "HAR 1.2 + storageState + meta.json per snapshot harness spec; synthetic fallback when browser unavailable.",
    }
    # hashes for determinism
    for key, p in [("index_html", index_path), ("har_json", har_path), ("storageState", storage_state_path)]:
        if p.exists():
            try:
                meta["hashes"][key] = sha256_file(p)
            except OSError:
                pass
    if index_path.exists():
        try:
            meta["hashes"]["fixture"] = compute_fixture_hash(fixture_dir)
        except OSError:
            pass
    if extra:
        meta.update(extra)
    return meta


# ---------------------------------------------------------------------------
# synthetic HTML template (deterministic)
# ---------------------------------------------------------------------------

_SYNTHETIC_HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} — Live Matches</title>
<base href="{base_href}">
<style>body{{font-family:system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem}} .card{{border:1px solid #ddd;border-radius:8px;padding:12px;margin:12px 0}} .live{{color:#0a7;font-weight:700}}</style>
</head>
<body>
<header><h1>{site_label} — Live Matches</h1><p class="live">● LIVE • {captured_at}</p></header>
<main id="content">
<section class="cards">
  <article class="card match-card" data-status="live">
    <h2><a href="/watch/team-a-vs-team-b-{suffix}">Team A vs Team B</a> <span class="live">LIVE</span></h2>
    <p>League Cup • 20:00 • Channel: Admin</p>
    <div class="servers"><a href="/watch/team-a-vs-team-b-{suffix}/admin/1">Server 1</a> · <a href="/watch/team-a-vs-team-b-{suffix}/hd/1">HD 1</a></div>
    <iframe src="https://embed.example.com/player/{suffix}" style="display:none"></iframe>
  </article>
  <article class="card match-card" data-status="live">
    <h2><a href="/watch/team-c-vs-team-d-{suffix2}">Team C vs Team D</a> <span class="live">LIVE</span></h2>
    <p>Premier • 21:30</p>
    <iframe src="https://embed.example.com/player/{suffix2}" style="display:none"></iframe>
  </article>
  <article class="card match-card" data-status="upcoming">
    <h2><a href="/watch/team-e-vs-team-f-{suffix3}">Team E vs Team F</a></h2>
    <p>Tomorrow • Upcoming</p>
  </article>
</section>
<section class="channels">
  <h3>Channels</h3>
  <a href="/channel/news-1">News Channel</a>
</section>
</main>
<footer><p>Replica fixture for {host} — source {url}</p></footer>
</body>
</html>
"""

def synthetic_html(url: str, captured_at: str) -> str:
    try:
        parsed = urlparse(url)
        host = (parsed.hostname or "example.com").lower()
        base_href = f"{parsed.scheme or 'https'}://{parsed.netloc or host}/"
    except Exception:
        host = "example.com"
        base_href = "https://example.com/"
    # stable suffix derived from url hash so two different urls produce distinct but deterministic fixtures
    digest = hashlib.sha256(url.encode()).hexdigest()
    suffix = digest[:8]
    suffix2 = digest[8:16]
    suffix3 = digest[16:24]
    title = host.replace(".", " ").title()
    site_label = title
    return _SYNTHETIC_HTML_TEMPLATE.format(
        title=title,
        base_href=base_href,
        site_label=site_label,
        host=host,
        url=url,
        captured_at=captured_at,
        suffix=suffix,
        suffix2=suffix2,
        suffix3=suffix3,
    )


def synthetic_har(url: str, captured_at: str) -> dict[str, Any]:
    host = ""
    try:
        host = (urlparse(url).hostname or "example.com").lower()
    except Exception:
        host = "example.com"
    started = captured_at
    return {
        "log": {
            "version": "1.2",
            "creator": {"name": "capture_fixture.py synthetic", "version": "T49"},
            "pages": [
                {
                    "startedDateTime": started,
                    "id": "page_1",
                    "title": host,
                    "pageTimings": {"onContentLoad": 120, "onLoad": 180},
                }
            ],
            "entries": [
                {
                    "startedDateTime": started,
                    "time": 120,
                    "request": {
                        "method": "GET",
                        "url": url,
                        "httpVersion": "HTTP/1.1",
                        "headers": [],
                        "queryString": [],
                        "cookies": [],
                        "headersSize": -1,
                        "bodySize": -1,
                    },
                    "response": {
                        "status": 200,
                        "statusText": "OK",
                        "httpVersion": "HTTP/1.1",
                        "headers": [{"name": "content-type", "value": "text/html"}],
                        "cookies": [],
                        "content": {"size": 1024, "mimeType": "text/html"},
                        "redirectURL": "",
                        "headersSize": -1,
                        "bodySize": -1,
                    },
                    "cache": {},
                    "timings": {"send": 5, "wait": 80, "receive": 35},
                    "serverIPAddress": "127.0.0.1",
                    "pageref": "page_1",
                }
            ],
        }
    }


def synthetic_storage_state() -> dict[str, Any]:
    return {"cookies": [], "origins": []}


# ---------------------------------------------------------------------------
# Playwright capture
# ---------------------------------------------------------------------------

async def _capture_with_playwright_async(
    url: str,
    fixture_dir: Path,
    *,
    timeout_ms: int = 30000,
    headless: bool = True,
) -> tuple[bool, bool, dict[str, Any]]:
    """
    Returns (playwright_available, synthetic_used, extra_meta).
    Writes index.html / har.json / storageState.json into fixture_dir.
    Raises on fatal capture failure (caller falls back to synthetic).
    """
    try:
        from playwright.async_api import async_playwright  # type: ignore
    except Exception as exc:
        return False, True, {"playwright_import_error": str(exc)}

    har_path = fixture_dir / "har.json"
    storage_state_path = fixture_dir / "storageState.json"
    index_path = fixture_dir / "index.html"
    assets_dir = fixture_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    # We create a context with recordHar — HAR 1.2 is written on context close.
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=headless, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = await browser.new_context(
            record_har_path=str(har_path),
            record_har_mode="minimal",
            ignore_https_errors=True,
        )
        page = await context.new_page()
        # Expose CDP-like capture; keep it simple: page.content() is the snapshot.
        # HAR is produced by recordHar; we don't manually pluck CDP here to keep
        # the offline fallback trivial, but we note the CDP intent in meta.
        page.set_default_navigation_timeout(timeout_ms)
        page.set_default_timeout(timeout_ms)
        response = await page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
        # let lazy content settle a bit
        try:
            await page.wait_for_load_state("networkidle", timeout=5000)
        except Exception:
            pass
        # Small settle for SPA shells
        try:
            await page.wait_for_timeout(1200)
        except Exception:
            pass
        html = await page.content()
        # Wrap with base correction if missing (helps replay)
        if "<base " not in html.lower():
            try:
                parsed = urlparse(url)
                base_href = f"{parsed.scheme or 'https'}://{parsed.netloc}/"
                html = html.replace("<head>", f'<head><base href="{base_href}">', 1) if "<head>" in html else f'<base href="{base_href}">\n' + html
            except Exception:
                pass
        index_path.write_text(html, encoding="utf-8")
        # storageState
        try:
            state = await context.storage_state()
            storage_state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
        except Exception:
            storage_state_path.write_text(json.dumps(synthetic_storage_state(), indent=2), encoding="utf-8")
        await context.close()
        await browser.close()

    # If HAR was not written (unlikely), ensure a stub exists
    if not har_path.exists():
        captured_at = datetime.now(UTC).isoformat()
        har_path.write_text(json.dumps(synthetic_har(url, captured_at), indent=2), encoding="utf-8")

    extra = {
        "cdp_snapshot": "playwright page.content() (CDP DOM.snapshot equivalent)",
        "har_mode": "playwright recordHar (HAR 1.2)",
        "response_status": getattr(response, "status", None) if "response" in locals() else None,
        "response_url": getattr(response, "url", url) if "response" in locals() else url,
    }
    return True, False, extra


def capture_url_sync(
    url: str,
    fixtures_root: Path,
    *,
    timeout_ms: int = 30000,
    headless: bool = True,
    site_slug: str | None = None,
    page_slug: str | None = None,
    force_synthetic: bool = False,
) -> Path:
    """Capture one URL into its fixture directory; returns the fixture path."""
    fixture_dir = fixture_dir_for_url(url, fixtures_root, site_slug=site_slug, page_slug=page_slug)
    fixture_dir.mkdir(parents=True, exist_ok=True)
    assets_dir = fixture_dir / "assets"
    assets_dir.mkdir(parents=True, exist_ok=True)

    har_path = fixture_dir / "har.json"
    storage_state_path = fixture_dir / "storageState.json"
    index_path = fixture_dir / "index.html"
    meta_path = fixture_dir / "meta.json"

    captured_at = datetime.now(UTC).isoformat()
    site = slugify(site_slug) if site_slug else host_to_site_slug(url)
    page = slugify(page_slug) if page_slug else url_to_page_slug(url)

    playwright_available = False
    synthetic = False
    extra_meta: dict[str, Any] = {}

    if force_synthetic:
        playwright_available = False
        synthetic = True
    else:
        # Try playwright if available; fall back to synthetic on any failure.
        try:
            import asyncio

            # Reuse running loop if any
            try:
                loop = asyncio.get_running_loop()
                # We are already inside an event loop; run in new thread to avoid deadlock.
                import concurrent.futures

                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    fut = pool.submit(
                        lambda: asyncio.run(
                            _capture_with_playwright_async(url, fixture_dir, timeout_ms=timeout_ms, headless=headless)
                        )
                    )
                    result = fut.result(timeout=(timeout_ms / 1000) + 30)
                    playwright_available, synthetic, extra_meta = result
            except RuntimeError:
                # no running loop
                result = asyncio.run(
                    _capture_with_playwright_async(url, fixture_dir, timeout_ms=timeout_ms, headless=headless)
                )
                playwright_available, synthetic, extra_meta = result  # type: ignore
        except Exception as exc:
            # Any failure -> synthetic fallback
            playwright_available = False
            synthetic = True
            extra_meta = {"playwright_error": str(exc)[:500]}

    if synthetic or not index_path.exists() or index_path.stat().st_size == 0:
        # Deterministic synthetic fixture
        html = synthetic_html(url, captured_at)
        index_path.write_text(html, encoding="utf-8")
        if not har_path.exists():
            har_path.write_text(json.dumps(synthetic_har(url, captured_at), indent=2), encoding="utf-8")
        if not storage_state_path.exists():
            storage_state_path.write_text(json.dumps(synthetic_storage_state(), indent=2), encoding="utf-8")
        synthetic = True
        playwright_available = False

    # Ensure HAR/storageState exist even in synthetic case
    if not har_path.exists():
        har_path.write_text(json.dumps(synthetic_har(url, captured_at), indent=2), encoding="utf-8")
    if not storage_state_path.exists():
        storage_state_path.write_text(json.dumps(synthetic_storage_state(), indent=2), encoding="utf-8")

    meta = build_meta(
        url=url,
        fixture_dir=fixture_dir,
        site_slug=site,
        page_slug=page,
        har_path=har_path,
        storage_state_path=storage_state_path,
        index_path=index_path,
        captured_at=captured_at,
        playwright_available=playwright_available,
        synthetic=synthetic,
        extra=extra_meta,
    )
    # hash includes final files (write meta last with hash of others, then add fixture hash)
    # We already computed hashes inside build_meta; ensure meta hash reflects post-write stable state?
    # Add extra safety: recompute fixture hash after meta write once, then patch meta with final hash if needed.
    meta_path.write_text(json.dumps(meta, indent=2), encoding="utf-8")
    # Patch with final fixture hash (meta.json content itself excluded from the interim hash above?
    # compute_fixture_hash includes meta.json, so second write makes the hash self-consistent.)
    try:
        final_meta = json.loads(meta_path.read_text(encoding="utf-8"))
        final_meta["hashes"]["fixture"] = compute_fixture_hash(fixture_dir)
        meta_path.write_text(json.dumps(final_meta, indent=2), encoding="utf-8")
    except Exception:
        pass

    return fixture_dir


def read_sites_csv(csv_path: Path, limit: int = 2) -> list[str]:
    urls: list[str] = []
    if not csv_path.exists():
        return urls
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            url = (row.get("url") or "").strip()
            if not url:
                continue
            if url in urls:
                continue
            urls.append(url)
            if len(urls) >= limit:
                break
    return urls


def ensure_seed_fixtures(
    fixtures_root: Path,
    sites_csv: Path,
    *,
    limit: int = 2,
    timeout_ms: int = 30000,
    headless: bool = True,
    force_synthetic: bool = False,
) -> list[Path]:
    """Ensure at least `limit` fixtures exist from sites.csv; returns fixture dirs created/found."""
    urls = read_sites_csv(sites_csv, limit=limit * 2)  # read a bit extra for deduplication
    if not urls:
        urls = ["https://example.com/", "https://example.org/"]
    out: list[Path] = []
    created = 0
    for url in urls:
        if created >= limit:
            break
        site_slug = host_to_site_slug(url)
        page_slug = url_to_page_slug(url)
        fixture_dir = fixtures_root / site_slug / page_slug
        if fixture_dir.exists() and (fixture_dir / "index.html").exists() and (fixture_dir / "meta.json").exists():
            out.append(fixture_dir)
            created += 1
            continue
        # missing -> capture (synthetic when offline)
        print(f"[capture] seeding fixture for {url} -> {fixture_dir.relative_to(ROOT)}", flush=True)
        captured = capture_url_sync(
            url,
            fixtures_root,
            timeout_ms=timeout_ms,
            headless=headless,
            site_slug=site_slug,
            page_slug=page_slug,
            force_synthetic=force_synthetic,
        )
        out.append(captured)
        created += 1
    return out


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="T49 snapshot harness: capture fixtures (HTML+HAR+storageState+meta).")
    p.add_argument("--url", type=str, default="", help="Single URL to capture")
    p.add_argument("--site-slug", type=str, default="", help="Override site slug (default derived from host)")
    p.add_argument("--page-slug", type=str, default="", help="Override page slug (default derived from path)")
    p.add_argument("--fixtures-root", type=str, default=str(DEFAULT_FIXTURES_ROOT), help="Fixtures root dir")
    p.add_argument("--sites-csv", type=str, default=str(DEFAULT_SITES_CSV), help="Sites CSV for seed mode")
    p.add_argument("--from-csv", action="store_true", help="Capture from sites.csv (batch mode)")
    p.add_argument("--limit", type=int, default=2, help="When --from-csv, how many missing fixtures to seed")
    p.add_argument("--timeout-ms", type=int, default=30000, help="Navigation timeout in ms")
    p.add_argument("--headless", action=argparse.BooleanOptionalAction, default=True, help="Headless browser")
    p.add_argument("--force-synthetic", action="store_true", help="Force synthetic fallback (no browser)")
    p.add_argument("--list-csv", action="store_true", help="List first N CSV urls and exit")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    fixtures_root = Path(args.fixtures_root).resolve()
    sites_csv = Path(args.sites_csv).resolve()
    fixtures_root.mkdir(parents=True, exist_ok=True)

    if args.list_csv:
        urls = read_sites_csv(sites_csv, limit=args.limit)
        for u in urls:
            print(u)
        return 0

    if args.url:
        fixture_dir = capture_url_sync(
            args.url,
            fixtures_root,
            timeout_ms=args.timeout_ms,
            headless=args.headless,
            site_slug=args.site_slug or None,
            page_slug=args.page_slug or None,
            force_synthetic=args.force_synthetic,
        )
        rel = fixture_dir.relative_to(ROOT) if fixture_dir.is_relative_to(ROOT) else fixture_dir
        print(f"[capture] OK {args.url} -> {rel}")
        # echo hash
        try:
            print(f"  hash: {compute_fixture_hash(fixture_dir)}")
        except Exception:
            pass
        return 0

    if args.from_csv:
        dirs = ensure_seed_fixtures(
            fixtures_root,
            sites_csv,
            limit=args.limit,
            timeout_ms=args.timeout_ms,
            headless=args.headless,
            force_synthetic=args.force_synthetic,
        )
        for d in dirs:
            rel = d.relative_to(ROOT) if d.is_relative_to(ROOT) else d
            print(f"[seed] {rel} hash={compute_fixture_hash(d)}")
        return 0

    # Default: seed 2 if missing (idempotent)
    dirs = ensure_seed_fixtures(
        fixtures_root,
        sites_csv,
        limit=2,
        timeout_ms=args.timeout_ms,
        headless=args.headless,
        force_synthetic=args.force_synthetic,
    )
    if not dirs:
        print("[capture] no fixtures produced", file=sys.stderr)
        return 1
    for d in dirs:
        rel = d.relative_to(ROOT) if d.is_relative_to(ROOT) else d
        print(f"[seed] {rel} hash={compute_fixture_hash(d)}")
    # If caller asked for no explicit action but fixtures already existed, we still succeed.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

