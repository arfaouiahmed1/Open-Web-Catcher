"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Filter,
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ComparePanel, ModelBadge } from "@/components/runs/run-compare-panel";

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
          setRows(payload.rows || []);
          setTotal(payload.total || 0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actor, limit, offset, pageType, reloadTick, search, status]);

  async function cancelRun(runId) {
    setBusyRunId(runId);
    try {
      await fetch(apiUrl(`/ui/runs/${runId}/cancel`), { method: "POST" });
      setReloadTick((value) => value + 1);
    } finally {
      setBusyRunId("");
    }
  }

  async function deleteRun(runId) {
    setBusyRunId(runId);
    try {
      await fetch(apiUrl(`/ui/runs/${runId}`), { method: "DELETE" });
      setSelected((current) => current.filter((item) => item !== runId));
      setReloadTick((value) => value + 1);
    } finally {
      setBusyRunId("");
    }
  }

  async function cancelActiveRuns() {
    setIsBulkCancelling(true);
    try {
      await fetch(apiUrl("/ui/runs/cancel-active"), { method: "POST" });
      setSelected([]);
      setReloadTick((value) => value + 1);
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
      if (checked) {
        return Array.from(new Set([...current, runId])).slice(0, 4);
      }
      return current.filter((item) => item !== runId);
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="run history / all workflows"
        title="Pipeline runs"
        description="Filter, compare, cancel, delete, and drill into persisted workflow and agent runs from one consistent table."
      />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Filters</CardTitle>
          <CardDescription>
            Search the run archive, narrow by status, page type, or actor, and
            jump between the active and failed views.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Filter className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="relative min-w-[240px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setOffset(0);
                }}
                placeholder="Search run ID, URL, actor, provider, model..."
                className="pl-9"
              />
            </div>
            <Select
              className="min-w-[180px]"
              value={status}
              onChange={(value) => {
                setStatus(value);
                setOffset(0);
              }}
              options={RUN_STATUSES.map((item) => ({
                value: item,
                label: item ? statusLabel(item) : "All statuses",
              }))}
            />
            <Select
              className="min-w-[200px]"
              value={pageType}
              onChange={(value) => {
                setPageType(value);
                setOffset(0);
              }}
              options={PAGE_TYPES.map((item) => ({
                value: item,
                label: item || "All page types",
              }))}
            />
            <Select
              className="min-w-[180px]"
              value={actor}
              onChange={(value) => {
                setActor(value);
                setOffset(0);
              }}
              options={ACTORS.map((item) => ({
                value: item,
                label: item || "All actors",
              }))}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={status === "running" ? "accent" : "outline"}
              size="sm"
              onClick={() => {
                setStatus("running");
                setOffset(0);
              }}
            >
              Active
            </Button>
            <Button
              variant={status === "failed" ? "accent" : "outline"}
              size="sm"
              onClick={() => {
                setStatus("failed");
                setOffset(0);
              }}
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
                  {isBulkCancelling ? "Cancelling active..." : "Cancel active runs"}
                </Button>
              )}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setStatus("");
                setPageType("");
                setActor("");
                setSearch("");
                setOffset(0);
              }}
            >
              Reset filters
            </Button>
            <span className="ml-auto text-sm text-muted-foreground">
              {formatNumber(total)} run{total !== 1 ? "s" : ""} / page {page} of{" "}
              {pages} / {selected.length} selected
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset(Math.max(0, offset - limit))}
              disabled={offset === 0}
              className="h-8 px-2"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset(offset + limit)}
              disabled={offset + limit >= total}
              className="h-8 px-2"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>

      <ComparePanel rows={selectedRows} />

      <Card className="overflow-hidden">
        <Table className="min-w-full text-sm">
          <TableHeader className="bg-muted/50">
            <TableRow>
              {HEADINGS.map((heading) => (
                <TableHead key={heading || "select"} className="whitespace-nowrap">
                  {heading}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((row) => (
                <TableRow key={row.run_id}>
                  <TableCell className="align-top">
                    <Checkbox
                      checked={selected.includes(row.run_id)}
                      onCheckedChange={(checked) => toggleSelection(row.run_id, checked === true)}
                      aria-label={`Select run ${row.run_id}`}
                    />
                  </TableCell>
                  <TableCell className="align-top">
                    <Link
                      href={`/runs/${row.run_id}`}
                      className="font-mono text-xs text-primary transition-colors hover:underline"
                    >
                      {row.run_id?.slice(0, 12)}...
                    </Link>
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
                  <TableCell className="align-top text-sm text-muted-foreground">
                    <div>{row.root_actor || "--"}</div>
                    {row.job?.status ? (
                      <div className="mt-0.5 font-mono text-[10.5px] text-muted-foreground">
                        {row.job.display_status || row.job.status}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="align-top">
                    {row.primary_model ? (
                      <ModelBadge
                        provider={row.primary_provider}
                        model={row.primary_model}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">--</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top text-sm text-muted-foreground">
                    {row.page_type || "--"}
                  </TableCell>
                  <TableCell className="align-top text-sm text-foreground">
                    {formatNumber(row.max_parallel_agents || 0)}
                  </TableCell>
                  <TableCell className="align-top tabular-nums text-foreground">
                    {formatNumber(
                      (row.total_tokens_in || 0) + (row.total_tokens_out || 0),
                    )}
                  </TableCell>
                  <TableCell className="align-top tabular-nums text-foreground">
                    {formatCurrency(
                      row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0,
                    )}
                  </TableCell>
                  <TableCell className="align-top tabular-nums text-sm text-foreground">
                    {Number(row.duration_seconds || 0).toFixed(1)}s
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-wrap gap-2">
                      {canCancelRun(row) ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => cancelRun(row.run_id)}
                          disabled={busyRunId === row.run_id}
                        >
                          <XCircle className="mr-1.5 h-3.5 w-3.5" />
                          Cancel
                        </Button>
                      ) : null}
                      {canDeleteRun(row) ? (
                        <ConfirmAction
                          title="Delete this run?"
                          description="This removes the run and its persisted telemetry. The action cannot be undone."
                          actionLabel="Delete run"
                          onConfirm={() => deleteRun(row.run_id)}
                          trigger={(
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyRunId === row.run_id}
                            >
                              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
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
                <TableCell
                  colSpan={12}
                  className="py-12 text-center text-sm text-muted-foreground"
                >
                  {isLoading ? "Loading..." : "No runs matched this filter"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
