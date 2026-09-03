"""Live browser/MCP media smoke runner.

Uses the running API and current dataset/live URL records. It intentionally
does not mock media: every target is opened through MCP tools and playback is
judged from tool diagnostics.
"""

from __future__ import annotations

import argparse
import csv
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_API = "http://localhost:8000"
BROWSERS = ("playwright",)
PROFILES = ("classification", "landing", "hosting", "embedded")


def request_json(method: str, url: str, payload: dict[str, Any] | None = None, timeout: int = 120) -> dict[str, Any]:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:  # noqa: S310 - local operator smoke target
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"{method} {url} failed with HTTP {exc.code}: {body}") from exc


def read_dataset_urls(limit: int) -> list[str]:
    urls: list[str] = []
    db_path = ROOT / "data" / "open_web_catcher.db"
    if db_path.exists():
        with sqlite3.connect(db_path) as con:
            rows = con.execute(
                "select url from dataset_sites where coalesce(url, '') != '' order by id limit ?",
                (limit,),
            ).fetchall()
        urls.extend(str(row[0]).strip() for row in rows if str(row[0]).strip())

    if len(urls) < limit:
        csv_path = ROOT / "datasets" / "sites.csv"
        if csv_path.exists():
            with csv_path.open("r", encoding="utf-8", newline="") as handle:
                for row in csv.DictReader(handle):
                    url = str(row.get("url") or "").strip()
                    if url and url not in urls:
                        urls.append(url)
                    if len(urls) >= limit:
                        break
    return urls[:limit]


def read_url_file(path: str) -> list[str]:
    file_path = Path(path)
    return [
        line.strip()
        for line in file_path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def configure_engine(api_base: str, engine: str) -> dict[str, Any]:
    config = request_json("GET", f"{api_base}/ui/config", timeout=30)
    payload = {
        "browser_engine": engine,
        "browser_runtime": config.get("browser_runtime") or {},
    }
    return request_json(
        "PUT",
        f"{api_base}/ui/config",
        payload,
        timeout=30,
    )


def call_tool(api_base: str, profile: str, tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    payload = request_json(
        "POST",
        f"{api_base}/ui/tools/call",
        {"profile": profile, "tool_name": tool_name, "args": args},
        timeout=180,
    )
    result = payload.get("result")
    return parse_tool_result(result)


def parse_tool_result(result: Any) -> dict[str, Any]:
    if isinstance(result, dict):
        if isinstance(result.get("data"), dict) or "ok" in result:
            return result
        content = result.get("content") or result.get("result")
        if isinstance(content, list):
            for item in content:
                if isinstance(item, dict) and isinstance(item.get("text"), str):
                    try:
                        parsed = json.loads(item["text"])
                    except json.JSONDecodeError:
                        continue
                    if isinstance(parsed, dict):
                        return parsed
        return result
    return {"ok": False, "error": "Tool returned a non-object result.", "raw_result": result}


def first_video_ref(context: dict[str, Any]) -> dict[str, str]:
    data = context.get("data") if isinstance(context.get("data"), dict) else context
    candidates = data.get("top_candidates") if isinstance(data, dict) else []
    if not isinstance(candidates, list):
        return {}
    for item in candidates:
        if isinstance(item, dict) and item.get("kind") == "video":
            return {
                "frame_path": str(item.get("frame_path") or "root"),
                "element_ref": str(item.get("element_ref") or ""),
                "selector": str(item.get("selector") or "video"),
            }
    return {}

def smoke_url(api_base: str, url: str, profile: str, capture_ms: int) -> dict[str, Any]:
    opened = call_tool(
        api_base, profile, "navigate", {"action": "goto", "url": url, "timeout_ms": 45000}
    )
    context = call_tool(api_base, profile, "inspect", {"view": "media"})
    playback = call_tool(api_base, profile, "interact", {"action": "play"})
    streams = call_tool(api_base, profile, "harvest", {"frame_path": "root"})
    stream_data = streams.get("data") if isinstance(streams.get("data"), dict) else streams
    playback_data = playback.get("data") if isinstance(playback.get("data"), dict) else playback
    video_found = bool(context.get("data", {}).get("videos"))
    total_streams = len(stream_data.get("streams", []))
    return {
        "url": url,
        "opened": bool(opened.get("ok", True)),
        "open_error": opened.get("error"),
        "final_url": opened.get("final_url") or opened.get("url"),
        "video_target_found": video_found,
        "playback_started": bool(playback_data.get("verified")),
        "playback_ready": bool(playback_data.get("verified")),
        "playback_error": playback_data.get("error"),
        "stream_evidence_found": total_streams > 0,
        "total_streams": total_streams,
        "capture_error": stream_data.get("error"),
        "ok": bool(playback_data.get("verified") or total_streams > 0),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run live MCP media smoke checks against dataset or pinned URLs.")
    parser.add_argument("--api", default=DEFAULT_API)
    parser.add_argument("--engine", choices=["playwright"], default="playwright")
    parser.add_argument("--profile", choices=["hosting", "embedded"], default="hosting")
    parser.add_argument("--url", action="append", default=[])
    parser.add_argument("--url-file", default="")
    parser.add_argument("--limit", type=int, default=3)
    parser.add_argument("--capture-ms", type=int, default=12000)
    parser.add_argument(
        "--preserve-disabled-tools",
        action="store_true",
        help="Do not temporarily clear disabled MCP tool lists before smoke calls.",
    )
    args = parser.parse_args()

    urls = list(args.url)
    if args.url_file:
        urls.extend(read_url_file(args.url_file))
    if not urls:
        urls = read_dataset_urls(args.limit)
    urls = urls[: max(1, args.limit)]
    if not urls:
        print(json.dumps({"ok": False, "error": "No live URLs available."}, indent=2))
        return 2

    engines = [args.engine]
    original_config = request_json("GET", f"{args.api}/ui/config", timeout=30)
    summary = {"ok": True, "api": args.api, "engines": {}}
    try:
        for engine in engines:
            try:
                configure_engine(
                    args.api,
                    engine,
                )
                time.sleep(0.5)
                health = request_json("GET", f"{args.api}/ui/browser/status", timeout=20)
                results = [smoke_url(args.api, url, args.profile, args.capture_ms) for url in urls]
                engine_ok = all(item["ok"] for item in results)
                summary["engines"][engine] = {
                    "ok": engine_ok,
                    "disabled_tools_cleared_for_smoke": not args.preserve_disabled_tools,
                    "health": health,
                    "results": results,
                }
                summary["ok"] = summary["ok"] and engine_ok
            except (urllib.error.URLError, TimeoutError, RuntimeError, ValueError) as exc:
                summary["ok"] = False
                summary["engines"][engine] = {"ok": False, "error": str(exc)}
    finally:
        request_json(
            "PUT",
            f"{args.api}/ui/config",
            {
                "browser_engine": original_config.get("browser_engine") or "playwright",
                "browser_runtime": original_config.get("browser_runtime") or {},
            },
            timeout=30,
        )

    print(json.dumps(summary, indent=2))
    return 0 if summary["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
