"use client";

import Link from "next/link";
import React, { memo, useEffect, useRef, useState } from "react";
import { History, Search, ListFilter } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";
import { StatusBadge } from "@/components/library/StatusBadge";
import { VirtualizedList } from "@/components/library/VirtualizedList";
import { EmptyState } from "@/components/console/common/empty-state";
import { LoadingView } from "@/components/console/common/loading-view";
import { SectionPanel } from "@/components/console/common/section-panel";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { statusTone } from "@/lib/run-status";
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
const HistoryRow = memo(function HistoryRow({ row }: { row: Record<string, unknown> }) {
  const runId = String(row.run_id || row.id || "");
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors" style={{ borderColor: "var(--line)" }}>
      <Link
        href={`/runs/${encodeURIComponent(runId)}`}
        className="min-w-0 flex-1 truncate font-mono text-xs hover:underline hover:text-foreground"
      >
        {runId ? `${runId.slice(0, 16)}…` : "—"}
      </Link>
      <StatusBadge label={String(row.final_status || row.status || "—")} tone={statusTone(String(row.final_status || row.status || ""))} />
      <Badge tone="muted" className="text-[10px]">{String(row.stream_count || 0)} streams</Badge>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">{String(row.total_cost_usd ?? "—").slice(0, 10)}</span>
    </div>
  );
});

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
  const [queryInput, setQueryInput] = useState(query);

  useEffect(() => {
    setQueryInput(query);
  }, [query]);

  useEffect(() => {
    if (queryInput === query) return;
    const timeout = window.setTimeout(() => onQueryChange(queryInput), 280);
    return () => window.clearTimeout(timeout);
  }, [onQueryChange, query, queryInput]);

  useEffect(() => {
    if (listRef.current) listRef.current.style.contentVisibility = "auto";
  }, [rows]);

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="History total" value={String(total)} hint={`Page ${page + 1} of ${maxPage + 1} · ${pageSize}/page`} />
        <MetricCard label="Filter status" value={status || "all"} hint={status ? `STATUS=${status}` : "No status filter"} />
        <MetricCard label="Query" value={query ? `"${query}"` : "—"} hint={query ? "run_query active" : "No text query"} />
      </div>

      <SectionPanel title="Run history" description="VirtualizedList + LazyCharts when >50 rows · SSE live, no polling" icon={<History className="h-3.5 w-3.5" />} actions={<Badge tone="muted" className="font-mono text-[10px]">{total} total</Badge>}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-3" style={{ borderColor: "var(--line)" }}>
          <span className="flex items-center gap-1.5 text-sm font-semibold"><ListFilter className="h-3.5 w-3.5 text-muted-foreground" /> Run history</span>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={status} onChange={(v) => onStatusChange(v)} options={[{ value: "", label: "All statuses" },{ value: "success", label: "Success" },{ value: "failed", label: "Failed" },{ value: "running", label: "Running" },{ value: "cancelled", label: "Cancelled" }]} placeholder="Status" className="w-[160px]" />
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input placeholder="Search run_id / url…" value={queryInput} onChange={(e) => setQueryInput(e.target.value)} className="h-8 w-[220px] pl-8" />
            </div>
            <Button variant="outline" size="sm" className="h-8 px-3 text-xs" onClick={onRefresh} disabled={isLoading}>{isLoading ? "Loading…" : "Refresh"}</Button>
          </div>
        </div>
        <div>
          {isLoading ? (
            <LoadingView label="Loading history…" variant="skeleton" rows={3} />
          ) : rows.length ? (
            <div ref={listRef} className="divide-y">
              {rows.length > 10 ? (
                <VirtualizedList
                  items={rows}
                  height={320}
                  itemSize={48}
                  renderItem={(row) => <HistoryRow row={row as Record<string, unknown>} />}
                />
              ) : (
                rows.map((row) => (
                  <HistoryRow key={String(row.run_id || row.id || Math.random())} row={row as Record<string, unknown>} />
                ))
              )}
            </div>
          ) : (
            <EmptyState tone="search" title="No runs match filters" description="Try clearing status or text query. History is paged server-side with visibility refresh (no setInterval)." />
          )}
          <div className="flex items-center justify-between border-t px-3 py-2.5 text-xs" style={{ borderColor: "var(--line)" }}>
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => onPageChange(Math.max(0, page - 1))} disabled={page <= 0}>Prev</Button>
            <span className="font-mono text-muted-foreground">{page + 1} / {maxPage + 1}</span>
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={() => onPageChange(Math.min(maxPage, page + 1))} disabled={page >= maxPage}>Next</Button>
          </div>
        </div>
      </SectionPanel>
    </div>
  );
}
