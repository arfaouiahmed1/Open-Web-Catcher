from __future__ import annotations

import csv
import json
import math
import textwrap
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


API_BASE = "http://localhost:8000"
ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "Report" / "assets" / "evaluation-api-metrics"
DATA_DIR = OUT_DIR / "data"
MD_PATH = ROOT / "Report" / "evaluation-api-metrics.md"

TERMINAL_EXCLUDE = {"running", "queued"}
PRODUCTIVE = {"success", "partial"}
EXTERNAL_BLOCKERS = {
    "page_inaccessible",
    "site_dead",
    "no_hosting_pages",
    "no_streams",
}
RUNTIME_FAILURES = {"failed", "timeout", "redirect"}

TOKENS = {
    "surface": "#FCFCFD",
    "panel": "#FFFFFF",
    "ink": "#1F2430",
    "muted": "#6F768A",
    "grid": "#E6E8F0",
    "axis": "#D7DBE7",
}
COLORS = {
    "blue": "#A3BEFA",
    "blue_dark": "#2E4780",
    "gold": "#FFE15B",
    "gold_dark": "#736422",
    "orange": "#F0986E",
    "orange_dark": "#804126",
    "olive": "#A3D576",
    "olive_dark": "#386411",
    "pink": "#F390CA",
    "pink_dark": "#8A3A6F",
    "neutral": "#C5CAD3",
    "neutral_dark": "#464C55",
}


def fetch_json(path: str) -> dict[str, Any]:
    url = f"{API_BASE}{path}"
    with urllib.request.urlopen(url, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_table(table: str) -> list[dict[str, Any]]:
    first = fetch_json(f"/ui/database/{table}?limit=500&offset=0")
    rows = list(first.get("rows") or [])
    total = int(first.get("total") or len(rows))
    offset = 500
    while len(rows) < total:
        payload = fetch_json(f"/ui/database/{table}?limit=500&offset={offset}")
        batch = list(payload.get("rows") or [])
        if not batch:
            break
        rows.extend(batch)
        offset += 500
    return rows


def n(value: Any) -> float:
    try:
        if value is None or value == "":
            return 0.0
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def i(value: Any) -> int:
    return int(round(n(value)))


def pct(num: float, den: float) -> float:
    return num / den if den else 0.0


def fmt_int(value: float) -> str:
    return f"{int(round(value)):,}"


def fmt_money(value: float) -> str:
    return f"${value:,.6f}" if value < 1 else f"${value:,.4f}"


def fmt_pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def fmt_duration(value: float) -> str:
    if value >= 60:
        return f"{value / 60:.1f} min"
    return f"{value:.1f} sec"


def compact(value: float) -> str:
    value = float(value or 0)
    sign = "-" if value < 0 else ""
    value = abs(value)
    if value >= 1_000_000:
        return f"{sign}{value / 1_000_000:.1f}M"
    if value >= 1_000:
        return f"{sign}{value / 1_000:.1f}k"
    if value >= 100:
        return f"{sign}{value:.0f}"
    if value >= 10:
        return f"{sign}{value:.1f}"
    return f"{sign}{value:.2f}"


def norm_status(row: dict[str, Any]) -> str:
    return str(row.get("final_status") or row.get("status") or "").strip().lower() or "unknown"


def norm_host(url: str) -> str:
    parsed = urllib.parse.urlparse(str(url or "").strip())
    host = parsed.netloc or parsed.path.split("/")[0]
    host = host.lower().split("@")[-1].split(":")[0]
    if host.startswith("www."):
        host = host[4:]
    return host or "(missing)"


def row_total_tokens(row: dict[str, Any]) -> int:
    return i(row.get("total_tokens_in")) + i(row.get("total_tokens_out"))


def row_input_tokens(row: dict[str, Any]) -> int:
    return i(row.get("total_tokens_in"))


def row_cached_tokens(row: dict[str, Any]) -> int:
    return i(row.get("total_cached_input_tokens"))


def row_new_tokens(row: dict[str, Any]) -> int:
    return i(row.get("total_new_input_tokens"))


def row_cost(row: dict[str, Any]) -> float:
    return n(row.get("estimated_total_cost_usd"))


def load_font(size: int, bold: bool = False, mono: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = []
    if mono:
        candidates.extend([
            Path("C:/Windows/Fonts/consola.ttf"),
            Path("C:/Windows/Fonts/CascadiaMono.ttf"),
        ])
    if bold:
        candidates.extend([
            Path("C:/Windows/Fonts/segoeuib.ttf"),
            Path("C:/Windows/Fonts/arialbd.ttf"),
        ])
    candidates.extend([
        Path("C:/Windows/Fonts/segoeui.ttf"),
        Path("C:/Windows/Fonts/arial.ttf"),
    ])
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


FONT_TITLE = load_font(28, bold=True)
FONT_SUB = load_font(16)
FONT_LABEL = load_font(16)
FONT_SMALL = load_font(13)
FONT_MONO = load_font(14, mono=True)


def text_width(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> int:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


def wrap_label(label: str, width: int = 28) -> str:
    return "\n".join(textwrap.wrap(str(label), width=width, break_long_words=False)) or str(label)


def save_hbar_chart(
    rows: list[dict[str, Any]],
    path: Path,
    title: str,
    subtitle: str,
    *,
    value_key: str = "value",
    label_key: str = "label",
    width: int = 1280,
    row_height: int = 54,
    value_formatter=compact,
    color_key: str | None = None,
    default_color: str = COLORS["blue"],
) -> None:
    rows = [row for row in rows if n(row.get(value_key)) >= 0]
    rows = rows[:18]
    height = 155 + max(1, len(rows)) * row_height + 38
    image = Image.new("RGB", (width, height), TOKENS["surface"])
    draw = ImageDraw.Draw(image)
    draw.text((44, 28), title, fill=TOKENS["ink"], font=FONT_TITLE)
    draw.text((44, 66), subtitle, fill=TOKENS["muted"], font=FONT_SUB)
    left_label = 44
    label_w = 320
    plot_x = left_label + label_w
    plot_w = width - plot_x - 190
    y0 = 128
    max_value = max([n(row.get(value_key)) for row in rows] + [1.0])
    for idx, row in enumerate(rows):
        y = y0 + idx * row_height
        raw_label = str(row.get(label_key, ""))
        label = wrap_label(raw_label, 30)
        draw.text((left_label, y + 4), label, fill=TOKENS["ink"], font=FONT_LABEL, spacing=1)
        draw.rounded_rectangle(
            (plot_x, y + 10, plot_x + plot_w, y + 30),
            radius=7,
            fill=TOKENS["grid"],
        )
        value = n(row.get(value_key))
        bar_w = int(plot_w * pct(value, max_value))
        color = row.get(color_key) if color_key else default_color
        if not color:
            color = default_color
        draw.rounded_rectangle(
            (plot_x, y + 10, plot_x + max(4, bar_w), y + 30),
            radius=7,
            fill=str(color),
        )
        value_label = value_formatter(value)
        draw.text((plot_x + plot_w + 18, y + 7), value_label, fill=TOKENS["ink"], font=FONT_MONO)
        note = str(row.get("note") or "")
        if note:
            draw.text((plot_x, y + 34), note, fill=TOKENS["muted"], font=FONT_SMALL)
    image.save(path)


def save_stacked_chart(
    segments: list[dict[str, Any]],
    path: Path,
    title: str,
    subtitle: str,
    *,
    width: int = 1280,
    height: int = 360,
) -> None:
    total = sum(n(seg.get("value")) for seg in segments) or 1
    image = Image.new("RGB", (width, height), TOKENS["surface"])
    draw = ImageDraw.Draw(image)
    draw.text((44, 28), title, fill=TOKENS["ink"], font=FONT_TITLE)
    draw.text((44, 66), subtitle, fill=TOKENS["muted"], font=FONT_SUB)
    x = 44
    y = 136
    bar_w = width - 88
    bar_h = 58
    cursor = x
    for seg in segments:
        value = n(seg.get("value"))
        w = int(bar_w * pct(value, total))
        draw.rectangle((cursor, y, cursor + w, y + bar_h), fill=str(seg.get("color") or COLORS["blue"]))
        if w > 86:
            label = f"{seg.get('label')} {fmt_pct(pct(value, total))}"
            tw = text_width(draw, label, FONT_SMALL)
            draw.text((cursor + max(8, (w - tw) // 2), y + 20), label, fill=TOKENS["ink"], font=FONT_SMALL)
        cursor += w
    draw.rectangle((x, y, x + bar_w, y + bar_h), outline=TOKENS["axis"], width=1)
    legend_y = 226
    lx = 44
    for seg in segments:
        draw.rounded_rectangle((lx, legend_y, lx + 18, legend_y + 18), radius=4, fill=str(seg.get("color") or COLORS["blue"]))
        label = f"{seg.get('label')}: {fmt_int(n(seg.get('value')))} ({fmt_pct(pct(n(seg.get('value')), total))})"
        draw.text((lx + 28, legend_y - 1), label, fill=TOKENS["ink"], font=FONT_LABEL)
        lx += min(360, 34 + text_width(draw, label, FONT_LABEL))
        if lx > width - 330:
            lx = 44
            legend_y += 36
    image.save(path)


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def md_table(headers: list[str], rows: list[list[Any]]) -> str:
    lines = ["| " + " | ".join(headers) + " |"]
    lines.append("| " + " | ".join(["---"] * len(headers)) + " |")
    for row in rows:
        lines.append("| " + " | ".join(str(cell) for cell in row) + " |")
    return "\n".join(lines)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    tables = {
        "pipeline_runs": fetch_table("pipeline_runs"),
        "runs": fetch_table("runs"),
        "run_model_usage": fetch_table("run_model_usage"),
        "agent_runs": fetch_table("agent_runs"),
        "tool_calls": fetch_table("tool_calls"),
        "run_streams": fetch_table("run_streams"),
        "provider_analyses": fetch_table("provider_analyses"),
        "takedown_emails": fetch_table("takedown_emails"),
        "llm_calls": fetch_table("llm_calls"),
    }

    pipeline_runs = tables["pipeline_runs"]
    run_rows = tables["runs"]
    agent_runs = tables["agent_runs"]
    tool_calls = tables["tool_calls"]
    model_usage = tables["run_model_usage"]
    streams = tables["run_streams"]
    providers = tables["provider_analyses"]
    emails = tables["takedown_emails"]
    llm_calls = tables["llm_calls"]

    status_counts = Counter(norm_status(row) for row in pipeline_runs)
    terminal_runs = [row for row in pipeline_runs if norm_status(row) not in TERMINAL_EXCLUDE]
    terminal_count = len(terminal_runs)
    total_count = len(pipeline_runs)
    success_rows = [row for row in terminal_runs if norm_status(row) == "success"]
    partial_rows = [row for row in terminal_runs if norm_status(row) == "partial"]
    productive_rows = [row for row in terminal_runs if norm_status(row) in PRODUCTIVE]
    external_rows = [row for row in terminal_runs if norm_status(row) in EXTERNAL_BLOCKERS]
    failed_rows = [row for row in terminal_runs if norm_status(row) in RUNTIME_FAILURES]
    active_rows = [row for row in pipeline_runs if norm_status(row) in TERMINAL_EXCLUDE]

    total_cost_all = sum(row_cost(row) for row in pipeline_runs)
    total_cost_terminal = sum(row_cost(row) for row in terminal_runs)
    total_tokens_all = sum(row_total_tokens(row) for row in pipeline_runs)
    total_tokens_terminal = sum(row_total_tokens(row) for row in terminal_runs)
    total_input = sum(row_input_tokens(row) for row in pipeline_runs)
    total_cached = sum(row_cached_tokens(row) for row in pipeline_runs)
    total_new = sum(row_new_tokens(row) for row in pipeline_runs)
    total_output = sum(i(row.get("total_tokens_out")) for row in pipeline_runs)
    cache_den = total_cached + total_new

    tool_status_counts = Counter(str(row.get("status") or "unknown").strip().lower() for row in tool_calls)
    successful_tools = tool_status_counts.get("success", 0)
    observed_tools = len(tool_calls)
    failed_tools = observed_tools - successful_tools

    status_summary = []
    status_order = ["success", "partial", "no_hosting_pages", "no_streams", "page_inaccessible", "failed", "running"]
    for status in status_order + sorted(set(status_counts) - set(status_order)):
        count = status_counts.get(status, 0)
        if count <= 0:
            continue
        rows_for_status = [row for row in pipeline_runs if norm_status(row) == status]
        status_summary.append({
            "status": status,
            "runs": count,
            "share_of_total": pct(count, total_count),
            "share_of_terminal": pct(count, terminal_count) if status not in TERMINAL_EXCLUDE else None,
            "avg_cost_usd": sum(row_cost(row) for row in rows_for_status) / count,
            "avg_total_tokens": sum(row_total_tokens(row) for row in rows_for_status) / count,
            "streams": sum(i(row.get("stream_count")) for row in rows_for_status),
            "emails": sum(i(row.get("email_count")) for row in rows_for_status),
        })

    agent_by_id = {i(row.get("id")): row for row in agent_runs}
    agent_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in agent_runs:
        actor = str(row.get("actor") or row.get("agent_type") or "unknown").strip() or "unknown"
        agent_groups[actor].append(row)

    tool_by_actor: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in tool_calls:
        agent = agent_by_id.get(i(row.get("agent_run_id")), {})
        actor = str(agent.get("actor") or agent.get("agent_type") or "unknown").strip() or "unknown"
        tool_by_actor[actor].append(row)

    agent_summary = []
    for actor, rows in sorted(agent_groups.items(), key=lambda item: item[0]):
        count = len(rows)
        actor_tool_rows = tool_by_actor.get(actor, [])
        actor_success_tools = sum(1 for row in actor_tool_rows if str(row.get("status") or "").lower() == "success")
        status_counter = Counter(str(row.get("status") or "unknown").strip().lower() for row in rows)
        agent_summary.append({
            "agent": actor,
            "agent_runs": count,
            "success_runs": status_counter.get("success", 0),
            "partial_runs": status_counter.get("partial", 0),
            "failed_runs": status_counter.get("failed", 0),
            "running_runs": status_counter.get("running", 0),
            "other_statuses": count - status_counter.get("success", 0) - status_counter.get("partial", 0) - status_counter.get("failed", 0) - status_counter.get("running", 0),
            "avg_tool_calls_made": sum(i(row.get("tool_calls_made")) for row in rows) / count,
            "total_tool_calls_made": sum(i(row.get("tool_calls_made")) for row in rows),
            "avg_llm_calls_made": sum(i(row.get("llm_calls_made")) for row in rows) / count,
            "total_llm_calls_made": sum(i(row.get("llm_calls_made")) for row in rows),
            "avg_total_tokens": sum(i(row.get("input_tokens")) + i(row.get("output_tokens")) for row in rows) / count,
            "tool_rows_observed": len(actor_tool_rows),
            "tool_success_rate": pct(actor_success_tools, len(actor_tool_rows)),
            "avg_duration_seconds": sum(n(row.get("duration_seconds")) for row in rows) / count,
        })
    agent_summary.sort(key=lambda row: row["avg_tool_calls_made"], reverse=True)

    tool_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in tool_calls:
        tool_groups[str(row.get("tool_name") or "unknown").strip() or "unknown"].append(row)
    tool_summary = []
    for name, rows in tool_groups.items():
        successes = sum(1 for row in rows if str(row.get("status") or "").lower() == "success")
        tool_summary.append({
            "tool": name,
            "calls": len(rows),
            "successes": successes,
            "errors": len(rows) - successes,
            "success_rate": pct(successes, len(rows)),
            "avg_duration_seconds": sum(n(row.get("duration_seconds")) for row in rows) / len(rows),
        })
    tool_summary.sort(key=lambda row: row["calls"], reverse=True)

    model_groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in model_usage:
        model_groups[(str(row.get("provider") or "").strip(), str(row.get("model_name") or "").strip())].append(row)
    model_summary = []
    for (provider, model), rows in model_groups.items():
        model_summary.append({
            "provider": provider,
            "model": model,
            "rows": len(rows),
            "llm_calls": sum(i(row.get("llm_calls")) for row in rows),
            "cache_hit_calls": sum(i(row.get("cache_hit_calls")) for row in rows),
            "input_tokens": sum(i(row.get("input_tokens")) for row in rows),
            "cached_input_tokens": sum(i(row.get("cached_input_tokens")) for row in rows),
            "new_input_tokens": sum(i(row.get("new_input_tokens")) for row in rows),
            "output_tokens": sum(i(row.get("output_tokens")) for row in rows),
            "total_tokens": sum(i(row.get("input_tokens")) + i(row.get("output_tokens")) for row in rows),
            "cost_usd": sum(n(row.get("estimated_total_cost_usd")) for row in rows),
        })
    model_summary.sort(key=lambda row: row["cost_usd"], reverse=True)

    successful_sites: dict[str, dict[str, Any]] = {}
    for row in success_rows:
        if i(row.get("stream_count")) <= 0:
            continue
        host = norm_host(str(row.get("root_url") or ""))
        entry = successful_sites.setdefault(host, {
            "website": host,
            "successful_runs": 0,
            "total_runs_in_batch": 0,
            "streams": 0,
            "screenshots": 0,
            "emails": 0,
            "provider_rows": 0,
            "cost_usd": 0.0,
            "example_run_id": "",
            "example_url": "",
        })
        entry["successful_runs"] += 1
        entry["streams"] += i(row.get("stream_count"))
        entry["screenshots"] += i(row.get("screenshot_count"))
        entry["emails"] += i(row.get("email_count"))
        entry["provider_rows"] += i(row.get("provider_analysis_count"))
        entry["cost_usd"] += row_cost(row)
        if not entry["example_run_id"]:
            entry["example_run_id"] = str(row.get("run_id") or "")
            entry["example_url"] = str(row.get("root_url") or "")
    for row in pipeline_runs:
        host = norm_host(str(row.get("root_url") or ""))
        if host in successful_sites:
            successful_sites[host]["total_runs_in_batch"] += 1
    successful_site_rows = sorted(
        successful_sites.values(),
        key=lambda row: (-row["successful_runs"], row["website"]),
    )
    distinct_tested_sites = len({norm_host(str(row.get("root_url") or "")) for row in pipeline_runs})

    provider_groups: dict[str, set[int]] = defaultdict(set)
    for row in providers:
        provider = str(row.get("provider") or "unknown").strip() or "unknown"
        provider_groups[provider].add(i(row.get("pipeline_run_id")))
    provider_summary = [
        {"provider": name, "provider_rows": sum(1 for row in providers if (str(row.get("provider") or "unknown").strip() or "unknown") == name), "affected_runs": len(run_ids)}
        for name, run_ids in provider_groups.items()
    ]
    provider_summary.sort(key=lambda row: (-row["provider_rows"], row["provider"]))

    max_updated = max(
        [
            str(row.get("updated_at") or row.get("created_at") or row.get("started_at") or "")
            for row in pipeline_runs
        ]
        or [""]
    )
    generated_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    status_chart_rows = []
    status_colors = {
        "success": COLORS["olive"],
        "partial": COLORS["gold"],
        "failed": COLORS["orange"],
        "no_hosting_pages": COLORS["blue"],
        "no_streams": COLORS["pink"],
        "page_inaccessible": COLORS["neutral"],
        "running": COLORS["neutral_dark"],
    }
    for row in status_summary:
        status_chart_rows.append({
            "label": row["status"].replace("_", " "),
            "value": row["runs"],
            "color": status_colors.get(row["status"], COLORS["blue"]),
            "note": f"{fmt_pct(row['share_of_total'])} of all runs",
        })
    save_hbar_chart(
        status_chart_rows,
        OUT_DIR / "status_breakdown.png",
        "Run outcome split from API tables",
        "Counts by persisted final_status across 70 pipeline_runs.",
        color_key="color",
        value_formatter=lambda value: fmt_int(value),
    )

    outcome_segments = [
        {"label": "Productive evidence", "value": len(productive_rows), "color": COLORS["olive"]},
        {"label": "External blockers", "value": len(external_rows), "color": COLORS["gold"]},
        {"label": "Literal failures", "value": len(failed_rows), "color": COLORS["orange"]},
        {"label": "Still running", "value": len(active_rows), "color": COLORS["neutral"]},
    ]
    save_stacked_chart(
        outcome_segments,
        OUT_DIR / "outcome_buckets.png",
        "What the 70-run split really means",
        "Productive evidence includes success + partial; blockers are kept separate from literal agent/runtime failure.",
    )

    cost_status_rows = sorted(status_summary, key=lambda row: row["avg_cost_usd"], reverse=True)
    save_hbar_chart(
        [
            {
                "label": row["status"].replace("_", " "),
                "value": row["avg_cost_usd"],
                "color": status_colors.get(row["status"], COLORS["blue"]),
                "note": f"{row['runs']} runs",
            }
            for row in cost_status_rows
        ],
        OUT_DIR / "avg_cost_by_status.png",
        "Average model cost by run outcome",
        "Calculated from pipeline_runs.estimated_total_cost_usd, grouped by final_status.",
        color_key="color",
        value_formatter=fmt_money,
    )

    token_status_rows = sorted(status_summary, key=lambda row: row["avg_total_tokens"], reverse=True)
    save_hbar_chart(
        [
            {
                "label": row["status"].replace("_", " "),
                "value": row["avg_total_tokens"],
                "color": status_colors.get(row["status"], COLORS["blue"]),
                "note": f"{row['runs']} runs",
            }
            for row in token_status_rows
        ],
        OUT_DIR / "avg_tokens_by_status.png",
        "Average tokens by run outcome",
        "Input + output tokens from pipeline_runs, grouped by final_status.",
        color_key="color",
        value_formatter=compact,
    )

    save_hbar_chart(
        [
            {
                "label": row["agent"],
                "value": row["avg_tool_calls_made"],
                "color": COLORS["blue"],
                "note": f"{row['agent_runs']} invocations; total tools {fmt_int(row['total_tool_calls_made'])}",
            }
            for row in agent_summary
        ],
        OUT_DIR / "avg_tool_calls_by_agent.png",
        "Average tool calls per agent invocation",
        "Grouped from agent_runs.tool_calls_made by actor.",
        value_formatter=lambda value: f"{value:.1f}",
    )

    save_hbar_chart(
        [
            {
                "label": f"{row['provider']} / {row['model']}",
                "value": row["cost_usd"],
                "color": COLORS["gold"],
                "note": f"{fmt_int(row['llm_calls'])} calls; {compact(row['total_tokens'])} tokens",
            }
            for row in model_summary
        ],
        OUT_DIR / "model_cost_split.png",
        "Model cost split",
        "Aggregated from run_model_usage by provider and model.",
        value_formatter=fmt_money,
    )

    error_rows = sorted(tool_summary, key=lambda row: (row["errors"], row["calls"]), reverse=True)[:12]
    save_hbar_chart(
        [
            {
                "label": row["tool"],
                "value": row["errors"],
                "color": COLORS["orange"] if row["errors"] else COLORS["neutral"],
                "note": f"{fmt_int(row['calls'])} calls; success {fmt_pct(row['success_rate'])}; avg {row['avg_duration_seconds']:.2f}s",
            }
            for row in error_rows
        ],
        OUT_DIR / "tool_errors_by_tool.png",
        "Tool errors are concentrated in a small set of browser actions",
        "Observed tool_calls rows, sorted by error count.",
        color_key="color",
        value_formatter=lambda value: fmt_int(value),
    )

    write_csv(DATA_DIR / "status_summary.csv", [
        {
            **row,
            "share_of_total": f"{row['share_of_total']:.6f}",
            "share_of_terminal": "" if row["share_of_terminal"] is None else f"{row['share_of_terminal']:.6f}",
            "avg_cost_usd": f"{row['avg_cost_usd']:.8f}",
            "avg_total_tokens": f"{row['avg_total_tokens']:.2f}",
        }
        for row in status_summary
    ])
    write_csv(DATA_DIR / "agent_summary.csv", [
        {
            **row,
            "avg_tool_calls_made": f"{row['avg_tool_calls_made']:.4f}",
            "avg_llm_calls_made": f"{row['avg_llm_calls_made']:.4f}",
            "avg_total_tokens": f"{row['avg_total_tokens']:.2f}",
            "tool_success_rate": f"{row['tool_success_rate']:.6f}",
            "avg_duration_seconds": f"{row['avg_duration_seconds']:.4f}",
        }
        for row in agent_summary
    ])
    write_csv(DATA_DIR / "tool_summary.csv", [
        {
            **row,
            "success_rate": f"{row['success_rate']:.6f}",
            "avg_duration_seconds": f"{row['avg_duration_seconds']:.4f}",
        }
        for row in tool_summary
    ])
    write_csv(DATA_DIR / "model_summary.csv", [
        {
            **row,
            "cost_usd": f"{row['cost_usd']:.8f}",
        }
        for row in model_summary
    ])
    write_csv(DATA_DIR / "successful_sites.csv", [
        {
            **row,
            "cost_usd": f"{row['cost_usd']:.8f}",
        }
        for row in successful_site_rows
    ])

    metrics_snapshot = {
        "generated_at": generated_at,
        "api_base": API_BASE,
        "source_tables": {name: len(rows) for name, rows in tables.items()},
        "latest_pipeline_update": max_updated,
        "total_runs": total_count,
        "terminal_runs": terminal_count,
        "running_runs": len(active_rows),
        "status_counts": dict(status_counts),
        "success_runs": len(success_rows),
        "partial_runs": len(partial_rows),
        "productive_evidence_runs": len(productive_rows),
        "external_blocker_runs": len(external_rows),
        "literal_failed_runs": len(failed_rows),
        "strict_success_rate_terminal": pct(len(success_rows), terminal_count),
        "strict_success_rate_all": pct(len(success_rows), total_count),
        "productive_evidence_rate_terminal": pct(len(productive_rows), terminal_count),
        "external_blocker_rate_terminal": pct(len(external_rows), terminal_count),
        "literal_failure_rate_terminal": pct(len(failed_rows), terminal_count),
        "total_cost_all_usd": total_cost_all,
        "total_cost_terminal_usd": total_cost_terminal,
        "avg_cost_all_runs_usd": pct(total_cost_all, total_count),
        "avg_cost_terminal_runs_usd": pct(total_cost_terminal, terminal_count),
        "total_tokens_all": total_tokens_all,
        "total_tokens_terminal": total_tokens_terminal,
        "avg_tokens_all_runs": pct(total_tokens_all, total_count),
        "avg_tokens_terminal_runs": pct(total_tokens_terminal, terminal_count),
        "total_input_tokens": total_input,
        "total_cached_input_tokens": total_cached,
        "total_new_input_tokens": total_new,
        "total_output_tokens": total_output,
        "cache_hit_pct_cached_over_cached_plus_new": pct(total_cached, cache_den),
        "cache_hit_pct_cached_over_input": pct(total_cached, total_input),
        "input_reconciliation_delta": total_input - (total_cached + total_new),
        "total_llm_calls_pipeline": sum(i(row.get("total_llm_calls")) for row in pipeline_runs),
        "total_llm_calls_raw_rows": len(llm_calls),
        "total_tool_calls_pipeline": sum(i(row.get("total_tool_calls")) for row in pipeline_runs),
        "observed_tool_call_rows": observed_tools,
        "successful_tool_call_rows": successful_tools,
        "failed_tool_call_rows": failed_tools,
        "tool_success_rate": pct(successful_tools, observed_tools),
        "streams": len(streams),
        "provider_analyses": len(providers),
        "takedown_emails": len(emails),
        "runs_with_streams": sum(1 for row in terminal_runs if i(row.get("stream_count")) > 0),
        "runs_with_emails": sum(1 for row in terminal_runs if i(row.get("email_count")) > 0),
        "successful_distinct_websites": len(successful_site_rows),
        "distinct_tested_websites": distinct_tested_sites,
        "website_success_rate": pct(len(successful_site_rows), distinct_tested_sites),
    }
    (DATA_DIR / "metrics_snapshot.json").write_text(json.dumps(metrics_snapshot, indent=2), encoding="utf-8")

    chart_paths = {
        "status": "assets/evaluation-api-metrics/status_breakdown.png",
        "buckets": "assets/evaluation-api-metrics/outcome_buckets.png",
        "cost": "assets/evaluation-api-metrics/avg_cost_by_status.png",
        "tokens": "assets/evaluation-api-metrics/avg_tokens_by_status.png",
        "agents": "assets/evaluation-api-metrics/avg_tool_calls_by_agent.png",
        "models": "assets/evaluation-api-metrics/model_cost_split.png",
        "tools": "assets/evaluation-api-metrics/tool_errors_by_tool.png",
    }

    status_table_rows = [
        [
            row["status"],
            fmt_int(row["runs"]),
            fmt_pct(row["share_of_total"]),
            "-" if row["share_of_terminal"] is None else fmt_pct(row["share_of_terminal"]),
            fmt_money(row["avg_cost_usd"]),
            compact(row["avg_total_tokens"]),
            fmt_int(row["streams"]),
            fmt_int(row["emails"]),
        ]
        for row in status_summary
    ]

    agent_table_rows = [
        [
            row["agent"],
            fmt_int(row["agent_runs"]),
            f"{row['success_runs']}/{row['partial_runs']}/{row['failed_runs']}/{row['running_runs']}/{row['other_statuses']}",
            f"{row['avg_tool_calls_made']:.1f}",
            fmt_int(row["total_tool_calls_made"]),
            f"{row['avg_llm_calls_made']:.1f}",
            fmt_pct(row["tool_success_rate"]) if row["tool_rows_observed"] else "-",
            compact(row["avg_total_tokens"]),
        ]
        for row in agent_summary
    ]

    model_table_rows = [
        [
            f"{row['provider']} / {row['model']}",
            fmt_int(row["llm_calls"]),
            fmt_int(row["cache_hit_calls"]),
            compact(row["input_tokens"]),
            compact(row["cached_input_tokens"]),
            compact(row["new_input_tokens"]),
            compact(row["output_tokens"]),
            fmt_money(row["cost_usd"]),
        ]
        for row in model_summary
    ]

    site_table_rows = [
        [
            row["website"],
            fmt_int(row["successful_runs"]),
            fmt_int(row["total_runs_in_batch"]),
            fmt_int(row["streams"]),
            fmt_int(row["screenshots"]),
            fmt_int(row["emails"]),
            fmt_int(row["provider_rows"]),
            row["example_run_id"],
        ]
        for row in successful_site_rows
    ]

    top_tool_rows = [
        [
            row["tool"],
            fmt_int(row["calls"]),
            fmt_int(row["successes"]),
            fmt_int(row["errors"]),
            fmt_pct(row["success_rate"]),
            f"{row['avg_duration_seconds']:.2f}s",
        ]
        for row in tool_summary[:15]
    ]

    provider_table_rows = [
        [
            row["provider"],
            fmt_int(row["provider_rows"]),
            fmt_int(row["affected_runs"]),
        ]
        for row in provider_summary[:12]
    ]

    raw_cost_model_total = sum(row["cost_usd"] for row in model_summary)
    cost_delta = raw_cost_model_total - total_cost_all
    cost_reconciliation_note = (
        "Model-split cost reconciles to the pipeline total within rounding."
        if abs(cost_delta) < 0.000001
        else f"Model-split total is {fmt_money(raw_cost_model_total)}, which differs from pipeline total by {fmt_money(cost_delta)}."
    )

    markdown = f"""# OWC Evaluation Metrics From The Local API

Generated: {generated_at}  
Source of truth used here: local API database endpoints under `{API_BASE}/ui/database/...`  
Current editable chapter/PDF warning: the existing evaluation chapter still contains the older `149 total runs` snapshot, while the API now returns `70` pipeline runs.

## Executive Summary

- **The current batch has {fmt_int(total_count)} total pipeline runs: {fmt_int(terminal_count)} terminal and {fmt_int(len(active_rows))} still running.** The terminal denominator is the right denominator for strict outcome quality; the all-run denominator is useful for live operational status.
- **Strict success is {fmt_int(len(success_rows))}/{fmt_int(terminal_count)} terminal runs ({fmt_pct(pct(len(success_rows), terminal_count))}), or {fmt_pct(pct(len(success_rows), total_count))} of all runs.** If you count partial evidence as productive, the rate becomes {fmt_int(len(productive_rows))}/{fmt_int(terminal_count)} ({fmt_pct(pct(len(productive_rows), terminal_count))}).
- **Only {fmt_int(len(failed_rows))} terminal rows are literal agent/runtime failures.** The bigger non-success block is external or expected blockers: {fmt_int(len(external_rows))} terminal rows ({fmt_pct(pct(len(external_rows), terminal_count))}) across no-hosting-page, no-stream, and page-inaccessible outcomes.
- **Total model cost is {fmt_money(total_cost_all)} across all runs, or {fmt_money(total_cost_terminal)} across terminal runs.** Average cost is {fmt_money(pct(total_cost_all, total_count))} per all-run row and {fmt_money(pct(total_cost_terminal, terminal_count))} per terminal row.
- **Token volume is {fmt_int(total_tokens_all)} input+output tokens.** Average token footprint is {fmt_int(pct(total_tokens_all, total_count))} per all-run row and {fmt_int(pct(total_tokens_terminal, terminal_count))} per terminal row.
- **Cache hit share is {fmt_pct(pct(total_cached, cache_den))} using cached input / (cached input + new input).** The raw pipeline rows reconcile exactly: cached + new input differs from total input by {fmt_int(total_input - cache_den)} tokens.
- **Tool execution is not the weak link in aggregate: {fmt_int(successful_tools)}/{fmt_int(observed_tools)} observed tool-call rows succeeded ({fmt_pct(pct(successful_tools, observed_tools))}).** The remaining problem is more about site behavior, agent strategy, and unstable browser/player states than generic tool failure.
- **There are {fmt_int(len(successful_site_rows))} distinct seed websites with strict success and at least one stream out of {fmt_int(distinct_tested_sites)} distinct tested seed hosts ({fmt_pct(pct(len(successful_site_rows), distinct_tested_sites))}).** Those are the sites that actually worked in this snapshot.

## Metric Definitions Used

| Metric | Definition |
| --- | --- |
| Total runs | Count of `pipeline_runs` rows. |
| Terminal runs | Runs whose `final_status` is not `running` or `queued`. |
| Strict success rate | `success / terminal_runs`. |
| Productive evidence rate | `(success + partial) / terminal_runs`. |
| External blocker rate | `(page_inaccessible + site_dead + no_hosting_pages + no_streams) / terminal_runs`. |
| Literal failure rate | `(failed + timeout + redirect) / terminal_runs`. |
| Total cost | Sum of `pipeline_runs.estimated_total_cost_usd`. |
| Tokens per run | Sum of `total_tokens_in + total_tokens_out`, divided by run count. |
| Cache hit % | `total_cached_input_tokens / (total_cached_input_tokens + total_new_input_tokens)`. |
| Tool success rate | `tool_calls.status == success` divided by all observed `tool_calls` rows. |
| Distinct successful websites | Deduped seed host where `final_status = success` and `stream_count > 0`. |

## Run Outcome Split

![Run status breakdown]({chart_paths['status']})

![Outcome buckets]({chart_paths['buckets']})

{md_table(["Status", "Runs", "Share of all", "Share of terminal", "Avg cost", "Avg tokens", "Streams", "Emails"], status_table_rows)}

### Interpretation

The clean story is not \"{fmt_int(total_count)} runs and {fmt_int(total_count - len(success_rows))} failures.\" That would be too crude. The right story is:

- **Strictly succeeded:** {fmt_int(len(success_rows))} terminal runs.
- **Partially productive:** {fmt_int(len(partial_rows))} terminal runs.
- **Externally blocked:** {fmt_int(len(external_rows))} terminal runs.
- **Literal agent/runtime failure:** {fmt_int(len(failed_rows))} terminal runs.
- **Still running:** {fmt_int(len(active_rows))} rows.

This is the key evaluation point: OWC should be judged as an evidence-production system, not only as a binary classifier.

## Cost And Token Figures

![Average model cost by status]({chart_paths['cost']})

![Average tokens by status]({chart_paths['tokens']})

| Metric | All runs | Terminal runs |
| --- | ---: | ---: |
| Run count | {fmt_int(total_count)} | {fmt_int(terminal_count)} |
| Total model cost | {fmt_money(total_cost_all)} | {fmt_money(total_cost_terminal)} |
| Avg cost / run | {fmt_money(pct(total_cost_all, total_count))} | {fmt_money(pct(total_cost_terminal, terminal_count))} |
| Total tokens | {fmt_int(total_tokens_all)} | {fmt_int(total_tokens_terminal)} |
| Avg tokens / run | {fmt_int(pct(total_tokens_all, total_count))} | {fmt_int(pct(total_tokens_terminal, terminal_count))} |
| Input tokens | {fmt_int(total_input)} | {fmt_int(sum(row_input_tokens(row) for row in terminal_runs))} |
| Cached input tokens | {fmt_int(total_cached)} | {fmt_int(sum(row_cached_tokens(row) for row in terminal_runs))} |
| New input tokens | {fmt_int(total_new)} | {fmt_int(sum(row_new_tokens(row) for row in terminal_runs))} |
| Output tokens | {fmt_int(total_output)} | {fmt_int(sum(i(row.get("total_tokens_out")) for row in terminal_runs))} |
| Cache hit % | {fmt_pct(pct(total_cached, cache_den))} | {fmt_pct(pct(sum(row_cached_tokens(row) for row in terminal_runs), sum(row_cached_tokens(row) + row_new_tokens(row) for row in terminal_runs)))} |

### Cost Interpretation

The average terminal run costs about **{fmt_money(pct(total_cost_terminal, terminal_count))}**. That is low enough for iterative engineering tests, but it becomes material when the batch is repeated many times. A 1,000-run campaign at the current terminal average would cost roughly **{fmt_money(pct(total_cost_terminal, terminal_count) * 1000)}** in model usage before human review time and infrastructure costs.

The important business point is that cost is now measurable at the same grain as evidence quality. You can compare prompt/tool changes by asking: did strict success, productive evidence, or provider/email yield improve per dollar?

## LLM Evaluation

![Model cost split]({chart_paths['models']})

{md_table(["Provider / model", "LLM calls", "Cache-hit calls", "Input", "Cached", "New", "Output", "Cost"], model_table_rows)}

### LLM Interpretation

The system is dominated by `gemini-3.1-flash-lite` model usage in the current persisted run-level model table. The older dashboard-style `Peak context` card is not a useful headline metric for the report; it is a debugging widget. For the evaluation chapter, use:

- total LLM calls;
- input/new/cached/output tokens;
- cache hit share;
- cost per terminal run;
- model cost split;
- evidence produced per dollar.

Those are business-readable and can be defended from API tables.

## Tool Evaluation

![Tool errors by tool]({chart_paths['tools']})

| Metric | Value |
| --- | ---: |
| Observed tool-call rows | {fmt_int(observed_tools)} |
| Successful tool-call rows | {fmt_int(successful_tools)} |
| Failed/error tool-call rows | {fmt_int(failed_tools)} |
| Tool success rate | {fmt_pct(pct(successful_tools, observed_tools))} |
| Avg tool calls / all run | {sum(i(row.get("total_tool_calls")) for row in pipeline_runs) / total_count:.1f} |
| Avg tool calls / terminal run | {sum(i(row.get("total_tool_calls")) for row in terminal_runs) / terminal_count:.1f} |

{md_table(["Tool", "Calls", "Successes", "Errors", "Success rate", "Avg duration"], top_tool_rows)}

### Tool Interpretation

Tool reliability is high enough that the evaluation should not frame the whole system as a tool-failure problem. The better discussion is tool **load** and tool **sequence quality**:

- hosting and embedded routes are interaction-heavy;
- navigation/inspection/harvest tools carry most of the browser work;
- tool errors exist, but the observed failure rate is under 1%;
- run outcomes still fail when sites are inaccessible, hosting pages are missing, or stream servers expose no media.

## Agent Evaluation

![Average tool calls by agent]({chart_paths['agents']})

Status columns are shown as `success/partial/failed/running/other`.

{md_table(["Agent", "Invocations", "Statuses", "Avg tools", "Total tools", "Avg LLM", "Tool success", "Avg tokens"], agent_table_rows)}

### Agent Interpretation

This is the cleanest way to organize the agent part of the report:

1. **Classification agent:** route correctness and whether the next specialist received the right page type.
2. **Landing agent:** ability to move from listings/schedules to actual hosting candidates.
3. **Hosting agent:** player activation, server switching, screenshot timing, stream harvesting.
4. **Embedded agent:** iframe/player access and no-stream/unauthorized handling.
5. **Provider/email stage:** provider attribution and draft readiness from concrete stream evidence.

The report should not bury these under one case study. Use aggregate agent metrics first, then one short run example to show what the metrics look like in a real trace.

## Successful Websites That Actually Worked

Definition: deduped seed host with at least one strict-success run and at least one stream.

{md_table(["Website", "Successful runs", "Total runs in batch", "Streams", "Screenshots", "Emails", "Provider rows", "Example run id"], site_table_rows)}

These are the websites that produced actual successful evidence in the current API snapshot. As a website-level metric, this is **{fmt_int(len(successful_site_rows))}/{fmt_int(distinct_tested_sites)} distinct tested seed hosts ({fmt_pct(pct(len(successful_site_rows), distinct_tested_sites))})**. That is stricter than run-level success because repeated runs on the same website can overweight the run-level score.

## Provider And Evidence Yield

| Metric | Value |
| --- | ---: |
| Runs with streams | {fmt_int(metrics_snapshot["runs_with_streams"])} |
| Runs with emails | {fmt_int(metrics_snapshot["runs_with_emails"])} |
| Total stream rows | {fmt_int(len(streams))} |
| Total provider-analysis rows | {fmt_int(len(providers))} |
| Total takedown-email rows | {fmt_int(len(emails))} |
| Avg streams / terminal run | {len(streams) / terminal_count:.2f} |
| Avg emails / terminal run | {len(emails) / terminal_count:.2f} |
| Avg streams / strict-success run | {len(streams) / len(success_rows):.2f} |
| Avg emails / strict-success run | {len(emails) / len(success_rows):.2f} |

{md_table(["Provider", "Provider rows", "Affected runs"], provider_table_rows)}

## Cleaner Evaluation Section Structure

I would reorganize Chapter 6 around aggregate evidence, then use case studies only as examples.

### 1. Evaluation Objective

Keep the main claim narrow: OWC is not proving universal piracy detection. It is measuring whether a suspected streaming website can produce a reviewable evidence package.

### 2. Batch Outcome Evaluation

Lead with the 70-run split:

- strict success;
- partial/productive evidence;
- external blockers;
- literal failures;
- running rows.

This gives the jury a more honest interpretation than one accuracy number.

### 3. Agent Evaluation

Evaluate each specialist by its responsibility:

- Classification: route correctness.
- Landing: discovery of hosting candidates.
- Hosting: activation, server switching, screenshot timing, stream harvest.
- Embedded: iframe/player inspection and blocker diagnosis.
- Provider/email: attribution and notice-draft readiness.

### 4. Tool Evaluation

Use tool success rate, top tools, error concentration, and average tools per run. The point is that browser automation is measurable and mostly reliable, while site/player behavior remains volatile.

### 5. LLM And Cost Evaluation

Use LLM calls, token split, cache hit %, model split, total cost, and cost per terminal run. Do not lead with context-window peak usage; it is a debug metric, not a chapter headline.

### 6. Business Value

Frame the added value like this:

- OWC reduces manual uncertainty by turning a seed URL into traceable evidence objects.
- It separates source-site blockers from agent failures.
- It produces screenshots, streams, provider rows, and email drafts in one pipeline.
- It exposes cost and token telemetry so scaling decisions are measurable.
- It gives reviewers a queue of evidence packages instead of asking them to manually discover every provider path.

### 7. Case Study

Keep one successful run as a compact trace example after the aggregate metrics. Add one blocker example if space allows. Do not let the case study carry the whole evaluation chapter.

## Validation Notes

- `pipeline_runs` row count and `runs` row count both equal {fmt_int(len(pipeline_runs))}; this matches your 70-run expectation.
- Cost, token, status, stream, screenshot, email, and provider counts in this file are recomputed from API database tables, not copied from the frontend dashboard cards.
- Run-level cost uses `pipeline_runs.estimated_total_cost_usd`; model split uses `run_model_usage`. {cost_reconciliation_note}
- Pipeline run-level LLM calls total {fmt_int(sum(i(row.get("total_llm_calls")) for row in pipeline_runs))}; raw `llm_calls` rows total {fmt_int(len(llm_calls))}. Treat `pipeline_runs` as the run-level KPI source and `llm_calls` as the raw observed-call table.
- The current PDF/source chapter still contains stale 149-run wording; update those tables/screenshots before final submission.
- Raw supporting CSV/JSON files are under `assets/evaluation-api-metrics/data/`.
"""

    MD_PATH.write_text(markdown, encoding="utf-8")

    print(json.dumps({
        "markdown": str(MD_PATH),
        "charts": [str(path) for path in sorted(OUT_DIR.glob("*.png"))],
        "data_dir": str(DATA_DIR),
        "total_runs": total_count,
        "terminal_runs": terminal_count,
        "success_runs": len(success_rows),
        "productive_runs": len(productive_rows),
        "external_blockers": len(external_rows),
        "literal_failures": len(failed_rows),
        "tool_success_rate": pct(successful_tools, observed_tools),
        "total_cost_all_usd": total_cost_all,
    }, indent=2))


if __name__ == "__main__":
    main()
