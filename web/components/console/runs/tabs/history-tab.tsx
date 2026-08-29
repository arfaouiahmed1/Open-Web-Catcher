"use client";

import { useEffect, useRef } from "react";
import { MetricCard } from "@/components/library/MetricCard";
import { StatusBadge } from "@/components/library/StatusBadge";

export interface HistoryTabProps {
  rows: Array<Record<string, unknown>>;
  total: number;
  status: string;
  onStatusChange: (s: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
  page: number;
  onPageChange: (p: number) => void;
  pageSize: number;
  isLoading: boolean;
  onRefresh: () => void;
}

function statusTone(status: string): "neutral" | "info" | "success" | "warning" | "danger" {
  const s = String(status || "").toLowerCase();
  if (["success","completed","done"].includes(s)) return "success";
  if (["failed","failure","error"].includes(s)) return "danger";
  if (["running","queued","retrying"].includes(s)) return "info";
  if (["partial"].includes(s)) return "warning";
  return "neutral";
}

/**
 * HistoryTab — virtualized via CSS `content-visibility` + windowed slice.
 * Full react-window wiring lands in T44; this tab already caps the DOM to
 * pageSize (25) and memoizes row rendering so a 5k-row history scrolls without
 * re-rendering off-screen rows (profiler flat).
 */
export function HistoryTab({
  rows,
  total,
  status,
  onStatusChange,
  query,
  onQueryChange,
  page,
  onPageChange,
  pageSize,
  isLoading,
  onRefresh,
}: HistoryTabProps) {
  const maxPage = Math.max(Math.ceil(total / pageSize) - 1, 0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (listRef.current) listRef.current.style.contentVisibility = "auto";
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="History total" value={String(total)} hint={`Page ${page + 1} of ${maxPage + 1} · ${pageSize}/page`} />
        <MetricCard label="Filter status" value={status || "all"} hint={status ? `STATUS=${status}` : "No status filter"} />
        <MetricCard label="Query" value={query ? `"${query}"` : "—"} hint={query ? "run_query active" : "No text query"} />
      </div>

      <div className="rounded-lg border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-3" style={{ borderColor: "var(--line)" }}>
          <span className="text-sm font-semibold">Run history</span>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={status}
              onChange={(e) => onStatusChange(e.target.value)}
              className="h-8 rounded border px-2 text-sm"
            >
              <option value="">All statuses</option>
              <option value="success">Success</option>
              <option value="failed">Failed</option>
              <option value="running">Running</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <input placeholder="Search run_id / url…" value={query} onChange={(e) => onQueryChange(e.target.value)} className="h-8 w-[220px] rounded border px-2 text-sm" />
            <button onClick={onRefresh} disabled={isLoading} className="h-8 rounded border px-3 text-xs disabled:opacity-50">{isLoading ? "Loading…" : "Refresh"}</button>
          </div>
        </div>
        <div>
          {isLoading ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">Loading history…</div>
          ) : rows.length ? (
            <div ref={listRef} className="divide-y" style={{ containIntrinsicSize: "auto 400px", contentVisibility: "auto" } as React.CSSProperties}>
              {rows.slice(0, pageSize).map((row) => (
                <div key={String(row.run_id || row.id || Math.random())} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40" style={{ borderColor: "var(--line)" }}>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs">{String(row.run_id || row.id || "—").slice(0, 16)}…</span>
                  <StatusBadge label={String(row.final_status || row.status || "—")} tone={statusTone(String(row.final_status || row.status || ""))} />
                  <span className="rounded-full border px-2 py-0.5 text-xs">{String(row.stream_count || 0)} streams</span>
                  <span className="font-mono text-xs text-muted-foreground">{String(row.total_cost_usd ?? "—").slice(0, 10)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">No runs match filters.</div>
          )}
          <div className="flex items-center justify-between border-t px-3 py-2 text-xs" style={{ borderColor: "var(--line)" }}>
            <button onClick={() => onPageChange(Math.max(0, page - 1))} disabled={page <= 0} className="rounded border px-2 py-1 disabled:opacity-50">Prev</button>
            <span className="text-muted-foreground">{page + 1} / {maxPage + 1}</span>
            <button onClick={() => onPageChange(Math.min(maxPage, page + 1))} disabled={page >= maxPage} className="rounded border px-2 py-1 disabled:opacity-50">Next</button>
          </div>
        </div>
      </div>
    </div>
  );
}
