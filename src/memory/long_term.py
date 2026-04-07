"""Long-term site memory for cross-run extraction hints."""

from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from src.utils.observability import RunTrace


def _normalize_domain(url: str) -> str:
    host = (urlparse(url).netloc or "").lower().strip()
    return host[4:] if host.startswith("www.") else host


def _dedupe_keep_order(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        normalized = str(value or "").strip()
        if normalized and normalized not in seen:
            seen.add(normalized)
            result.append(normalized)
    return result


class LongTermMemory:
    """Stores reusable site-playbook hints across extraction runs.

    This is not classic RAG. It is a structured site-memory store: successful
    tool sequences, repeated selectors, server labels, stream hosts, and
    recurring failure patterns grouped by domain and page type.
    """

    def __init__(self, db_path: str = "data/site_memory.db") -> None:
        self.db_path = db_path
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._bootstrap()

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db_path, check_same_thread=False)

    def _bootstrap(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS site_memory_entries (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    domain TEXT NOT NULL,
                    page_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    url TEXT NOT NULL,
                    success INTEGER NOT NULL,
                    data TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.commit()

    def save_pattern(self, domain: str, pattern_type: str, data: dict[str, Any]) -> None:
        payload = dict(data)
        payload.setdefault("pattern_type", pattern_type)
        self.remember(
            url=f"https://{domain}",
            page_type=pattern_type,
            status=str(payload.get("status", "unknown")),
            payload=payload,
            run_id=str(payload.get("run_id", "")),
        )

    def get_patterns(self, domain: str, pattern_type: str | None = None) -> list[dict[str, Any]]:
        rows = self._fetch_entries(domain=domain, page_type=pattern_type, limit=25)
        return [row["data"] for row in rows]

    def remember(
        self,
        *,
        url: str,
        page_type: str,
        status: str,
        payload: dict[str, Any] | None = None,
        trace: RunTrace | None = None,
        actor: str = "",
        run_id: str = "",
        short_memory_summary: str = "",
    ) -> dict[str, Any]:
        domain = _normalize_domain(url)
        data = self._build_entry(
            url=url,
            page_type=page_type,
            status=status,
            payload=payload or {},
            trace=trace,
            actor=actor,
            short_memory_summary=short_memory_summary,
        )
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO site_memory_entries
                (domain, page_type, status, run_id, url, success, data, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    domain,
                    page_type,
                    status,
                    run_id,
                    url,
                    1 if data["success"] else 0,
                    json.dumps(data, ensure_ascii=False),
                    datetime.utcnow().isoformat(),
                ),
            )
            conn.commit()
        return data

    def build_prompt_context(self, url: str, page_type: str, limit: int = 6) -> str:
        domain = _normalize_domain(url)
        rows = self._fetch_entries(domain=domain, page_type=page_type, limit=limit)
        if not rows:
            rows = self._fetch_entries(domain=domain, page_type=None, limit=max(limit, 4))
        if not rows:
            return ""

        tool_counts: Counter[str] = Counter()
        target_counts: Counter[str] = Counter()
        selector_counts: Counter[str] = Counter()
        server_counts: Counter[str] = Counter()
        stream_host_counts: Counter[str] = Counter()
        failure_patterns: list[str] = []
        successes = 0

        for row in rows:
            data = row["data"]
            successes += 1 if data.get("success") else 0
            tool_counts.update(data.get("tool_sequence", []))
            target_counts.update(data.get("navigation_targets", []))
            selector_counts.update(data.get("selectors", []))
            server_counts.update(data.get("server_labels", []))
            stream_host_counts.update(data.get("stream_hosts", []))
            if not data.get("success") and data.get("result_summary"):
                failure_patterns.append(str(data["result_summary"]))

        lines = [
            "SITE MEMORY HINTS",
            "Use these only as hints. Re-verify on the live page before trusting them.",
            f"- domain: `{domain}`",
            f"- page type focus: `{page_type}`",
            f"- recent runs remembered: `{len(rows)}`",
            f"- recent successes: `{successes}` / `{len(rows)}`",
        ]

        if tool_counts:
            lines.append(
                "- often useful tools: "
                + ", ".join(f"`{tool}` x{count}" for tool, count in tool_counts.most_common(5))
            )
        if target_counts:
            lines.append(
                "- repeated navigation targets: "
                + ", ".join(f"`{target}`" for target, _ in target_counts.most_common(4))
            )
        if selector_counts:
            lines.append(
                "- repeated selectors/text targets: "
                + ", ".join(f"`{target}`" for target, _ in selector_counts.most_common(4))
            )
        if server_counts:
            lines.append(
                "- repeated server labels: "
                + ", ".join(f"`{label}`" for label, _ in server_counts.most_common(4))
            )
        if stream_host_counts:
            lines.append(
                "- previously seen stream hosts: "
                + ", ".join(f"`{host}`" for host, _ in stream_host_counts.most_common(4))
            )
        if failure_patterns:
            lines.append(
                "- recent failure patterns: "
                + "; ".join(f"`{pattern[:120]}`" for pattern in failure_patterns[:3])
            )
        return "\n".join(lines)

    def close(self) -> None:
        """Maintained for backwards compatibility."""

    def _fetch_entries(self, *, domain: str, page_type: str | None, limit: int) -> list[dict[str, Any]]:
        query = """
            SELECT page_type, status, success, data, created_at
            FROM site_memory_entries
            WHERE domain = ?
        """
        params: list[Any] = [domain]
        if page_type:
            query += " AND page_type = ?"
            params.append(page_type)
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(max(int(limit or 1), 1))

        with self._connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [
            {
                "page_type": row[0],
                "status": row[1],
                "success": bool(row[2]),
                "data": json.loads(row[3]),
                "created_at": row[4],
            }
            for row in rows
        ]

    def _build_entry(
        self,
        *,
        url: str,
        page_type: str,
        status: str,
        payload: dict[str, Any],
        trace: RunTrace | None,
        actor: str,
        short_memory_summary: str,
    ) -> dict[str, Any]:
        tool_sequence: list[str] = []
        navigation_targets: list[str] = []
        selectors: list[str] = []
        llm_notes: list[str] = []

        if trace is not None:
            scoped_events = [
                event for event in trace.events
                if not actor or event.actor == actor
            ]
            for event in scoped_events:
                details = event.details or {}
                if event.kind == "tool_call_started":
                    tool_name = str(details.get("tool_name", "") or "").strip()
                    if tool_name:
                        tool_sequence.append(tool_name)
                    args = details.get("tool_args", {}) or {}
                    for key in ("url", "mainUrl", "player_iframe_url", "base_url"):
                        if args.get(key):
                            navigation_targets.append(f"{key}={args[key]}")
                    for key in ("selector", "xpath", "text", "element_ref", "kind", "action", "player_iframe_hint"):
                        if args.get(key):
                            selectors.append(f"{key}={args[key]}")
                elif event.kind == "llm_response" and details.get("content_preview"):
                    llm_notes.append(str(details["content_preview"])[:240])

        servers = payload.get("servers", []) if isinstance(payload, dict) else []
        stream_urls: list[str] = []
        for entry in payload.get("streaming_urls", []) if isinstance(payload, dict) else []:
            if isinstance(entry, dict) and entry.get("url"):
                stream_urls.append(str(entry["url"]))
        for entry in payload.get("all_stream_urls", []) if isinstance(payload, dict) else []:
            if isinstance(entry, dict) and entry.get("url"):
                stream_urls.append(str(entry["url"]))
        for server in servers:
            if not isinstance(server, dict):
                continue
            stream_urls.extend(server.get("m3u8_urls", []) or [])
            stream_urls.extend(server.get("mpd_urls", []) or [])
            stream_urls.extend(server.get("mp4_urls", []) or [])
            if server.get("embedded_url"):
                navigation_targets.append(f"embedded_url={server['embedded_url']}")

        stream_hosts = _dedupe_keep_order([_normalize_domain(item) for item in stream_urls if item])
        server_labels = _dedupe_keep_order(
            [str(server.get("label", "")).strip() for server in servers if isinstance(server, dict)]
        )
        hosting_pages = payload.get("hosting_pages", []) if isinstance(payload, dict) else []
        for page in hosting_pages:
            if isinstance(page, dict) and page.get("url"):
                navigation_targets.append(f"hosting_url={page['url']}")
            if isinstance(page, dict):
                for field in ("title", "participants", "channel"):
                    if page.get(field):
                        selectors.append(f"{field}={page[field]}")

        result_summary = self._result_summary(page_type, status, payload)
        return {
            "domain": _normalize_domain(url),
            "url": url,
            "page_type": page_type,
            "status": status,
            "success": status in {"success", "partial"},
            "tool_sequence": _dedupe_keep_order(tool_sequence)[:16],
            "navigation_targets": _dedupe_keep_order(navigation_targets)[:12],
            "selectors": _dedupe_keep_order(selectors)[:12],
            "server_labels": server_labels[:8],
            "stream_hosts": stream_hosts[:8],
            "llm_notes": _dedupe_keep_order(llm_notes)[:4],
            "short_memory_summary": short_memory_summary[:1200],
            "result_summary": result_summary,
        }

    def _result_summary(self, page_type: str, status: str, payload: dict[str, Any]) -> str:
        if page_type == "classification":
            return f"classified as {payload.get('page_type', 'unknown')} with confidence {payload.get('confidence', 'unknown')}"
        if page_type == "landing_page":
            return f"landing run {status}; hosting pages found={len(payload.get('hosting_pages', []) or [])}"
        if page_type in {"hosting_page", "embedded_page"}:
            decision = payload.get("decision", "")
            stream_count = len(payload.get("streaming_urls", []) or []) + len(payload.get("all_stream_urls", []) or [])
            successful_servers = payload.get("successful_servers", 0)
            return (
                f"{page_type} run {status}; decision={decision or 'n/a'}; "
                f"streams={stream_count}; successful_servers={successful_servers}"
            )
        return f"{page_type} run {status}"
