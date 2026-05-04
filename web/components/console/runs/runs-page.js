"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Filter,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import {
  canCancelRun,
  canDeleteRun,
  RUN_STATUSES,
  statusLabel,
  statusTone,
} from "@/lib/run-status";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { PageHeader } from "@/components/console/common/page-header";
import { ConfirmAction } from "@/components/console/common/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ComparePanel, ModelBadge } from "@/components/runs/run-compare-panel";

const AUTO_REFRESH_MS = 15_000;

const ACTORS = [
  "",
  "orchestrator",
  "classification",
  "landing",
  "hosting",
  "embedded",
];

const PAGE_TYPES = [
  "",
  "hosting_page",
  "landing_page",
  "embedded_page",
  "unknown",
];

const HEADINGS = [
  "",
  "Run",
  "Status",
  "Actor",
  "Model",
  "Page",
  "Parallel",
  "Tokens",
  "Cost",
  "Duration",
  "Actions",
  "Date",
];

function SkeletonRows({ count = 5 }) {
  return Array.from({ length: count }).map((_, i) => (
    <TableRow key={i}>
      {HEADINGS.map((h, j) => (
        <TableCell key={j}>
          <Skeleton className="h-4 w-full" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

export function RunsPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [pageType, setPageType] = useState("");
  const [actor, setActor] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [isLoading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]);
  const [reloadTick, setReloadTick] = useState(0);
  const [busyRunId, setBusyRunId] = useState("");
  const [isBulkCancelling, setIsBulkCancelling] = useState(false);
  const hasRunning = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      status,
      page_type: pageType,
      actor,
      query: search,
    });
    apiFetch(`/ui/runs?${params.toString()}`)
      .then((payload) => {
        if (!cancelled) {
          const fetched = payload.rows || [];
          setRows(fetched);
          setTotal(payload.total || 0);
          hasRunning.current = fetched.some(
            (r) => r.final_status === "running" || r.final_status === "queued",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actor, limit, offset, pageType, reloadTick, search, status]);

  // Auto-refresh when any rows are still running/queued
  useEffect(() => {
    const timer = setInterval(() => {
      if (hasRunning.current) setReloadTick((v) => v + 1);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  async function cancelRun(runId) {
    setBusyRunId(runId);
    try {
      await fetch(apiUrl(`/ui/runs/${runId}/cancel`), { method: "POST" });
      setReloadTick((v) => v + 1);
    } finally {
      setBusyRunId("");
    }
  }

  async function deleteRun(runId) {
    setBusyRunId(runId);
    try {
      await fetch(apiUrl(`/ui/runs/${runId}`), { method: "DELETE" });
      setSelected((current) => current.filter((item) => item !== runId));
      setReloadTick((v) => v + 1);
    } finally {
      setBusyRunId("");
    }
  }

  async function cancelActiveRuns() {
    setIsBulkCancelling(true);
    try {
      await fetch(apiUrl("/ui/runs/cancel-active"), { method: "POST" });
      setSelected([]);
      setReloadTick((v) => v + 1);
    } finally {
      setIsBulkCancelling(false);
    }
  }

  const pages = Math.ceil(total / limit) || 1;
  const page = Math.floor(offset / limit) + 1;
  const selectedRows = useMemo(
    () => rows.filter((row) => selected.includes(row.run_id)),
    [rows, selected],
  );

  function toggleSelection(runId, checked) {
    setSelected((current) => {
      if (checked) return Array.from(new Set([...current, runId])).slice(0, 4);
      return current.filter((item) => item !== runId);
    });
  }

  function resetFilters() {
    setStatus("");
    setPageType("");
    setActor("");
    setSearch("");
    setOffset(0);
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <PageHeader
          eyebrow="run history / all workflows"
          title="Pipeline runs"
          description="Filter, compare, cancel, delete, and drill into persisted workflow and agent runs."
        />

        {/* Filter card */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-base">Filters</CardTitle>
                <CardDescription className="mt-0.5">
                  Search runs by ID, URL, actor, or model, then narrow by status, page type, or actor.
                </CardDescription>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1.5 text-xs text-muted-foreground"
                onClick={() => setReloadTick((v) => v + 1)}
                disabled={isLoading}
              >
                <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Search + selects */}
            <div className="flex flex-wrap items-center gap-3">
              <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <div className="relative min-w-[240px] flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
                  placeholder="Search run ID, URL, actor, provider, model…"
                  className="pl-9"
                />
              </div>
              <Select
                className="w-[180px]"
                value={status}
                onChange={(v) => { setStatus(v); setOffset(0); }}
                options={RUN_STATUSES.map((s) => ({
                  value: s,
                  label: s ? statusLabel(s) : "All statuses",
                }))}
              />
              <Select
                className="w-[200px]"
                value={pageType}
                onChange={(v) => { setPageType(v); setOffset(0); }}
                options={PAGE_TYPES.map((t) => ({
                  value: t,
                  label: t || "All page types",
                }))}
              />
              <Select
                className="w-[180px]"
                value={actor}
                onChange={(v) => { setActor(v); setOffset(0); }}
                options={ACTORS.map((a) => ({
                  value: a,
                  label: a || "All actors",
                }))}
              />
            </div>

            {/* Quick-filter buttons + pagination */}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={status === "running" ? "accent" : "outline"}
                size="sm"
                onClick={() => { setStatus(status === "running" ? "" : "running"); setOffset(0); }}
              >
                Active
              </Button>
              <Button
                variant={status === "failed" ? "accent" : "outline"}
                size="sm"
                onClick={() => { setStatus(status === "failed" ? "" : "failed"); setOffset(0); }}
              >
                Failed
              </Button>
              <ConfirmAction
                title="Cancel all active runs?"
                description="Queued and running jobs will be cancelled and active MCP sessions will be torn down."
                actionLabel="Cancel active runs"
                actionVariant="danger"
                onConfirm={cancelActiveRuns}
                trigger={(
                  <Button variant="outline" size="sm" disabled={isBulkCancelling}>
                    <XCircle className="mr-1.5 h-3.5 w-3.5" />
                    {isBulkCancelling ? "Cancelling…" : "Cancel active"}
                  </Button>
                )}
              />
              <Button variant="ghost" size="sm" onClick={resetFilters} className="text-muted-foreground">
                Reset
              </Button>

              <span className="ml-auto text-xs text-muted-foreground">
                {formatNumber(total)} run{total !== 1 ? "s" : ""} · page {page}/{pages}
                {selected.length > 0 && ` · ${selected.length} selected`}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
                className="h-8 w-8 p-0"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total}
                className="h-8 w-8 p-0"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Compare panel — only when rows selected */}
        {selectedRows.length > 0 && <ComparePanel rows={selectedRows} />}

        {/* Table */}
        <Card className="overflow-hidden">
          <Table className="min-w-full text-sm">
            <TableHeader className="bg-muted/40">
              <TableRow>
                {HEADINGS.map((heading) => (
                  <TableHead key={heading || "select"} className="whitespace-nowrap text-xs">
                    {heading}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <SkeletonRows count={Math.min(limit, 8)} />
              ) : rows.length ? (
                rows.map((row) => (
                  <TableRow key={row.run_id} className="group">
                    <TableCell className="align-top">
                      <Checkbox
                        checked={selected.includes(row.run_id)}
                        onCheckedChange={(checked) => toggleSelection(row.run_id, checked === true)}
                        aria-label={`Select run ${row.run_id}`}
                      />
                    </TableCell>
                    <TableCell className="align-top">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link
                            href={`/runs/${row.run_id}`}
                            className="font-mono text-xs text-primary transition-colors hover:underline"
                          >
                            {row.run_id?.slice(0, 12)}…
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent side="right" className="font-mono text-xs">
                          {row.run_id}
                        </TooltipContent>
                      </Tooltip>
                      <div
                        className="mt-0.5 max-w-[220px] truncate text-xs text-muted-foreground"
                        title={row.url}
                      >
                        {row.url}
                      </div>
                    </TableCell>
                    <TableCell className="align-top">
                      <Badge tone={statusTone(row.final_status)}>
                        {statusLabel(row.final_status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="align-top text-xs text-muted-foreground">
                      <div>{row.root_actor || "--"}</div>
                      {row.job?.status ? (
                        <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground/70">
                          {row.job.display_status || row.job.status}
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell className="align-top">
                      {row.primary_model ? (
                        <ModelBadge provider={row.primary_provider} model={row.primary_model} />
                      ) : (
                        <span className="text-xs text-muted-foreground">--</span>
                      )}
                    </TableCell>
                    <TableCell className="align-top text-xs text-muted-foreground">
                      {row.page_type || "--"}
                    </TableCell>
                    <TableCell className="align-top tabular-nums text-xs">
                      {formatNumber(row.max_parallel_agents || 0)}
                    </TableCell>
                    <TableCell className="align-top tabular-nums text-xs">
                      {formatNumber(
                        (row.total_tokens_in || 0) + (row.total_tokens_out || 0),
                      )}
                    </TableCell>
                    <TableCell className="align-top tabular-nums text-xs">
                      {formatCurrency(
                        row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0,
                      )}
                    </TableCell>
                    <TableCell className="align-top tabular-nums text-xs">
                      {Number(row.duration_seconds || 0).toFixed(1)}s
                    </TableCell>
                    <TableCell className="align-top">
                      <div className="flex flex-wrap gap-1.5">
                        {canCancelRun(row) ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={() => cancelRun(row.run_id)}
                            disabled={busyRunId === row.run_id}
                          >
                            <XCircle className="mr-1 h-3 w-3" />
                            Cancel
                          </Button>
                        ) : null}
                        {canDeleteRun(row) ? (
                          <ConfirmAction
                            title="Delete this run?"
                            description="Removes the run and its persisted telemetry. Cannot be undone."
                            actionLabel="Delete run"
                            onConfirm={() => deleteRun(row.run_id)}
                            trigger={(
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                disabled={busyRunId === row.run_id}
                              >
                                <Trash2 className="mr-1 h-3 w-3" />
                                Delete
                              </Button>
                            )}
                          />
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top text-xs text-muted-foreground">
                      {row.created_at ? new Date(row.created_at).toLocaleString() : "--"}
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={HEADINGS.length} className="py-16 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <Filter className="h-8 w-8 text-muted-foreground/30" />
                      <p className="text-sm text-muted-foreground">No runs matched this filter</p>
                      <Button variant="ghost" size="sm" onClick={resetFilters} className="text-xs">
                        Reset filters
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </Card>
      </div>
    </TooltipProvider>
  );
}
