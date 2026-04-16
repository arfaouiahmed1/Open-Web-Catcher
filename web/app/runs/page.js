"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Filter } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const PAGE_TYPES = ["", "hosting_page", "landing_page", "embedded_page"];
const STATUSES = ["", "success", "partial", "failed"];

function statusTone(s) {
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
    <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4 space-y-3">
      <div className="text-sm font-semibold text-white">Compare runs</div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => (
          <div key={row.run_id} className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs">
            <div className="font-mono text-slate-200">{row.run_id?.slice(0, 12)}…</div>
            <div className="mt-1 text-slate-500">{row.page_type || "—"}</div>
            <div className="mt-2 space-y-1 text-slate-300">
              <div>tools {formatNumber(row.total_tool_calls)}</div>
              <div>llm {formatNumber(row.total_llm_calls)}</div>
              <div>cost {formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}</div>
            </div>
            <div className="mt-2 h-2 rounded bg-white/10">
              <div className="h-2 rounded bg-signal/60" style={{ width: `${(Number(row.duration_seconds || 0) / maxDuration) * 100}%` }} />
            </div>
            <div className="mt-1 text-slate-600">{Number(row.duration_seconds || 0).toFixed(1)}s</div>
          </div>
        ))}
      </div>
      <div className={`text-xs ${divergence ? "text-amber-300" : "text-slate-600"}`}>
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
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-signal">Run History</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">All workflow runs</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Filter, browse, compare, and drill into every persisted orchestrator run.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
        <Filter className="h-3.5 w-3.5 text-slate-600 shrink-0" />
        <select
          value={status}
          onChange={(e) => { setStatus(e.target.value); setOffset(0); }}
          className="rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-slate-300 focus:border-signal/50 focus:outline-none"
        >
          {STATUSES.map((s) => <option key={s || "all"} value={s}>{s || "All statuses"}</option>)}
        </select>
        <select
          value={pageType}
          onChange={(e) => { setPageType(e.target.value); setOffset(0); }}
          className="rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-slate-300 focus:border-signal/50 focus:outline-none"
        >
          {PAGE_TYPES.map((t) => <option key={t || "all"} value={t}>{t || "All page types"}</option>)}
        </select>
        <span className="ml-auto text-xs text-slate-600">
          {formatNumber(total)} run{total !== 1 ? "s" : ""} · page {page} of {pages} · {selected.length} selected
        </span>
        <Button variant="ghost" size="sm" onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0} className="border border-white/10 h-8 px-2">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOffset(offset + limit)} disabled={offset + limit >= total} className="border border-white/10 h-8 px-2">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <ComparePanel rows={selectedRows} />

      <div className="rounded-xl border border-white/8 bg-white/[0.03] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-white/6">
                {["", "Run ID", "Status", "Page type", "Streams", "LLM", "Tools", "Tokens", "Cost", "Duration", "Date"].map((h) => (
                  <th key={h || "select"} className="px-4 py-2.5 text-left text-xs font-medium text-slate-500 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((row) => (
                <tr key={row.run_id} className="border-b border-white/4 text-slate-300 hover:bg-white/[0.03] transition-colors">
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
                    <Link href={`/runs/${row.run_id}`} className="font-mono text-xs text-signal hover:text-white transition-colors">
                      {row.run_id?.slice(0, 12)}…
                    </Link>
                    <div className="mt-0.5 max-w-[200px] truncate text-xs text-slate-600" title={row.url}>{row.url}</div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <Badge tone={statusTone(row.final_status)}>{row.final_status}</Badge>
                  </td>
                  <td className="px-4 py-3 align-top text-xs text-slate-400">{row.page_type || "—"}</td>
                  <td className="px-4 py-3 align-top tabular-nums">{formatNumber(row.stream_count)}</td>
                  <td className="px-4 py-3 align-top tabular-nums">{formatNumber(row.total_llm_calls)}</td>
                  <td className="px-4 py-3 align-top tabular-nums">{formatNumber(row.total_tool_calls)}</td>
                  <td className="px-4 py-3 align-top tabular-nums">{formatNumber((row.total_tokens_in || 0) + (row.total_tokens_out || 0))}</td>
                  <td className="px-4 py-3 align-top tabular-nums">
                    {formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}
                  </td>
                  <td className="px-4 py-3 align-top tabular-nums text-xs">{Number(row.duration_seconds || 0).toFixed(1)}s</td>
                  <td className="px-4 py-3 align-top text-xs text-slate-600 whitespace-nowrap">
                    {row.created_at ? new Date(row.created_at).toLocaleString() : "—"}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={11} className="px-4 py-10 text-center text-sm text-slate-600">
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
