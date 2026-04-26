"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Filter } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

const PAGE_TYPES = ["", "hosting_page", "landing_page", "embedded_page"];
const STATUSES = ["", "running", "success", "partial", "failed", "cancelled"];

function statusTone(s) {
  if (s === "running") return "signal";
  if (s === "cancelled") return "warning";
  if (s === "success") return "success";
  if (s === "partial") return "warning";
  return "danger";
}

function ComparePanel({ rows = [] }) {
  if (rows.length < 2) return null;
  const maxDuration = Math.max(...rows.map((row) => Number(row.duration_seconds || 0)), 1);
  const sortedTools = [...rows].sort((a, b) => Number(b.total_tool_calls || 0) - Number(a.total_tool_calls || 0));
  const divergence = sortedTools[0]?.run_id !== sortedTools[rows.length - 1]?.run_id;

  return (
    <div
      className="rounded-[14px] border p-4 space-y-3"
      style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      <div className="text-[13.5px] font-medium text-[var(--ink)]">Compare runs</div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => (
          <div
            key={row.run_id}
            className="rounded-[10px] border px-3 py-2.5"
            style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)" }}
          >
            <div className="font-mono text-[12px] text-[var(--ink)]">{row.run_id?.slice(0, 12)}…</div>
            <div className="mt-0.5 text-[11px] text-[var(--mute)]">{row.page_type || "—"}</div>
            <div className="mt-2 space-y-1 text-[12px] text-[var(--ink-dim)]">
              <div>tools {formatNumber(row.total_tool_calls)}</div>
              <div>llm {formatNumber(row.total_llm_calls)}</div>
              <div>cost {formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}</div>
            </div>
            <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: "var(--line)" }}>
              <div
                className="h-1.5 rounded-full"
                style={{ width: `${(Number(row.duration_seconds || 0) / maxDuration) * 100}%`, background: "color-mix(in oklch, var(--signal) 60%, transparent)" }}
              />
            </div>
            <div className="mt-1 text-[11px] text-[var(--mute)]">{Number(row.duration_seconds || 0).toFixed(1)}s</div>
          </div>
        ))}
      </div>
      <div className="text-[12px]" style={{ color: divergence ? "var(--signal)" : "var(--mute)" }}>
        {divergence
          ? "Divergence detected: selected runs have different tool-call intensity."
          : "No significant divergence in selected runs."}
      </div>
    </div>
  );
}

export default function RunsPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [pageType, setPageType] = useState("");
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [isLoading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiFetch(`/ui/runs?limit=${limit}&offset=${offset}&status=${encodeURIComponent(status)}&page_type=${encodeURIComponent(pageType)}`)
      .then((p) => { if (!cancelled) { setRows(p.rows || []); setTotal(p.total || 0); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [limit, offset, status, pageType]);

  const pages = Math.ceil(total / limit) || 1;
  const page = Math.floor(offset / limit) + 1;
  const selectedRows = useMemo(() => rows.filter((row) => selected.includes(row.run_id)), [rows, selected]);

  return (
    <div className="space-y-5">

      {/* page header */}
      <div>
        <span className="owc-eyebrow">run history · all workflows</span>
        <h1 className="mt-2 text-3xl font-semibold text-[var(--ink)]">
          Pipeline runs
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          Filter, browse, compare, and drill into every persisted orchestrator run.
        </p>
      </div>

      {/* filter bar */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-[14px] border px-4 py-3"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        <Filter className="h-3.5 w-3.5 shrink-0 text-[var(--mute)]" />
        <Select
          className="min-w-[210px]"
          value={status}
          onChange={(value) => { setStatus(value); setOffset(0); }}
          options={STATUSES.map((item) => ({
            value: item,
            label: item || "All statuses",
          }))}
        />
        <Select
          className="min-w-[220px]"
          value={pageType}
          onChange={(value) => { setPageType(value); setOffset(0); }}
          options={PAGE_TYPES.map((item) => ({
            value: item,
            label: item || "All page types",
          }))}
        />
        <span className="ml-auto text-[12px] text-[var(--mute)]">
          {formatNumber(total)} run{total !== 1 ? "s" : ""} · page {page} of {pages} · {selected.length} selected
        </span>
        <Button variant="ghost" size="sm" onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0} className="border border-[var(--line)] h-8 px-2">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOffset(offset + limit)} disabled={offset + limit >= total} className="border border-[var(--line)] h-8 px-2">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <ComparePanel rows={selectedRows} />

      {/* table */}
      <div
        className="rounded-[14px] border overflow-hidden"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead>
              <tr className="border-b" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.012)" }}>
                {["", "Run ID", "Status", "Page type", "Streams", "LLM", "Tools", "Tokens", "Cost", "Duration", "Date"].map((h) => (
                  <th key={h || "select"} className="px-4 py-2.5 text-left text-[10.5px] font-medium uppercase tracking-[0.1em] whitespace-nowrap" style={{ color: "var(--mute)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((row) => (
                <tr
                  key={row.run_id}
                  className="border-b transition-colors"
                  style={{ borderColor: "var(--line)" }}
                  onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.02)"}
                  onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
                >
                  <td className="px-4 py-3 align-top">
                    <input
                      type="checkbox"
                      checked={selected.includes(row.run_id)}
                      onChange={(e) => {
                        setSelected((current) => {
                          if (e.target.checked) return Array.from(new Set([...current, row.run_id])).slice(0, 4);
                          return current.filter((item) => item !== row.run_id);
                        });
                      }}
                    />
                  </td>
                  <td className="px-4 py-3 align-top">
                    <Link href={`/runs/${row.run_id}`} className="font-mono text-[12px] transition-colors" style={{ color: "var(--signal)" }}>
                      {row.run_id?.slice(0, 12)}…
                    </Link>
                    <div className="mt-0.5 max-w-[200px] truncate text-[11px] text-[var(--mute)]" title={row.url}>{row.url}</div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <Badge tone={statusTone(row.final_status)}>{row.final_status}</Badge>
                  </td>
                  <td className="px-4 py-3 align-top text-[12px] text-[var(--mute)]">{row.page_type || "—"}</td>
                  <td className="px-4 py-3 align-top tabular-nums text-[var(--ink-dim)]">{formatNumber(row.stream_count)}</td>
                  <td className="px-4 py-3 align-top tabular-nums text-[var(--ink-dim)]">{formatNumber(row.total_llm_calls)}</td>
                  <td className="px-4 py-3 align-top tabular-nums text-[var(--ink-dim)]">{formatNumber(row.total_tool_calls)}</td>
                  <td className="px-4 py-3 align-top tabular-nums text-[var(--ink-dim)]">{formatNumber((row.total_tokens_in || 0) + (row.total_tokens_out || 0))}</td>
                  <td className="px-4 py-3 align-top tabular-nums text-[var(--ink-dim)]">
                    {formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}
                  </td>
                  <td className="px-4 py-3 align-top tabular-nums text-[12px] text-[var(--ink-dim)]">{Number(row.duration_seconds || 0).toFixed(1)}s</td>
                  <td className="px-4 py-3 align-top text-[11px] whitespace-nowrap text-[var(--mute)]">
                    {row.created_at ? new Date(row.created_at).toLocaleString() : "—"}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={11} className="px-4 py-12 text-center text-[13px] text-[var(--mute)]">
                    {isLoading ? "Loading…" : "No runs matched this filter"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
