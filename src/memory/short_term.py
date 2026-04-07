"""Short-term working memory for a single website extraction run."""

from __future__ import annotations

from collections import deque
from typing import Any


class ShortTermMemory:
    """Keeps the current run's working state compact and extraction-focused.

    This is intentionally not a generic chat memory. It tracks the things that
    matter for site extraction work: visited URLs, tool attempts, selectors,
    and short observations that can be summarized or persisted later.
    """

    def __init__(self, k: int = 40) -> None:
        self.k = max(int(k or 1), 1)
        self._entries: deque[dict[str, Any]] = deque(maxlen=self.k)

    def save(self, human: str, ai: str) -> None:
        """Backward-compatible helper for old call sites."""
        self.record_observation(f"Human: {human}")
        self.record_observation(f"AI: {ai}")

    def load(self) -> list[dict[str, Any]]:
        return list(self._entries)

    def clear(self) -> None:
        self._entries.clear()

    def record_navigation(self, url: str, *, via: str = "", note: str = "") -> None:
        if not (url or via or note):
            return
        self._entries.append(
            {
                "kind": "navigation",
                "url": url,
                "via": via,
                "note": note,
            }
        )

    def record_tool(
        self,
        tool_name: str,
        tool_args: dict[str, Any] | None = None,
        *,
        status: str = "info",
        result_preview: str = "",
    ) -> None:
        self._entries.append(
            {
                "kind": "tool",
                "tool_name": tool_name,
                "tool_args": tool_args or {},
                "status": status,
                "result_preview": result_preview[:400],
            }
        )

    def record_observation(self, note: str, *, source: str = "") -> None:
        text = str(note or "").strip()
        if not text:
            return
        self._entries.append(
            {
                "kind": "observation",
                "source": source,
                "note": text[:500],
            }
        )

    def summary(self, limit: int = 8) -> str:
        recent = list(self._entries)[-max(int(limit or 1), 1) :]
        if not recent:
            return ""

        lines: list[str] = []
        for entry in recent:
            kind = entry.get("kind")
            if kind == "navigation":
                url = entry.get("url", "")
                via = entry.get("via", "")
                note = entry.get("note", "")
                parts = [part for part in [url, via, note] if part]
                if parts:
                    lines.append("- nav: " + " | ".join(parts))
            elif kind == "tool":
                tool_name = entry.get("tool_name", "unknown")
                status = entry.get("status", "info")
                args = entry.get("tool_args", {}) or {}
                target = ""
                for key in ("url", "selector", "text", "xpath", "player_iframe_url", "kind", "action"):
                    if args.get(key):
                        target = f"{key}={args[key]}"
                        break
                line = f"- tool: {tool_name} [{status}]"
                if target:
                    line += f" on {target}"
                if entry.get("result_preview"):
                    line += f" -> {entry['result_preview'][:120]}"
                lines.append(line)
            elif kind == "observation":
                prefix = f"{entry.get('source')}: " if entry.get("source") else ""
                lines.append(f"- note: {prefix}{entry.get('note', '')}")
        return "\n".join(lines)

    def working_state(
        self,
        *,
        objective: str,
        page_url: str = "",
        page_type: str = "",
        limit: int = 8,
    ) -> str:
        recent = list(self._entries)[-max(int(limit or 1), 1) :]
        current_target = page_url or self._last_navigation_url(recent)
        steps = self._steps_already_tried(recent)
        blockers = self._blockers_seen(recent)
        last_success = self._last_successful_action(recent)
        next_best_move = self._next_best_move(recent, blockers)

        lines = [
            f"- current objective: {str(objective or '').strip()}",
            f"- current page type: `{page_type or 'unknown'}`",
            f"- current target url: `{current_target or 'unknown'}`",
            "- steps already tried: "
            + (", ".join(f"`{step}`" for step in steps[:5]) if steps else "`none yet`"),
            "- blockers seen: "
            + (", ".join(f"`{blocker}`" for blocker in blockers[:3]) if blockers else "`none yet`"),
            f"- last successful action: `{last_success or 'none yet'}`",
            f"- next best move: {next_best_move}",
        ]
        return "\n".join(lines)

    def _last_navigation_url(self, entries: list[dict[str, Any]]) -> str:
        for entry in reversed(entries):
            if entry.get("kind") == "navigation" and entry.get("url"):
                return str(entry["url"])
        return ""

    def _steps_already_tried(self, entries: list[dict[str, Any]]) -> list[str]:
        steps: list[str] = []
        for entry in entries:
            kind = entry.get("kind")
            if kind == "navigation":
                url = str(entry.get("url", "")).strip()
                via = str(entry.get("via", "")).strip()
                if url or via:
                    steps.append("navigate " + " via ".join(part for part in [url, via] if part))
            elif kind == "tool":
                tool_name = str(entry.get("tool_name", "unknown")).strip() or "unknown"
                args = entry.get("tool_args", {}) or {}
                target = ""
                for key in ("url", "selector", "text", "xpath", "element_ref", "player_iframe_url"):
                    if args.get(key):
                        target = f"{key}={args[key]}"
                        break
                step = tool_name if not target else f"{tool_name} on {target}"
                steps.append(step)
        return steps

    def _blockers_seen(self, entries: list[dict[str, Any]]) -> list[str]:
        blockers: list[str] = []
        for entry in entries:
            texts = [
                str(entry.get("note", "")),
                str(entry.get("result_preview", "")),
            ]
            joined = " ".join(text.lower() for text in texts if text).strip()
            if not joined:
                continue
            if any(token in joined for token in ("cloudflare", "captcha", "challenge", "blocked", "forbidden")):
                blockers.append(joined[:120])
            elif entry.get("kind") == "tool" and entry.get("status") == "error":
                blockers.append(joined[:120] or f"{entry.get('tool_name', 'tool')} failed")
        return blockers

    def _last_successful_action(self, entries: list[dict[str, Any]]) -> str:
        for entry in reversed(entries):
            if entry.get("kind") == "tool" and entry.get("status") == "success":
                tool_name = str(entry.get("tool_name", "unknown")).strip() or "unknown"
                args = entry.get("tool_args", {}) or {}
                for key in ("url", "selector", "text", "xpath", "element_ref", "player_iframe_url"):
                    if args.get(key):
                        return f"{tool_name} on {key}={args[key]}"
                return tool_name
            if entry.get("kind") == "navigation" and entry.get("url"):
                return f"navigate to {entry['url']}"
        return ""

    def _next_best_move(self, entries: list[dict[str, Any]], blockers: list[str]) -> str:
        if blockers:
            return "wait, verify access state, and avoid repeating the blocked step"
        if not entries:
            return "start with a page context or navigation tool to gather fresh evidence"
        last = entries[-1]
        if last.get("kind") == "navigation":
            return "inspect the loaded page and identify the next actionable element"
        if last.get("kind") == "tool" and last.get("status") == "success":
            return "build on the last successful action and verify whether new streams or targets appeared"
        if last.get("kind") == "tool":
            return "try a different locator or inspect the page before retrying the same action"
        return "continue from the freshest live-page evidence"
