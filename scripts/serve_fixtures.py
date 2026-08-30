#!/usr/bin/env python3
"""
serve_fixtures.py — T49 snapshot harness static server with Host-header routing
and helper for Chrome --host-resolver-rules injection via the existing
extra_launch_args bridge (data/browser.runtime.json).

Routing model:
  datasets/fixtures/<site_slug>/<page_slug>/
    index.html, har.json, storageState.json, meta.json, assets/...

At runtime the server binds 127.0.0.1:<port>. Chrome is told
  --host-resolver-rules="MAP <fixture-host> 127.0.0.1:<port>, MAP *.<fixture-host> 127.0.0.1:<port>, EXCLUDE localhost,EXCLUDE 127.0.0.1"
so a request to https://<fixture-host>/ still arrives at the harness with
Host: <fixture-host>. The handler maps Host -> fixture directory and serves
the snapshot. See build_host_resolver_rules() and inject_bridge().

This server is intentionally read-only and runs without external deps.

Usage:
  # start host-routed server
  uv run python scripts/serve_fixtures.py --port 8765

  # print the rules string (paste into extra_launch_args or let --inject do it)
  uv run python scripts/serve_fixtures.py --port 8765 --print-rules

  # inject rules into data/browser.runtime.json (existing extra_launch_args bridge)
  uv run python scripts/serve_fixtures.py --port 8765 --inject

  # clear injected rules
  uv run python scripts/serve_fixtures.py --clear --bridge-path data/browser.runtime.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_FIXTURES_ROOT = ROOT / "datasets" / "fixtures"
DEFAULT_BRIDGE_PATH = ROOT / "data" / "browser.runtime.json"
DEFAULT_PORT = 8765
DEFAULT_HOST = "127.0.0.1"

_HOST_RESOLVER_PREFIX = "--host-resolver-rules="
_HOST_RESOLVER_TAG = "T49-fixture-harness"


def host_to_site_slug(host: str) -> str:
    raw = (host or "").strip().lower()
    if raw.startswith("www."):
        raw = raw[4:]
    slug = re.sub(r"[^a-z0-9]+", "-", raw.replace(".", "-")).strip("-")
    return slug[:64] if slug else "site"


# ---------------------------------------------------------------------------
# Fixture discovery
# ---------------------------------------------------------------------------

def discover_fixtures(fixtures_root: Path) -> dict[str, Path]:
    """
    Returns host -> fixture_dir map.

    Prefers meta.json host field; falls back to directory name (site_slug).
    For <site>/<page> nesting, the parent site slug is considered one fixture
    host; both direct children and nested page dirs are indexed. The map keys
    are lower-cased hostnames without port.
    """
    out: dict[str, Path] = {}
    if not fixtures_root.exists():
        return out
    # Walk meta.json files (depth 2-3)
    for meta_path in fixtures_root.rglob("meta.json"):
        try:
            data = json.loads(meta_path.read_text(encoding="utf-8"))
            host = str(data.get("host") or "").strip().lower()
            fixture_dir = meta_path.parent
            if host:
                # host key exact
                if host not in out:
                    out[host] = fixture_dir
                # also map with-www variant for convenience
                if not host.startswith("www."):
                    w = f"www.{host}"
                    if w not in out:
                        out[w] = fixture_dir
            # also map site_slug fallback
            site_slug = str(data.get("site_slug") or fixture_dir.parent.name).strip().lower()
            # Try to register site_slug-derived host? Not reliable. Skip.
            # Keep directory-name mapping for synthetic hosts like example.com where slug == host-with-dashes
            # We already have host mapping above; no need to guess.
        except Exception:
            continue
    # Also ensure every top-level site dir (even without host) is reachable via slug-host
    # Synthetic example: site_slug "istreameast-app" came from host "istreameast.app" — map that slug back via dash->dot
    for site_dir in fixtures_root.iterdir():
        if not site_dir.is_dir():
            continue
        slug = site_dir.name.lower()
        guessed_host = slug.replace("-", ".")  # heuristic for synthetic; real fixtures already mapped via meta
        # Only add if not already present and at least one child fixture exists
        has_child = any((site_dir / child / "index.html").exists() or (site_dir / child / "meta.json").exists() for child in [p.name for p in site_dir.iterdir() if p.is_dir()]) or (site_dir / "index.html").exists()
        if guessed_host and guessed_host not in out and has_child:
            # Prefer the first page dir if nested
            first_page = None
            for child in sorted(site_dir.iterdir()):
                if child.is_dir() and (child / "index.html").exists():
                    first_page = child
                    break
            if first_page is not None:
                out[guessed_host] = first_page
                if not guessed_host.startswith("www."):
                    w = f"www.{guessed_host}"
                    if w not in out:
                        out[w] = first_page
            elif (site_dir / "index.html").exists():
                out[guessed_host] = site_dir
    return out


def list_fixture_hosts(fixtures_root: Path) -> list[str]:
    return sorted(discover_fixtures(fixtures_root).keys())


# ---------------------------------------------------------------------------
# Host resolver rules + bridge
# ---------------------------------------------------------------------------

def build_host_resolver_rules(
    fixtures_root: Path,
    port: int,
    *,
    hosts: list[str] | None = None,
    include_wildcard: bool = True,
) -> str:
    """
    Build a Chrome --host-resolver-rules value for the current fixtures.

    Example (port 8765):
      MAP istreameast.app 127.0.0.1:8765, MAP *.istreameast.app 127.0.0.1:8765, EXCLUDE localhost, EXCLUDE 127.0.0.1
    Returned string does NOT include the --host-resolver-rules= prefix.
    """
    if hosts is None:
        host_map = discover_fixtures(fixtures_root)
        hosts = sorted(host_map.keys())
    dedup: list[str] = []
    seen: set[str] = set()
    for h in hosts or []:
        name = (h or "").strip().lower()
        if not name or name in seen:
            continue
        seen.add(name)
        dedup.append(name)
    if not dedup:
        # still need a safe rule so Chrome flag is syntactically valid when fixtures missing
        return f"MAP example.com 127.0.0.1:{port}, EXCLUDE localhost, EXCLUDE 127.0.0.1"
    parts: list[str] = []
    for h in dedup:
        parts.append(f"MAP {h} 127.0.0.1:{port}")
        if include_wildcard:
            # Chrome understands MAP *.host for subdomains
            parts.append(f"MAP *.{h} 127.0.0.1:{port}")
    # Always exclude loopback so healthchecks keep working
    parts.append("EXCLUDE localhost")
    parts.append("EXCLUDE 127.0.0.1")
    return ", ".join(parts)


def build_extra_launch_arg(fixtures_root: Path, port: int, *, hosts: list[str] | None = None) -> str:
    rules = build_host_resolver_rules(fixtures_root, port, hosts=hosts)
    return f"{_HOST_RESOLVER_PREFIX}{rules}"


def read_bridge(bridge_path: Path) -> dict[str, Any]:
    if not bridge_path.exists():
        return {}
    try:
        return json.loads(bridge_path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_bridge(bridge_path: Path, payload: dict[str, Any]) -> None:
    bridge_path.parent.mkdir(parents=True, exist_ok=True)
    bridge_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def inject_host_resolver_rules(
    bridge_path: Path,
    fixtures_root: Path,
    port: int,
    *,
    hosts: list[str] | None = None,
) -> str:
    """
    Inject (or replace) the T49 host-resolver-rules entry into browser.runtime.json.

    Returns the injected arg string.
    """
    arg = build_extra_launch_arg(fixtures_root, port, hosts=hosts)
    payload = read_bridge(bridge_path)
    # Normalize structure: payload.browser_runtime.playwright.extra_launch_args is the canonical path
    # Keep legacy top-level extra_launch_args handling no-op.
    browser_runtime = payload.get("browser_runtime")
    if not isinstance(browser_runtime, dict):
        browser_runtime = {}
        payload["browser_runtime"] = browser_runtime
    playwright_cfg = browser_runtime.get("playwright")
    if not isinstance(playwright_cfg, dict):
        playwright_cfg = {}
        browser_runtime["playwright"] = playwright_cfg
    extra = playwright_cfg.get("extra_launch_args")
    if not isinstance(extra, list):
        extra = []
    # Remove any previous T49-injected rule or any prior host-resolver-rules entry
    cleaned: list[str] = []
    for item in extra:
        s = str(item).strip()
        if not s:
            continue
        if s.startswith(_HOST_RESOLVER_PREFIX):
            # drop previous injection (whether ours or manual) — we replace with fresh one
            continue
        cleaned.append(s)
    cleaned.append(arg)
    playwright_cfg["extra_launch_args"] = cleaned
    # preserve other top-level keys, ensure engine hint
    if not payload.get("browser_engine"):
        payload["browser_engine"] = "playwright"
    write_bridge(bridge_path, payload)
    return arg


def clear_host_resolver_rules(bridge_path: Path) -> bool:
    """Remove injected --host-resolver-rules entries from the bridge. Returns True if changed."""
    if not bridge_path.exists():
        return False
    payload = read_bridge(bridge_path)
    browser_runtime = payload.get("browser_runtime")
    if not isinstance(browser_runtime, dict):
        return False
    playwright_cfg = browser_runtime.get("playwright")
    if not isinstance(playwright_cfg, dict):
        return False
    extra = playwright_cfg.get("extra_launch_args")
    if not isinstance(extra, list):
        return False
    filtered = [str(x).strip() for x in extra if str(x).strip() and not str(x).strip().startswith(_HOST_RESOLVER_PREFIX)]
    if len(filtered) == len([s for s in extra if str(s).strip()]):
        return False
    playwright_cfg["extra_launch_args"] = filtered
    write_bridge(bridge_path, payload)
    return True


def bridge_status(bridge_path: Path) -> dict[str, Any]:
    payload = read_bridge(bridge_path)
    browser_runtime = payload.get("browser_runtime") if isinstance(payload, dict) else None
    playwright_cfg = browser_runtime.get("playwright") if isinstance(browser_runtime, dict) else None
    extra = playwright_cfg.get("extra_launch_args") if isinstance(playwright_cfg, dict) else None
    resolver_args = [str(x) for x in (extra or []) if str(x).startswith(_HOST_RESOLVER_PREFIX)]
    return {
        "bridge_path": str(bridge_path.resolve()),
        "exists": bridge_path.exists(),
        "extra_launch_args": extra if isinstance(extra, list) else [],
        "host_resolver_args": resolver_args,
        "has_injection": bool(resolver_args),
    }


# ---------------------------------------------------------------------------
# Fixture hashing (matches capture_fixture.compute_fixture_hash)
# ---------------------------------------------------------------------------

def compute_fixture_hash(fixture_dir: Path) -> str:
    h = hashlib.sha256()
    for rel in sorted(["index.html", "har.json", "storageState.json", "meta.json"]):
        p = fixture_dir / rel
        if p.exists():
            h.update(rel.encode())
            h.update(b"\0")
            h.update(p.read_bytes())
            h.update(b"\n")
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


def compute_candidate_ledger_hash(html_text: str) -> str:
    """
    Deterministic ledger hash for landing candidates.

    Extracts hrefs that look like hosting routes (heuristic) and hashes the
    sorted unique set. The hash is stable across repeated serves of the same
    fixture (no timestamps, no randomness). This is what the T49 acceptance
    refers to as "identical candidate ledger hash" for classification+landing
    determinism.
    """
    hrefs = re.findall(r'href=["\']([^"\']+)["\']', html_text or "", flags=re.IGNORECASE)
    # normalize: keep only watch/live/channel candidates, strip query/hash, lower
    cands: set[str] = set()
    for raw in hrefs:
        t = raw.strip()
        if not t:
            continue
        # skip anchors, javascript, mailto
        low = t.lower()
        if low.startswith("#") or low.startswith("javascript:") or low.startswith("mailto:"):
            continue
        # keep interesting routes
        if any(k in low for k in ["/watch/", "/live/", "/channel/", "/embed/", "/player/", "server", ".m3u8", "stream"]):
            # normalize: strip fragment and query for determinism
            try:
                p = urlparse(t)
                norm = p.path.rstrip("/") or "/"
                if low.startswith("http"):
                    norm = f"{p.scheme}://{p.netloc}{norm}"
                cands.add(norm)
            except Exception:
                cands.add(t)
    sorted_cands = sorted(cands)
    h = hashlib.sha256(json.dumps(sorted_cands, sort_keys=True).encode()).hexdigest()
    return h


# ---------------------------------------------------------------------------
# HTTP handler (Host-header routing)
# ---------------------------------------------------------------------------

class HostRoutingHandler(BaseHTTPRequestHandler):
    fixtures_root: Path = DEFAULT_FIXTURES_ROOT
    host_map: dict[str, Path] = {}
    allow_listing: bool = True

    def log_message(self, format: str, *args: Any) -> None:
        # Quiet by default; print to stderr for diagnostics
        sys.stderr.write(f"[{self.log_date_time_string()}] {format % args}\n")

    def _host_key(self) -> str:
        raw = (self.headers.get("Host") or "").strip()
        if not raw:
            return ""
        # Strip port
        if ":" in raw and not raw.startswith("["):
            host = raw.split(":")[0].strip().lower()
        else:
            host = raw.strip().lower()
        return host

    def _fixture_for_host(self, host: str) -> Path | None:
        if not host:
            return None
        # Exact match
        key = host.lower()
        if key in self.host_map:
            return self.host_map[key]
        # www toggle
        if key.startswith("www."):
            bare = key[4:]
            if bare in self.host_map:
                return self.host_map[bare]
        else:
            with_www = f"www.{key}"
            if with_www in self.host_map:
                return self.host_map[with_www]
        # wildcard subdomain match: find longest suffix
        # e.g., host = sub.example.com -> try example.com
        if "." in key:
            # try stripping first label
            suffix = key.split(".", 1)[-1]
            if suffix in self.host_map:
                return self.host_map[suffix]
            # also try two-level tld handling not needed for this harness
        return None

    def _serve_file(self, file_path: Path) -> None:
        ctype, _ = mimetypes.guess_type(str(file_path))
        ctype = ctype or "application/octet-stream"
        # Special case: har.json should be json
        if file_path.suffix == ".json":
            ctype = "application/json"
        elif file_path.suffix == ".html":
            ctype = "text/html; charset=utf-8"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        # HAR proxy note: for stream/embedded pages the harness can also serve
        # HAR replay via Playwright routeFromHAR; the server itself is plain static.
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, indent=2).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, text: str, status: int = 200, ctype: str = "text/plain; charset=utf-8") -> None:
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        # Parse path without query
        raw_path = (self.path or "/").split("?")[0]
        raw_path = unquote(raw_path)
        # Special harness endpoints (host-independent)
        if raw_path in ("/__fixtures", "/__health", "/__hosts", "/__hash"):
            return self._handle_meta(raw_path)
        host = self._host_key()
        fixture_dir = self._fixture_for_host(host)
        # Fallback: when no Host header (curl without -H) or for localhost browsing,
        # if path looks like /__fixtures/... listing is still served; otherwise
        # return a helpful 404 with host map.
        if fixture_dir is None:
            if host in ("127.0.0.1", "localhost", "") and self.allow_listing and raw_path in ("/", "/index.html"):
                # Show fixture index for localhost browsing convenience
                return self._serve_listing()
            self.send_response(404)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.end_headers()
            body = json.dumps(
                {
                    "error": "no fixture for host",
                    "host": host,
                    "available_hosts": sorted(self.host_map.keys()),
                    "hint": f"curl -H 'Host: <fixture-host>' http://{DEFAULT_HOST}:{self.server.server_address[1]}{raw_path}",
                    "har_note": "HAR replay for stream/embedded pages is via Playwright routeFromHAR, not this server path.",
                },
                indent=2,
            ).encode()
            self.wfile.write(body)
            return

        # Resolve file within fixture_dir
        # Sanitize path: prevent traversal
        target = raw_path.lstrip("/")
        if not target or target in ("", "/"):
            target = "index.html"
        # directory request -> index.html
        if target.endswith("/"):
            target += "index.html"
        candidate = (fixture_dir / target).resolve()
        try:
            # Ensure candidate is under fixture_dir (or exactly fixture_dir for index fallback)
            fixture_resolved = fixture_dir.resolve()
            if not str(candidate).startswith(str(fixture_resolved)):
                raise ValueError("path traversal")
        except Exception:
            self.send_error(400, "bad path")
            return

        # If exact file exists, serve it
        if candidate.is_file():
            return self._serve_file(candidate)
        # Also try assets subfolder fallback (some fixtures reference /assets/*.js)
        alt = (fixture_dir / "assets" / target).resolve()
        try:
            if str(alt).startswith(str(fixture_dir.resolve())) and alt.is_file():
                return self._serve_file(alt)
        except Exception:
            pass
        # If request is extensionless /watch/... replay should still return index.html for SPA shell?
        # For determinism we 404 unless listing.
        # Special: if target is index.html missing but html exists at parent, 404
        self.send_response(404)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.end_headers()
        payload = {
            "error": "not found in fixture",
            "host": host,
            "fixture": str(fixture_dir.relative_to(ROOT)) if fixture_dir.is_relative_to(ROOT) else str(fixture_dir),
            "path": raw_path,
            "candidate": str(candidate),
        }
        self.wfile.write(json.dumps(payload, indent=2).encode())

    def do_HEAD(self) -> None:  # noqa: N802
        # Minimal HEAD support for probe reachability checks
        host = self._host_key()
        fixture_dir = self._fixture_for_host(host)
        if fixture_dir is None:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()

    def _handle_meta(self, raw_path: str) -> None:
        host = self._host_key()
        query = ""
        if "?" in self.path:
            query = self.path.split("?", 1)[1]
        params = {}
        for kv in (query.split("&") if query else []):
            if "=" in kv:
                k, v = kv.split("=", 1)
                params[unquote(k)] = unquote(v)
            elif kv:
                params[unquote(kv)] = ""
        if raw_path == "/__health":
            self._send_json({"ok": True, "fixtures_root": str(self.fixtures_root), "hosts": sorted(self.host_map.keys())})
        elif raw_path in ("/__fixtures", "/__hosts"):
            out = []
            for h, d in sorted(self.host_map.items()):
                rel = str(d.relative_to(ROOT)) if d.is_relative_to(ROOT) else str(d)
                out.append({"host": h, "fixture_dir": rel, "has_index": (d / "index.html").exists()})
            self._send_json({"hosts": out, "count": len(out)})
        elif raw_path == "/__hash":
            # Return deterministic hash for the fixture matched by Host (or by ?host= param)
            target_host = params.get("host") or host
            fixture_dir = self._fixture_for_host(target_host) if target_host else None
            # Also try direct host param fallback via discover map
            if fixture_dir is None and target_host:
                full_map = self.host_map
                # try exact
                fixture_dir = full_map.get(target_host.lower())
            if fixture_dir is None:
                self._send_json({"error": "no fixture for host", "host": target_host}, status=404)
                return
            try:
                h = compute_fixture_hash(fixture_dir)
                # also compute ledger hash from index.html
                html = (fixture_dir / "index.html").read_text(encoding="utf-8", errors="replace") if (fixture_dir / "index.html").exists() else ""
                ledger = compute_candidate_ledger_hash(html)
                self._send_json(
                    {
                        "host": target_host,
                        "fixture_dir": str(fixture_dir.relative_to(ROOT)) if fixture_dir.is_relative_to(ROOT) else str(fixture_dir),
                        "fixture_hash": h,
                        "candidate_ledger_hash": ledger,
                    }
                )
            except Exception as exc:
                self._send_json({"error": str(exc)}, status=500)

    def _serve_listing(self) -> None:
        lines = ["<html><head><title>Fixture harness</title></head><body>"]
        lines.append(f"<h1>Snapshot harness — {len(self.host_map)} fixture host(s)</h1>")
        lines.append(f"<p>Listening on {self.server.server_address[0]}:{self.server.server_address[1]} with Host-header routing.</p>")
        lines.append("<p>Use curl -H 'Host: &lt;fixture-host&gt;' to fetch a snapshot:</p>")
        lines.append("<ul>")
        for h, d in sorted(self.host_map.items()):
            rel = str(d.relative_to(ROOT)) if d.is_relative_to(ROOT) else str(d)
            lines.append(f'<li><code>{h}</code> → <code>{rel}</code> — '
                         f'<a href="/__hash?host={h}">hash</a> · '
                         f'<code>curl -H &#39;Host: {h}&#39; http://127.0.0.1:{self.server.server_address[1]}/</code></li>')
        lines.append("</ul>")
        lines.append("<h3>Bridge</h3>")
        lines.append("<p>host-resolver-rules is injected via <code>data/browser.runtime.json</code> "
                     "extra_launch_args (see build_host_resolver_rules / inject_bridge).</p>")
        lines.append("<p>HAR replay for stream/embedded pages is via <code>page.routeFromHAR()</code> — "
                     "point the Playwright context at <code>har.json</code> for those pages only.</p>")
        lines.append("</body></html>")
        self._send_text("\n".join(lines), ctype="text/html; charset=utf-8")


def make_server(
    fixtures_root: Path,
    port: int,
    host: str = DEFAULT_HOST,
) -> ThreadingHTTPServer:
    host_map = discover_fixtures(fixtures_root)

    class _Handler(HostRoutingHandler):
        pass

    _Handler.fixtures_root = fixtures_root  # type: ignore
    _Handler.host_map = host_map  # type: ignore

    # Allow port 0 for ephemeral
    server = ThreadingHTTPServer((host, port), _Handler)
    # Stash for introspection
    server.fixtures_root = fixtures_root  # type: ignore
    server.host_map = host_map  # type: ignore
    return server


def run_forever(fixtures_root: Path, port: int, host: str = DEFAULT_HOST) -> None:
    if not fixtures_root.exists():
        fixtures_root.mkdir(parents=True, exist_ok=True)
    host_map = discover_fixtures(fixtures_root)
    rules = build_host_resolver_rules(fixtures_root, port)
    arg = f"{_HOST_RESOLVER_PREFIX}{rules}"
    print(f"[serve] fixtures_root={fixtures_root}  hosts={len(host_map)}  {sorted(host_map.keys())[:5]}")
    print(f"[serve] listening on http://{host}:{port}/  (Host-header routing)")
    print(f"[serve] extra_launch_arg: {arg}")
    print(f"[serve] hint: uv run python scripts/serve_fixtures.py --port {port} --inject  # to write bridge")
    print(f"[serve] health: curl http://{host}:{port}/__health   fixtures: curl http://{host}:{port}/__fixtures")
    print(f"[serve] fetch: curl -H 'Host: example.com' http://{host}:{port}/")
    server = make_server(fixtures_root, port, host=host)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        print("[serve] stopped")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="T49 snapshot harness: Host-header static server + host-resolver-rules bridge.")
    p.add_argument("--fixtures-root", type=str, default=str(DEFAULT_FIXTURES_ROOT), help="Fixtures root dir")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help="Server port (0 = ephemeral, prints chosen port)")
    p.add_argument("--host", type=str, default=DEFAULT_HOST, help="Bind host (default 127.0.0.1)")
    p.add_argument("--bridge-path", type=str, default=str(DEFAULT_BRIDGE_PATH), help="Path to data/browser.runtime.json")
    p.add_argument("--print-rules", action="store_true", help="Print --host-resolver-rules value and exit")
    p.add_argument("--print-arg", action="store_true", help="Print full --host-resolver-rules=... arg and exit")
    p.add_argument("--inject", action="store_true", help="Inject host-resolver-rules into bridge and exit (or continue serving if also serving)")
    p.add_argument("--clear", action="store_true", help="Remove host-resolver-rules from bridge and exit")
    p.add_argument("--status", action="store_true", help="Print bridge status and exit")
    p.add_argument("--serve", action="store_true", help="Force serve mode (default when no other action flag)")
    # --hosts override for custom rules
    p.add_argument("--hosts", nargs="*", default=None, help="Override host list for rules (default: discover from fixtures)")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    fixtures_root = Path(args.fixtures_root).resolve()
    bridge_path = Path(args.bridge_path).resolve()

    # Actions that don't require serving
    if args.clear:
        changed = clear_host_resolver_rules(bridge_path)
        print(f"[bridge] clear {'done' if changed else 'no injection found'}  {bridge_path}")
        if not args.serve and not args.inject and not args.print_rules and not args.print_arg and not args.status:
            return 0

    if args.status:
        st = bridge_status(bridge_path)
        print(json.dumps(st, indent=2))
        if not args.serve and not args.inject and not args.print_rules and not args.print_arg:
            return 0

    if args.print_rules:
        rules = build_host_resolver_rules(fixtures_root, args.port, hosts=args.hosts)
        print(rules)
        if not args.serve and not args.inject and not args.print_arg:
            return 0

    if args.print_arg:
        arg = build_extra_launch_arg(fixtures_root, args.port, hosts=args.hosts)
        print(arg)
        if not args.serve and not args.inject:
            return 0

    if args.inject:
        arg = inject_host_resolver_rules(bridge_path, fixtures_root, args.port, hosts=args.hosts)
        print(f"[bridge] injected {arg!r} -> {bridge_path}")
        st = bridge_status(bridge_path)
        print(f"[bridge] extra_launch_args now: {st['extra_launch_args']}")
        if not args.serve and not args.print_rules and not args.print_arg:
            # inject-only mode still may fall through to serve if caller wants; by default exit after inject
            # But spec says --host-resolver-rules injection via extra_launch_args, so inject then serve is valid.
            # We exit here unless --serve explicitly requested.
            return 0

    # Decide serve vs exit
    wants_serve = args.serve or not (args.print_rules or args.print_arg or args.status or args.clear or (args.inject and not args.serve))
    # If only --inject was given, we already returned. So remaining path is serving.
    if wants_serve:
        # If port is 0, let OS pick and print it (useful for tests)
        run_forever(fixtures_root, args.port, host=args.host)
        return 0

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

