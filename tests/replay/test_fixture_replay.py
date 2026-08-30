"""T49 replay tier — deterministic fixture harness checks.

Runs with `uv run pytest -m replay`. Even before full agent LLM replay is
wired, these tests enforce the snapshot harness contract:

* fixtures exist for 2 seed sites (datasets/fixtures/<site>/<page>/ with
  index.html, har.json, storageState.json, meta.json)
* serve_fixtures Host-header routing serves the correct snapshot
* host-resolver-rules bridge round-trips via data/browser.runtime.json
* fetching the same fixture twice yields identical hashes (determinism)
"""
from __future__ import annotations

import hashlib
import json
import re
import socket
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
FIXTURES_ROOT = ROOT / "datasets" / "fixtures"
BRIDGE_PATH = ROOT / "data" / "browser.runtime.json"

# Import harness helpers directly (no server start needed for unit parts)
try:
    import importlib.util

    spec = importlib.util.spec_from_file_location("serve_fixtures", str(ROOT / "scripts" / "serve_fixtures.py"))
    serve_fixtures = importlib.util.module_from_spec(spec)  # type: ignore
    assert spec and spec.loader
    spec.loader.exec_module(serve_fixtures)  # type: ignore
except Exception:
    serve_fixtures = None  # fallback — tests that need it will skip


def _fixture_dirs() -> list[Path]:
    if not FIXTURES_ROOT.exists():
        return []
    out: list[Path] = []
    for p in FIXTURES_ROOT.rglob("meta.json"):
        out.append(p.parent)
    return sorted(out)


@pytest.mark.replay
def test_seed_fixtures_exist():
    dirs = _fixture_dirs()
    assert len(dirs) >= 2, f"expected >=2 seed fixtures, found {len(dirs)} in {FIXTURES_ROOT}"
    for d in dirs[:2]:
        for name in ("index.html", "har.json", "storageState.json", "meta.json"):
            assert (d / name).exists(), f"missing {name} in {d}"
        meta = json.loads((d / "meta.json").read_text(encoding="utf-8"))
        assert meta.get("url"), "meta.json missing url"
        assert "hashes" in meta and "fixture" in meta["hashes"]
        # HAR is 1.2
        har = json.loads((d / "har.json").read_text(encoding="utf-8"))
        assert har.get("log", {}).get("version") == "1.2"


@pytest.mark.replay
def test_serve_fixtures_host_routing_deterministic():
    if serve_fixtures is None:
        pytest.skip("serve_fixtures module not importable")
    dirs = _fixture_dirs()
    if len(dirs) < 1:
        pytest.skip("no fixtures")
    # start ephemeral server
    server = serve_fixtures.make_server(FIXTURES_ROOT, 0, host="127.0.0.1")
    port = server.server_address[1]
    th = threading.Thread(target=server.serve_forever, daemon=True)
    th.start()
    time.sleep(0.3)
    try:
        host_map = serve_fixtures.discover_fixtures(FIXTURES_ROOT)
        assert host_map, "no hosts discovered"
        # pick first host
        first_host = sorted(host_map.keys())[0]
        fixture_dir = host_map[first_host]
        expected_bytes = (fixture_dir / "index.html").read_bytes()
        expected_ledger = serve_fixtures.compute_candidate_ledger_hash(expected_bytes.decode(errors="replace"))
        expected_hash = serve_fixtures.compute_fixture_hash(fixture_dir)

        def fetch(host: str) -> bytes:
            req = urllib.request.Request(f"http://127.0.0.1:{port}/", headers={"Host": host})
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.read()

        a = fetch(first_host)
        b = fetch(first_host)
        assert a == b == expected_bytes, "Host-routed fetch not deterministic / mismatch index.html"
        assert hashlib.sha256(a).hexdigest() == hashlib.sha256(expected_bytes).hexdigest()

        # via __hash endpoint
        req = urllib.request.Request(f"http://127.0.0.1:{port}/__hash?host={first_host}", headers={"Host": first_host})
        with urllib.request.urlopen(req, timeout=5) as resp:
            payload = json.loads(resp.read().decode())
        assert payload["fixture_hash"] == expected_hash
        assert payload["candidate_ledger_hash"] == expected_ledger

        # second fetch via endpoint matches
        req2 = urllib.request.Request(f"http://127.0.0.1:{port}/__hash?host={first_host}")
        with urllib.request.urlopen(req2, timeout=5) as resp:
            payload2 = json.loads(resp.read().decode())
        assert payload2["fixture_hash"] == payload["fixture_hash"]
        assert payload2["candidate_ledger_hash"] == expected_ledger

        # unknown host -> 404
        req_bad = urllib.request.Request(f"http://127.0.0.1:{port}/", headers={"Host": "unknown.example.invalid"})
        try:
            urllib.request.urlopen(req_bad, timeout=5)
            assert False, "expected 404 for unknown host"
        except urllib.error.HTTPError as exc:
            assert exc.code == 404
    finally:
        server.shutdown()
        server.server_close()
        th.join(timeout=2)


@pytest.mark.replay
def test_host_resolver_rules_bridge():
    if serve_fixtures is None:
        pytest.skip("serve_fixtures not importable")
    rules = serve_fixtures.build_host_resolver_rules(FIXTURES_ROOT, 8765)
    assert "MAP " in rules and "127.0.0.1:8765" in rules
    assert "EXCLUDE localhost" in rules
    arg = serve_fixtures.build_extra_launch_arg(FIXTURES_ROOT, 8765)
    assert arg.startswith("--host-resolver-rules=")

    # round-trip via temp bridge
    with tempfile.TemporaryDirectory() as tmp:
        bridge = Path(tmp) / "browser.runtime.json"
        bridge.write_text(json.dumps({"browser_engine": "playwright", "browser_runtime": {"playwright": {"extra_launch_args": []}}}), encoding="utf-8")
        injected = serve_fixtures.inject_host_resolver_rules(bridge, FIXTURES_ROOT, 8765)
        assert injected.startswith("--host-resolver-rules=")
        data = json.loads(bridge.read_text(encoding="utf-8"))
        extra = data["browser_runtime"]["playwright"]["extra_launch_args"]
        assert injected in extra
        # second inject replaces, not duplicates
        injected2 = serve_fixtures.inject_host_resolver_rules(bridge, FIXTURES_ROOT, 8766)
        data2 = json.loads(bridge.read_text(encoding="utf-8"))
        assert data2["browser_runtime"]["playwright"]["extra_launch_args"].count(injected2) == 1
        assert not any(v.startswith("--host-resolver-rules=") and v != injected2 for v in data2["browser_runtime"]["playwright"]["extra_launch_args"])
        cleared = serve_fixtures.clear_host_resolver_rules(bridge)
        assert cleared is True
        data3 = json.loads(bridge.read_text(encoding="utf-8"))
        assert not any(str(v).startswith("--host-resolver-rules=") for v in data3["browser_runtime"]["playwright"]["extra_launch_args"])


@pytest.mark.replay
def test_fixture_hash_deterministic_twice():
    if serve_fixtures is None:
        pytest.skip("serve_fixtures not importable")
    dirs = _fixture_dirs()
    if not dirs:
        pytest.skip("no fixtures")
    for d in dirs[:2]:
        h1 = serve_fixtures.compute_fixture_hash(d)
        h2 = serve_fixtures.compute_fixture_hash(d)
        assert h1 == h2
        html = (d / "index.html").read_text(encoding="utf-8", errors="replace")
        l1 = serve_fixtures.compute_candidate_ledger_hash(html)
        l2 = serve_fixtures.compute_candidate_ledger_hash(html)
        assert l1 == l2
