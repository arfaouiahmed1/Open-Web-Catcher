"use client";

/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  BarChart3,
  Bot,
  CheckCircle2,
  Clock,
  Database,
  Edit3,
  ExternalLink,
  Eye,
  Globe2,
  Image as ImageIcon,
  Layers3,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";

import { apiFetch, apiUrl, eventSourceUrl } from "@/lib/api";
import { SitesTab } from "./tabs/sites-tab";
import { BatchesTab } from "./tabs/batches-tab";
import { HistoryTab } from "./tabs/history-tab";
import {
  datasetRunStatus,
  estimateRunCostFromApi,
  effectiveRunCost,
  runTokenTotal,
  statusToneForDataset,
  summarizeStatusMetrics,
  summarizeModelUsage,
  toNumber,
} from "@/lib/dataset-runs";
import { loadPricing } from "@/lib/pricing";
import {
  canCancelRun,
  canDeleteRun,
  RUN_STATUSES,
  statusLabel,
  statusTone,
} from "@/lib/run-status";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { ConfirmAction } from "@/components/console/common/confirm-action";
import { PageHeader } from "@/components/console/common/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatTime, formatTimestamp, parseTimestamp } from "@/lib/datetime";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// (AUTO_REFRESH_MS removed — plan task 42: dataset sync is SSE-primary with
    // visibility-based fallback, not a timer.)
const CUSTOM_LANGUAGE = "__custom__";
const EMPTY_ARRAY: any[] = [];
const EMPTY_OBJECT = {};
const HISTORY_PAGE_SIZE = 25;
const RUN_TABS = new Set(["sites", "batches", "history"]);
const HISTORY_STATUS_FILTERS = RUN_STATUSES.filter((status) => status !== "redirect").map((status) => ({
  value: status,
  label: status ? statusLabel(status) : "All",
}));

const FALLBACK_LANGUAGES = [
  "english",
  "arabic",
  "spanish",
  "french",
  "portuguese",
  "turkish",
  "russian",
  "persian",
  "hindi",
  "other",
];

const FALLBACK_LABELS = ["piracy", "sports", "news", "entertainment", "unknown"];

// formatDate/formatTime come from @/lib/datetime (plan task 33 Z-safe parsing).

function formatDuration(seconds: any) {
  const value = Number(seconds || 0);
  if (!value) return "--";
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}

function pct(value: any, digits = 1) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0%";
  return `${number.toFixed(digits)}%`;
}

function formatRelativeTime(value: any) {
  if (!value) return "never";
  const parsed = parseTimestamp(value);
  const ts = parsed ? parsed.getTime() : NaN;
  if (!Number.isFinite(ts)) return "--";
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  return `${Math.floor(deltaSec / 3600)}h ago`;
}

function compactRunId(runId: any) {
  const value = String(runId || "");
  return value ? `${value.slice(0, 12)}...` : "--";
}

function loggedDatasetRunCost(row = {}) {
  // @ts-expect-error -- strict migration
  const run = row.run || {};
  return (
    toNumber(run.estimated_total_cost_usd, 0)
    || toNumber((row as any).total_cost_usd, 0)
    || toNumber((row as any).estimated_total_cost_usd, 0)
  );
}

function batchCostSourceLabel(source: any) {
  if (source === "logged") return "logged";
  if (source === "estimated") return "estimated";
  if (source === "estimated_partial") return "partially estimated";
  if (source === "estimating") return "estimating";
  if (source === "unavailable") return "pricing unavailable";
  if (source === "partial") return "partial pricing";
  return "no pricing";
}

function languageOptions(metaLanguages = [], includeAll = false, includeCustom = false) {
  const values = Array.from(
    new Set(
      [...FALLBACK_LANGUAGES, ...(metaLanguages || [])]
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  );
  const options = values.map((value) => ({
    value,
    label: value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
  }));
  if (includeAll) options.unshift({ value: "", label: "All languages" });
  if (includeCustom) options.push({ value: CUSTOM_LANGUAGE, label: "Custom language" });
  return options;
}

function labelOptions(metaLabels = [], includeAll = false) {
  const values = Array.from(
    new Set(
      [...FALLBACK_LABELS, ...(metaLabels || [])]
        .map((item) => String(item || "").trim())
        .filter(Boolean),
    ),
  );
  const options = values.map((value) => ({
    value,
    label: value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase()),
  }));
  if (includeAll) options.unshift({ value: "", label: "All labels" });
  return options;
}

function isActiveStatus(value: any) {
  return ["queued", "running", "retrying", "leased"].includes(String(value || "").toLowerCase());
}

function datasetStatusLabel(value: any) {
  const status = String(value || "").trim().toLowerCase();
  if (!status) return "Queued";
  return statusLabel(status);
}

function siteHealthLabel(health: any) {
  if (!health) return "not checked";
  const status = String(health.status || "").trim().toLowerCase();
  if (status === "working") return "working";
  if (status === "blocked" || status === "blocked_access") return "blocked access";
  if (status === "anti_bot") return "anti-bot";
  if (status === "limited") return "limited";
  if (status === "seized") return "seized";
  if (status === "parked") return "parked";
  if (status === "empty") return "empty";
  if (status === "asset_only") return "asset only";
  return "down";
}

function siteHealthDetail(health: any) {
  if (!health) return "Run a health check for this table row";
  const parts = [];
  if (health.http_status) parts.push(`HTTP ${health.http_status}`);
  if (health.method) parts.push(health.method);
  if (health.latency_ms) parts.push(`${formatNumber(health.latency_ms)}ms`);
  if (health.sample_size) parts.push(`${formatNumber(health.sample_size)} bytes checked`);
  if (health.content_reason) parts.push(health.content_reason);
  if (health.error) parts.push(health.error);
  return parts.join(" - ") || "No probe details";
}

function isHealthDeleteCandidate(health: any) {
  if (!health) return false;
  const status = String(health.status || "").trim().toLowerCase();
  if (status === "blocked" || status === "blocked_access" || status === "anti_bot") return false;
  if (health.delete_candidate === false) return false;
  return !health.working;
}

function SiteHealthBadge({ health }: any) {
  const working = Boolean(health?.working);
  const tone = health?.tone || (working ? "success" : "warning");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge tone={tone} className="gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${tone === "success" ? "bg-[var(--mint)]" : "bg-[var(--signal)]"}`} />
            {siteHealthLabel(health)}
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs text-xs">
        {siteHealthDetail(health)}
      </TooltipContent>
    </Tooltip>
  );
}

function SiteIdentity({ site, health }: any) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <a
          href={(site as any).url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
          title={(site as any).url}
        >
          {(site as any).url}
        </a>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>#{(site as any).id}</span>
        <SiteHealthBadge health={health} />
        {site.source ? <span>{site.source}</span> : null}
        {site.notes ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="max-w-[280px] truncate">{site.notes}</span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-xs text-xs">
              {site.notes}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

function MetricTile({ icon: Icon, label, value, detail }: any) {
  return (
    <div className="rounded-lg border bg-background px-3 py-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
        {label}
      </div>
      <div className="mt-2 text-xl font-semibold text-foreground">{value}</div>
      {detail ? <div className="mt-1 text-xs text-muted-foreground">{detail}</div> : null}
    </div>
  );
}

function InlineError({ message, onRetry, retryLabel = "Retry" }: any) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="break-words">{message}</div>
        {onRetry ? (
          <Button size="sm" variant="outline" className="mt-2 h-7" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function BatchProgress({ batch }: any) {
  const requested = toNumber(batch?.requested_count, 0);
  const completed = toNumber(batch?.completed_count, 0);
  const pct = requested > 0 ? Math.min(100, Math.round((completed / requested) * 100)) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{formatNumber(completed)} / {formatNumber(requested)} complete</span>
        <span>{pct}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function SiteDialog({
  open,
  onOpenChange,
  form,
  setForm,
  editingSite,
  languages,
  labels,
  isSaving,
  error,
  onSave,
}: any) {
  const languageValue = form.language === CUSTOM_LANGUAGE ? form.customLanguage : form.language;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editingSite ? "Edit website" : "Add website"}</DialogTitle>
          <DialogDescription>
            Websites are stored in the database and can be launched as workflow batches from this page.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Input
            value={form.url}
            onChange={(event) => setForm((current: any) => ({ ...current, url: event.target.value }))}
            placeholder="https://example.com"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Language"
              value={form.language}
              onChange={(value) =>
                setForm((current: any) => ({
                  ...current,
                  language: value,
                  customLanguage: value === CUSTOM_LANGUAGE ? current.customLanguage : "",
                }))
              }
              options={languageOptions(languages, false, true)}
            />
            <Select
              label="Label"
              value={form.label}
              onChange={(value) => setForm((current: any) => ({ ...current, label: value }))}
              options={labelOptions(labels as any)}
            />
          </div>
          {form.language === CUSTOM_LANGUAGE ? (
            <Input
              value={form.customLanguage}
              onChange={(event) =>
                setForm((current: any) => ({ ...current, customLanguage: event.target.value }))
              }
              placeholder="Type any language"
            />
          ) : null}
          <Textarea
            value={form.notes}
            onChange={(event) => setForm((current: any) => ({ ...current, notes: event.target.value }))}
            placeholder="Notes for this website"
            rows={4}
          />
          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
          <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Selected language: {languageValue || "unlabeled"}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button variant="accent" onClick={onSave} disabled={isSaving}>
            {isSaving ? "Saving..." : editingSite ? "Save website" : "Add website"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SiteDetailSheet({
  open,
  onOpenChange,
  siteDetail,
  isLoading,
  selectedRunId,
  setSelectedRunId,
  runDetail,
  runDetailLoading,
  pricingMap,
  onRunSite,
  onOpenBatch,
}: any) {
  const site = siteDetail?.site || EMPTY_OBJECT;
  const runs = siteDetail?.runs || EMPTY_ARRAY;
  const summary = siteDetail?.summary || EMPTY_OBJECT;
  const selectedRun = runs.find((run: any) => run.run_id === selectedRunId) || runs[0] || null;
  const runCost = selectedRun ? effectiveRunCost(selectedRun, pricingMap) : null;
  const modelLabels = summarizeModelUsage(selectedRun?.model_usage || runDetail?.model_usage || EMPTY_ARRAY);
  const agentRollups = runDetail?.agent_rollups || EMPTY_ARRAY;
  const stageRollups = runDetail?.stage_rollups || EMPTY_ARRAY;
  const screenshots = runDetail?.all_screenshots || runDetail?.snapshot?.all_screenshots || EMPTY_ARRAY;
  const datasetContext = runDetail?.dataset_context || null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[min(96vw,1180px)] overflow-y-auto sm:max-w-none">
        <SheetHeader className="pr-8">
          <SheetTitle className="flex items-center gap-2 text-xl">
            <Globe2 className="h-5 w-5" />
            Website run detail
          </SheetTitle>
          <SheetDescription>
            Site-level history, run comparisons, model usage, agent rollups, and screenshots.
          </SheetDescription>
        </SheetHeader>

        {isLoading ? (
          <div className="mt-6 space-y-4">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : (
          <div className="mt-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <a
                  href={(site as any).url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1.5 truncate text-base font-semibold text-primary hover:underline"
                >
                  <span className="truncate">{(site as any).url || "--"}</span>
                  <ExternalLink className="h-4 w-4 shrink-0" />
                </a>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge>{(site as any).language || "unlabeled"}</Badge>
                  <Badge tone="signal">{(site as any).label || "unlabeled"}</Badge>
                  <Badge tone={site.success_rate >= 80 ? "success" : site.success_rate > 0 ? "warning" : "default"}>
                    {formatNumber(site.success_rate || 0)}% success
                  </Badge>
                  {Number(site.adjusted_success_rate ?? site.success_rate ?? 0) !== Number(site.success_rate || 0) ? (
                    <Badge tone="warning">
                      {formatNumber(site.adjusted_success_rate || 0)}% agent
                    </Badge>
                  ) : null}
                </div>
              </div>
              <Button size="sm" variant="accent" onClick={() => onRunSite(site)}>
                <Play className="h-4 w-4" />
                Run website
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricTile
                icon={Activity}
                label="Terminal runs"
                value={formatNumber(summary.terminal_runs || 0)}
                detail={`${formatNumber(site.total_runs || 0)} logged on site`}
              />
              <MetricTile
                icon={Database}
                label="Total cost"
                value={formatCurrency(summary.total_cost_usd || 0)}
                detail={`${formatCurrency(summary.avg_cost_usd || 0)} avg`}
              />
              <MetricTile
                icon={BarChart3}
                label="Total tokens"
                value={formatNumber(summary.total_tokens || 0)}
                detail="Input, cached input, and output are visible per run"
              />
              <MetricTile
                icon={CheckCircle2}
                label="Best streams"
                value={formatNumber(summary.best_stream_count || 0)}
                detail={summary.best_stream_run_id ? compactRunId(summary.best_stream_run_id) : "No streams yet"}
              />
            </div>

            <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(380px,0.9fr)]">
              <Card className="overflow-hidden">
                <CardHeader className="border-b px-4 py-3">
                  <CardTitle className="text-sm">Run comparison</CardTitle>
                  <CardDescription>
                    Select a run to inspect agents, models, screenshots, and batch context.
                  </CardDescription>
                </CardHeader>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Run</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Tokens</TableHead>
                      <TableHead>Cost</TableHead>
                      <TableHead>Duration</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.length ? (
                      runs.map((row: any) => {
                        const status = datasetRunStatus(row);
                        const cost = effectiveRunCost(row, pricingMap);
                        return (
                          <TableRow
                            key={(row as any).run_id}
                            className={`${(row as any).run_id === selectedRunId ? "bg-muted/40" : ""} [&>td]:py-2.5`}
                          >
                            <TableCell className="align-top">
                              <Link
                                href={`/runs/${(row as any).run_id}`}
                                className="block max-w-[280px] break-all font-mono text-[11px] text-primary hover:underline"
                                title={(row as any).run_id}
                              >
                                {(row as any).run_id}
                              </Link>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {formatDate((row as any).created_at)}
                              </div>
                            </TableCell>
                            <TableCell className="align-top">
                              <Badge tone={statusToneForDataset(status) as any}>
                                {datasetStatusLabel(status)}
                              </Badge>
                            </TableCell>
                            <TableCell className="align-top tabular-nums text-xs">
                              {formatNumber(runTokenTotal(row))}
                            </TableCell>
                            <TableCell className="align-top tabular-nums text-xs">
                              {formatCurrency(cost.total)}
                              {cost.source === "partial" ? (
                                <div className="text-[11px] text-muted-foreground">partial pricing</div>
                              ) : null}
                            </TableCell>
                            <TableCell className="align-top tabular-nums text-xs">
                              {formatDuration(row.duration_seconds || row.run?.duration_seconds)}
                            </TableCell>
                            <TableCell className="align-top text-right">
                              <Button size="sm" variant="outline" onClick={() => setSelectedRunId((row as any).run_id)}>
                                <Eye className="h-3.5 w-3.5" />
                                Inspect
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                          No runs logged for this website yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </Card>

              <Card className="overflow-hidden">
                <CardHeader className="border-b px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <CardTitle className="text-sm">Selected run detail</CardTitle>
                      <CardDescription>
                        Agent-by-agent results and provider/model metrics.
                      </CardDescription>
                    </div>
                    {selectedRunId ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/runs/${selectedRunId}`}>
                          Open run
                          <ExternalLink className="h-3.5 w-3.5" />
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 p-4">
                  {runDetailLoading ? (
                    <div className="space-y-3">
                      <Skeleton className="h-16 rounded-lg" />
                      <Skeleton className="h-32 rounded-lg" />
                    </div>
                  ) : selectedRun ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        <MetricTile
                          icon={Bot}
                          label="Agents"
                          value={formatNumber(agentRollups.length || selectedRun.agent_runs?.length || 0)}
                          detail={`${formatNumber(stageRollups.length || 0)} stage rollups`}
                        />
                        <MetricTile
                          icon={Database}
                          label="Run cost"
                          value={formatCurrency(runCost?.total || 0)}
                          detail={runCost?.source === "partial" ? "Some calls missing pricing" : runCost?.source || "none"}
                        />
                        <MetricTile
                          icon={BarChart3}
                          label="Tokens"
                          value={formatNumber(runTokenTotal(selectedRun))}
                          detail={`${formatNumber(selectedRun.run?.total_llm_calls || runCost?.calls || 0)} LLM calls`}
                        />
                        <MetricTile
                          icon={ImageIcon}
                          label="Screenshots"
                          value={formatNumber(screenshots.length || selectedRun.run?.screenshot_count || 0)}
                          detail={`${formatNumber(selectedRun.run?.stream_count || selectedRun.stream_count || 0)} streams`}
                        />
                      </div>

                      {datasetContext?.batch ? (
                        <div className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                          Logged in batch{" "}
                          <button
                            type="button"
                            className="font-mono text-primary hover:underline"
                            onClick={() => onOpenBatch((datasetContext as any).batch_id)}
                          >
                            {(datasetContext as any).batch_name || compactRunId((datasetContext as any).batch_id)}
                          </button>
                        </div>
                      ) : null}

                      <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Models
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {modelLabels.length ? (
                            modelLabels.map((label) => (
                              <Badge key={label} tone="violet">{label}</Badge>
                            ))
                          ) : (
                            <span className="text-xs text-muted-foreground">No model usage persisted.</span>
                          )}
                        </div>
                      </div>

                      <div>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Agents
                        </div>
                        <div className="max-h-72 overflow-auto rounded-lg border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Agent</TableHead>
                                <TableHead>Status</TableHead>
                                <TableHead>Tokens</TableHead>
                                <TableHead>Cost</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {(agentRollups.length ? agentRollups : selectedRun.agent_runs || EMPTY_ARRAY).length ? (
                                (agentRollups.length ? agentRollups : selectedRun.agent_runs || EMPTY_ARRAY).map((agent: any, index: any) => (
                                  <TableRow key={`${agent.actor || agent.agent_type || "agent"}-${index}`}>
                                    <TableCell className="text-xs">
                                      <div className="font-medium">{agent.agent_type || agent.actor || "--"}</div>
                                      <div className="text-muted-foreground">{agent.actor || "--"}</div>
                                    </TableCell>
                                    <TableCell>
                                      <Badge tone={statusToneForDataset(agent.status) as any}>
                                        {datasetStatusLabel(agent.status)}
                                      </Badge>
                                    </TableCell>
                                    <TableCell className="tabular-nums text-xs">
                                      {formatNumber(agent.total_tokens || ((agent.input_tokens || 0) + (agent.output_tokens || 0)))}
                                    </TableCell>
                                    <TableCell className="tabular-nums text-xs">
                                      {formatCurrency(agent.cost_usd || 0)}
                                    </TableCell>
                                  </TableRow>
                                ))
                              ) : (
                                <TableRow>
                                  <TableCell colSpan={4} className="py-6 text-center text-xs text-muted-foreground">
                                    No agent rows persisted for this run.
                                  </TableCell>
                                </TableRow>
                              )}
                            </TableBody>
                          </Table>
                        </div>
                      </div>

                      {screenshots.length ? (
                        <div>
                          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Screenshots
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            {screenshots.slice(0, 4).map((screenshot: any, index: any) => {
                              const src = typeof screenshot === "string" ? screenshot : screenshot?.screenshot_url || screenshot?.url;
                              if (!src) return null;
                              return (
                                <a key={`${src}-${index}`} href={src} target="_blank" rel="noopener noreferrer" className="overflow-hidden rounded-lg border bg-muted">
                                  <img src={src} alt={`Run screenshot ${index + 1}`} className="h-28 w-full object-cover" />
                                </a>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="py-10 text-center text-sm text-muted-foreground">
                      Select a run to view details.
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function RunsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState("sites");
  const [sites, setSites] = useState([]);
  const [siteTotal, setSiteTotal] = useState(0);
  const [meta, setMeta] = useState({ languages: FALLBACK_LANGUAGES, labels: FALLBACK_LABELS, stats: {} });
  const [batches, setBatches] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [batchDetail, setBatchDetail] = useState<any>(null);
  const [runHistory, setRunHistory] = useState([]);
  const [runHistoryTotal, setRunHistoryTotal] = useState(0);
  const [historyStatus, setHistoryStatus] = useState("");
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyPage, setHistoryPage] = useState(0);
  const [selectedHistoryRunIds, setSelectedHistoryRunIds] = useState([]);
  const [pricingMap, setPricingMap] = useState<any>(null);
  const [selectedSiteIds, setSelectedSiteIds] = useState([]);
  const [siteHealthMap, setSiteHealthMap] = useState({});
  const [isSiteHealthChecking, setIsSiteHealthChecking] = useState(false);
  const [siteHealthCheckedAt, setSiteHealthCheckedAt] = useState("");
  const [healthCheckScope, setHealthCheckScope] = useState("all");
  const [healthSelectionAction, setHealthSelectionAction] = useState("choose");
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState("");
  const [label, setLabel] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isBatchLoading, setIsBatchLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [siteDialogOpen, setSiteDialogOpen] = useState(false);
  const [editingSite, setEditingSite] = useState<any>(null);
  const [siteForm, setSiteForm] = useState({
    url: "",
    language: "english",
    customLanguage: "",
    label: "piracy",
    notes: "",
  });
  const [siteSaveError, setSiteSaveError] = useState("");
  const [isSiteSaving, setIsSiteSaving] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  const [siteDetail, setSiteDetail] = useState<any>(null);
  const [isSiteDetailLoading, setIsSiteDetailLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runDetail, setRunDetail] = useState<any>(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [historyBusyRunId, setHistoryBusyRunId] = useState("");
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [isPricingLoading, setIsPricingLoading] = useState(true);
  const [batchEstimatedCosts, setBatchEstimatedCosts] = useState({});
  const [refreshTick, setRefreshTick] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState("");
  const [syncMode, setSyncMode] = useState("stream");
  const suppressDatasetReloadUntilRef = useRef(0);

  const languages = meta.languages || FALLBACK_LANGUAGES;
  const labels = meta.labels || FALLBACK_LABELS;
  const stats = meta.stats || EMPTY_OBJECT;

  const selectedSites = useMemo(
    () => sites.filter((site) => (selectedSiteIds as any).includes((site as any).id)),
    [selectedSiteIds, sites],
  );

  const setRunsTab = useCallback((nextTab: any, updates = {}) => {
    if (!RUN_TABS.has(nextTab)) return;
    setTab(nextTab);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", nextTab);
    if (nextTab !== "batches") {
      params.delete("batch");
    }
    if (nextTab !== "history") {
      params.delete("status");
    }
    // @ts-expect-error -- strict migration
    if (updates.batch) {
      // @ts-expect-error -- strict migration
      params.set("batch", updates.batch);
      params.set("tab", "batches");
    }
    router.replace(`/runs?${params.toString()}`, { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    const requestedBatchId = searchParams.get("batch") || "";
    const requestedTab = searchParams.get("tab") || "";
    const requestedStatus = searchParams.get("status") || "";
    const requestedHistoryQuery = searchParams.get("run_query") || "";
    const requestedHistoryPage = Math.max(Number(searchParams.get("page") || 1) - 1, 0);
    if (requestedBatchId) {
      setSelectedBatchId(requestedBatchId);
      setTab("batches");
      return;
    }
    if (RUN_TABS.has(requestedTab)) {
      setTab(requestedTab);
    }
    if (requestedTab === "history") {
      setHistoryStatus(requestedStatus);
      setHistoryQuery(requestedHistoryQuery);
      setHistoryPage(Number.isFinite(requestedHistoryPage) ? requestedHistoryPage : 0);
    }
  }, [searchParams]);

  const hasActiveDatasetWork = useMemo(() => {
    const siteActive = sites.some((site) =>
      // @ts-expect-error -- strict migration
      isActiveStatus(datasetRunStatus(site.latest_run || EMPTY_OBJECT)),
    );
    const batchActive = isActiveStatus(batchDetail?.status) || batches.some((batch) => isActiveStatus((batch as any).status));
    return siteActive || batchActive;
  }, [batchDetail?.status, batches, sites]);

  const activeBatchId = useMemo(() => {
    if (tab !== "batches") return "";
    // @ts-expect-error -- strict migration
    return selectedBatchId || batches[0]?.batch_id || "";
  }, [batches, selectedBatchId, tab]);

  const selectedBatchSummary = useMemo(
    () => batches.find((batch) => (batch as any).batch_id === activeBatchId) || null,
    [activeBatchId, batches],
  );

  const loadDashboard = useCallback(async () => {
    setIsLoading(true);
    setActionError("");
    try {
      const params = new URLSearchParams({
        language,
        label,
        query,
        limit: "0",
        offset: "0",
      });
      const [metaPayload, sitesPayload, batchesPayload] = await Promise.all([
        apiFetch("/api/datasets/meta"),
        apiFetch(`/api/datasets/sites?${params.toString()}`),
        apiFetch("/api/datasets/batches?limit=20"),
      ]);
      setMeta({
        // @ts-expect-error -- strict migration
        languages: metaPayload.languages || FALLBACK_LANGUAGES,
        // @ts-expect-error -- strict migration
        labels: metaPayload.labels || FALLBACK_LABELS,
        // @ts-expect-error -- strict migration
        stats: metaPayload.stats || {},
      });
      // @ts-expect-error -- strict migration
      setSites(sitesPayload.sites || []);
      // @ts-expect-error -- strict migration
      setSiteTotal(sitesPayload.total || 0);
      // @ts-expect-error -- strict migration
      setBatches(batchesPayload.batches || []);
      setSelectedSiteIds((current) =>
        // @ts-expect-error -- strict migration
        current.filter((id) => (sitesPayload.sites || []).some((site: any) => (site as any).id === id)),
      );
      setLastSyncAt(new Date().toISOString());
    } catch (error: any) {
      setActionError(error instanceof Error ? error.message : "Failed to load runs dashboard");
    } finally {
      setIsLoading(false);
    }
  }, [label, language, query]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard, refreshTick]);

  useEffect(() => {
    let cancelled = false;
    setIsPricingLoading(true);
    loadPricing()
      .then((pricing) => {
        if (!cancelled) setPricingMap(pricing);
      })
      .finally(() => {
        if (!cancelled) setIsPricingLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const batchRuns = batchDetail?.batch_id === activeBatchId ? batchDetail?.runs || EMPTY_ARRAY : EMPTY_ARRAY;
  const displayedBatchDetail = batchDetail?.batch_id === activeBatchId ? batchDetail : selectedBatchSummary;

  useEffect(() => {
    let cancelled = false;
    const rowsToEstimate = batchRuns.filter(
      (row: any) => !loggedDatasetRunCost(row) && (row.model_usage || EMPTY_ARRAY).length > 0,
    );
    if (!rowsToEstimate.length) {
      setBatchEstimatedCosts({});
      return () => {
        cancelled = true;
      };
    }

    async function loadBatchEstimates() {
      const entries = await Promise.all(
        rowsToEstimate.map(async (row: any) => [
          (row as any).run_id,
          await estimateRunCostFromApi(row.model_usage || EMPTY_ARRAY),
        ]),
      );
      if (cancelled) return;
      setBatchEstimatedCosts(Object.fromEntries(entries));
    }

    loadBatchEstimates().catch(() => {
      if (!cancelled) setBatchEstimatedCosts({});
    });
    return () => {
      cancelled = true;
    };
  }, [batchRuns]);

  const displayBatchRunCost = useCallback((row: any) => {
    const logged = loggedDatasetRunCost(row);
    if (logged > 0) {
      return {
        total: logged,
        source: "logged",
      };
    }
    // @ts-expect-error -- strict migration
    const estimated = batchEstimatedCosts[row?.run_id];
    if (estimated) return estimated;
    if ((row?.model_usage || EMPTY_ARRAY).length > 0) {
      return {
        total: 0,
        source: "estimating",
      };
    }
    const fallback = effectiveRunCost(row, pricingMap);
    return {
      total: fallback.total,
      source: fallback.source,
    };
  }, [batchEstimatedCosts, pricingMap]);

  useEffect(() => {
    let closed = false;
    // @ts-expect-error -- strict migration
    let source = null;
    // @ts-expect-error -- strict migration
    let reconnectTimer = null;
    let fallbackTimer: any = null;

    const stopFallback = () => {
      if (fallbackTimer) {
        document.removeEventListener("visibilitychange", fallbackTimer);
        fallbackTimer = null;
      }
    };

    // Plan task 42 (de-polling): the SSE stream is the primary sync channel.
    // When it is down we no longer run a background interval — instead the
    // fallback refresh fires once on tab focus (visibilitychange) until the
    // stream reconnects. Idle console = zero network chatter.
    const startFallback = () => {
      if (fallbackTimer) return;
      setSyncMode("fallback");
      const onVisible = () => {
        if (document.visibilityState === "visible" && !closed) {
          setRefreshTick((value) => value + 1);
        }
      };
      document.addEventListener("visibilitychange", onVisible);
      fallbackTimer = onVisible;
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource(eventSourceUrl("/api/datasets/stream"));
      source.onopen = () => {
        setSyncMode("stream");
        stopFallback();
      };
      source.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data || "{}");
          if (payload?.type === "dataset_snapshot" && payload?.changed) {
            if (Date.now() < suppressDatasetReloadUntilRef.current) return;
            setRefreshTick((value) => value + 1);
          }
        } catch {}
      };
      source.onerror = () => {
        // @ts-expect-error -- strict migration
        if (source) {
          source.close();
          source = null;
        }
        startFallback();
        // @ts-expect-error -- strict migration
        if (!closed && !reconnectTimer) {
          reconnectTimer = window.setTimeout(() => {
            reconnectTimer = null;
            connect();
          }, 6000);
        }
      };
    };

    connect();
    return () => {
      closed = true;
      // @ts-expect-error -- strict migration
      if (source) source.close();
      stopFallback();
      // @ts-expect-error -- strict migration
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
    };
  }, [hasActiveDatasetWork]);

  useEffect(() => {
    if (tab !== "history") return undefined;
    let cancelled = false;
    setIsHistoryLoading(true);
    const params = new URLSearchParams({
      limit: String(HISTORY_PAGE_SIZE),
      offset: String(historyPage * HISTORY_PAGE_SIZE),
      query: historyQuery,
    });
    if (historyStatus) params.set("status", historyStatus);
    apiFetch(`/ui/runs?${params.toString()}`)
      .then((payload) => {
        if (!cancelled) {
          // @ts-expect-error -- strict migration
          setRunHistory(payload.rows || []);
          // @ts-expect-error -- strict migration
          setRunHistoryTotal(payload.total || 0);
          setSelectedHistoryRunIds((current) =>
            // @ts-expect-error -- strict migration
            current.filter((runId) => (payload.rows || []).some((row: any) => (row as any).run_id === runId)),
          );
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setActionError(error instanceof Error ? error.message : "Failed to load run history");
        }
      })
      .finally(() => {
        if (!cancelled) setIsHistoryLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [historyPage, historyQuery, historyStatus, refreshTick, tab]);

  useEffect(() => {
    if (tab !== "batches") return undefined;
    if (!batches.length) {
      return undefined;
    }
    const nextBatchId =
      // @ts-expect-error -- strict migration
      batches.some((batch) => (batch as any).batch_id === selectedBatchId) ? selectedBatchId : batches[0]?.batch_id || "";
    if (!nextBatchId || nextBatchId === selectedBatchId) {
      return undefined;
    }
    setSelectedBatchId(nextBatchId);
  }, [batches, selectedBatchId, tab]);

  useEffect(() => {
    if (!activeBatchId) {
      setBatchDetail(null);
      setIsBatchLoading(false);
      return undefined;
    }
    let cancelled = false;
    setIsBatchLoading(true);
    apiFetch(`/api/datasets/batches/${activeBatchId}`)
      .then((detail) => {
        if (!cancelled) {
          setBatchDetail(detail);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setActionError(error instanceof Error ? error.message : "Failed to load batch detail");
        }
      })
      .finally(() => {
        if (!cancelled) setIsBatchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeBatchId, refreshTick]);

  useEffect(() => {
    if (!selectedRunId) {
      setRunDetail(null);
      return undefined;
    }
    let cancelled = false;
    setRunDetailLoading(true);
    apiFetch(`/ui/runs/${selectedRunId}`)
      .then((payload) => {
        if (!cancelled) setRunDetail(payload);
      })
      .catch((error) => {
        if (!cancelled) {
          setRunDetail(null);
          setActionError(error instanceof Error ? error.message : "Failed to load selected run detail");
        }
      })
      .finally(() => {
        if (!cancelled) setRunDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  function toggleSite(siteId: any, checked: any) {
    // @ts-expect-error -- strict migration
    setSelectedSiteIds((current) => {
      if (checked) return Array.from(new Set([...current, siteId]));
      return current.filter((id) => id !== siteId);
    });
  }

  function toggleAllVisible(checked: any) {
    if (!checked) {
      setSelectedSiteIds([]);
      return;
    }
    // @ts-expect-error -- strict migration
    setSelectedSiteIds(sites.map((site) => (site as any).id));
  }

  function healthForSite(site: any) {
    // @ts-expect-error -- strict migration
    return siteHealthMap[String(site?.id ?? "")] || siteHealthMap[String(site?.url ?? "")] || null;
  }

  function sitesForHealthCheck() {
    if (healthCheckScope === "selected") return selectedSites;
    if (healthCheckScope === "unchecked") return sites.filter((site) => !healthForSite(site));
    if (healthCheckScope === "not_working") {
      return sites.filter((site) => {
        const health = healthForSite(site);
        return isHealthDeleteCandidate(health);
      });
    }
    return sites;
  }

  async function checkVisibleSiteHealth() {
    const targetSites = sitesForHealthCheck();
    if (!targetSites.length) return;
    setIsSiteHealthChecking(true);
    setActionError("");
    try {
      const payload = await apiFetch("/api/datasets/sites/health-check", {
        method: "POST",
        body: JSON.stringify({
          site_ids: targetSites.map((site) => (site as any).id).filter(Boolean),
          timeout_seconds: 5,
          limit: Math.min(targetSites.length, 1000),
        }),
      });
      setSiteHealthMap((current) => {
        const next = { ...current };
        // @ts-expect-error -- strict migration
        for (const result of payload.results || []) {
          if (result.site_id !== null && result.site_id !== undefined) {
            // @ts-expect-error -- strict migration
            next[String(result.site_id)] = result;
          }
          if (result.url) {
            // @ts-expect-error -- strict migration
            next[String(result.url)] = result;
          }
        }
        return next;
      });
      // @ts-expect-error -- strict migration
      setSiteHealthCheckedAt(payload.checked_at || new Date().toISOString());
    } catch (error: any) {
      setActionError(error instanceof Error ? error.message : "Failed to check website health");
    } finally {
      setIsSiteHealthChecking(false);
    }
  }

  function selectSitesByHealth(action: any) {
    setHealthSelectionAction("choose");
    if (!action || action === "choose") return;
    if (action === "clear") {
      setSelectedSiteIds([]);
      return;
    }
    const ids = sites
      .filter((site) => {
        const health = healthForSite(site);
        if (action === "all") return true;
        if (action === "working") return Boolean(health?.working);
        if (action === "not_working") return isHealthDeleteCandidate(health);
        if (action === "checked") return Boolean(health);
        if (action === "unchecked") return !health;
        return false;
      })
      .map((site) => (site as any).id)
      .filter(Boolean);
    // @ts-expect-error -- strict migration
    setSelectedSiteIds(ids);
  }

  function openCreateSite() {
    setEditingSite(null);
    setSiteSaveError("");
    setSiteForm({
      url: "",
      language: "english",
      customLanguage: "",
      label: "piracy",
      notes: "",
    });
    setSiteDialogOpen(true);
  }

  function openEditSite(site: any) {
    // @ts-expect-error -- strict migration
    const knownLanguage = languageOptions(languages).some((option) => option.value === (site as any).language);
    setEditingSite(site);
    setSiteSaveError("");
    setSiteForm({
      url: (site as any).url || "",
      language: knownLanguage || !(site as any).language ? (site as any).language || "english" : CUSTOM_LANGUAGE,
      customLanguage: knownLanguage ? "" : (site as any).language || "",
      label: (site as any).label || "piracy",
      notes: site.notes || "",
    });
    setSiteDialogOpen(true);
  }

  function resolvedSiteLanguage() {
    if (siteForm.language === CUSTOM_LANGUAGE) return String(siteForm.customLanguage || "").trim();
    return String(siteForm.language || "").trim();
  }

  async function saveSite() {
    setIsSiteSaving(true);
    setSiteSaveError("");
    try {
      const payload = {
        url: siteForm.url,
        language: resolvedSiteLanguage(),
        label: siteForm.label,
        notes: siteForm.notes,
      };
      if (editingSite) {
        await apiFetch(`/api/datasets/sites/${editingSite.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });
      } else {
        await apiFetch("/api/datasets/sites", {
          method: "POST",
          body: JSON.stringify(payload),
        });
      }
      setSiteDialogOpen(false);
      setRefreshTick((value) => value + 1);
    } catch (error: any) {
      setSiteSaveError(error instanceof Error ? error.message : "Failed to save website");
    } finally {
      setIsSiteSaving(false);
    }
  }

  async function updateSite(siteId: any, patch: any) {
    setActionError("");
    try {
      await apiFetch(`/api/datasets/sites/${siteId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setRefreshTick((value) => value + 1);
    } catch (error: any) {
      setActionError(error instanceof Error ? error.message : "Failed to update website");
    }
  }

  function removeDeletedSites(siteIds: any) {
    const ids = Array.from(new Set((siteIds || []).map((id: any) => Number(id)).filter(Boolean)));
    if (!ids.length) return;
    const idSet = new Set(ids);
    const deletedSites = sites.filter((site) => idSet.has(Number((site as any).id)));
    const deletedUrls = new Set(deletedSites.map((site) => String((site as any).url || "")));
    const deletedCount = deletedSites.length;
    const deletedUnlabeled = deletedSites.filter((site) => !(site as any).language || !(site as any).label).length;

    setSites((current) => current.filter((site) => !idSet.has(Number((site as any).id))));
    setSiteTotal((current) => Math.max(0, Number(current || 0) - deletedCount));
    setMeta((current) => {
      const statsPayload = current.stats || {};
      return {
        ...current,
        stats: {
          ...statsPayload,
          // @ts-expect-error -- strict migration
          total: Math.max(0, Number(statsPayload.total || 0) - deletedCount),
          // @ts-expect-error -- strict migration
          unlabeled: Math.max(0, Number(statsPayload.unlabeled || 0) - deletedUnlabeled),
        },
      };
    });
    setSelectedSiteIds((current) => current.filter((id) => !idSet.has(Number(id))));
    setSiteHealthMap((current) => {
      const next = { ...current };
      for (const id of idSet) {
        // @ts-expect-error -- strict migration
        delete next[String(id)];
      }
      for (const url of deletedUrls) {
        // @ts-expect-error -- strict migration
        if (url) delete next[url];
      }
      return next;
    });
    if ((siteDetail as any)?.site?.id && idSet.has(Number((siteDetail as any).site.id))) {
      setDetailOpen(false);
      setSiteDetail(null);
      setSelectedRunId("");
    }
  }

  async function deleteSites(siteIds: any, busyKey = "delete-sites") {
    const ids = Array.from(new Set((siteIds || []).map((id: any) => Number(id)).filter(Boolean)));
    if (!ids.length) return;
    setBusyAction(busyKey);
    setActionError("");
    try {
      suppressDatasetReloadUntilRef.current = Date.now() + 5000;
      if (ids.length === 1) {
        await apiFetch(`/api/datasets/sites/${ids[0]}`, { method: "DELETE" });
      } else {
        await apiFetch("/api/datasets/sites/bulk-delete", {
          method: "POST",
          body: JSON.stringify({ ids }),
        });
      }
      removeDeletedSites(ids);
    } catch (error: any) {
      setActionError(error instanceof Error ? error.message : "Failed to delete websites");
    } finally {
      setBusyAction("");
    }
  }

  async function deleteSite(siteId: any) {
    await deleteSites([siteId], `delete-site-${siteId}`);
  }

  async function deleteSelectedSites() {
    await deleteSites(selectedSiteIds, "delete-selected-sites");
  }

  async function deleteDownSites() {
    const ids = sites
      .filter((site) => {
        const health = healthForSite(site);
        return isHealthDeleteCandidate(health);
      })
      .map((site) => (site as any).id);
    await deleteSites(ids, "delete-down-sites");
  }

  async function createBatch({ urls = [], site = null } = {}) {
    setBusyAction(urls.length ? "run-selected" : site ? `run-site-${(site as any).id}` : "run-filtered");
    setActionError("");
    try {
      const body = {
        batch_name: site
          ? `Single site: ${(site as any).url}`
          : urls.length
            ? `Selected websites (${urls.length})`
            : `Filtered websites${language ? ` / ${language}` : ""}${label ? ` / ${label}` : ""}`,
        language,
        label,
        query,
        limit: 0,
        urls: site ? [(site as any).url] : urls,
      };
      const created = await apiFetch("/api/datasets/batches", {
        method: "POST",
        body: JSON.stringify(body),
      });
      // @ts-expect-error -- strict migration
      setSelectedBatchId(created.batch_id);
      setBatchDetail(created);
      // @ts-expect-error -- strict migration
      setRunsTab("batches", { batch: created.batch_id });
      setRefreshTick((value) => value + 1);
    } catch (error: any) {
      setActionError(error instanceof Error ? error.message : "Failed to launch workflow batch");
    } finally {
      setBusyAction("");
    }
  }

  async function openSiteDetail(site: any) {
    setDetailOpen(true);
    setIsSiteDetailLoading(true);
    setSiteDetail(null);
    setSelectedRunId("");
    try {
      const detail = await apiFetch(`/api/datasets/sites/${(site as any).id}?limit=30`);
      setSiteDetail(detail);
      // @ts-expect-error -- strict migration
      const firstRunId = detail.runs?.[0]?.run_id || "";
      setSelectedRunId(firstRunId);
    } catch (error: any) {
      setActionError(error instanceof Error ? error.message : "Failed to load website detail");
    } finally {
      setIsSiteDetailLoading(false);
    }
  }

  async function openBatch(batchId: any) {
    if (!batchId) return;
    setSelectedBatchId(batchId);
    setRunsTab("batches", { batch: batchId });
  }

  function setHistoryStatusFilter(nextStatus: any) {
    const normalized = String(nextStatus || "").trim().toLowerCase();
    setHistoryStatus(normalized);
    setHistoryPage(0);
    setSelectedHistoryRunIds([]);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "history");
    params.delete("batch");
    params.delete("page");
    if (normalized) params.set("status", normalized);
    else params.delete("status");
    router.replace(`/runs?${params.toString()}`, { scroll: false });
  }

  function setHistorySearch(nextQuery: any) {
    const normalized = String(nextQuery || "");
    setHistoryQuery(normalized);
    setHistoryPage(0);
    setSelectedHistoryRunIds([]);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "history");
    params.delete("batch");
    params.delete("page");
    if (normalized.trim()) params.set("run_query", normalized);
    else params.delete("run_query");
    router.replace(`/runs?${params.toString()}`, { scroll: false });
  }

  function resetHistoryFilters() {
    setHistoryQuery("");
    setHistoryStatus("");
    setHistoryPage(0);
    setSelectedHistoryRunIds([]);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "history");
    params.delete("batch");
    params.delete("status");
    params.delete("run_query");
    params.delete("page");
    router.replace(`/runs?${params.toString()}`, { scroll: false });
  }

  function setHistoryPageIndex(nextPage: any) {
    const maxPage = Math.max(Math.ceil(runHistoryTotal / HISTORY_PAGE_SIZE) - 1, 0);
    const bounded = Math.max(0, Math.min(Number(nextPage || 0), maxPage));
    setHistoryPage(bounded);
    setSelectedHistoryRunIds([]);
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", "history");
    params.delete("batch");
    if (bounded > 0) params.set("page", String(bounded + 1));
    else params.delete("page");
    router.replace(`/runs?${params.toString()}`, { scroll: false });
  }

  async function cancelBatch(batchId: any) {
    if (!batchId) return;
    setBusyAction(`cancel-batch-${batchId}`);
    setActionError("");
    try {
      await apiFetch(`/api/datasets/batches/${batchId}/cancel`, { method: "POST" });
      setRefreshTick((value) => value + 1);
    } catch (error: any) {
      setActionError(error instanceof Error ? error.message : "Failed to cancel batch");
    } finally {
      setBusyAction("");
    }
  }

  async function cancelRun(runId: any) {
    setHistoryBusyRunId(runId);
    setActionError("");
    try {
      const response = await fetch(apiUrl(`/ui/runs/${runId}/cancel`), { method: "POST" });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Failed to stop run (${response.status})`);
      }
      setRefreshTick((value) => value + 1);
    } catch (error: any) {
      setActionError(error instanceof Error ? error.message : "Failed to stop run");
    } finally {
      setHistoryBusyRunId("");
    }
  }

  async function deleteRun(runId: any) {
    setHistoryBusyRunId(runId);
    setActionError("");
    try {
      const response = await fetch(apiUrl(`/ui/runs/${runId}`), { method: "DELETE" });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Failed to delete run (${response.status})`);
      }
      setRefreshTick((value) => value + 1);
    } catch (error: any) {
      setActionError(error instanceof Error ? error.message : "Failed to delete run");
    } finally {
      setHistoryBusyRunId("");
    }
  }

  async function deleteSelectedHistoryRuns() {
    const deletableIds = selectedHistoryRunIds.filter((runId) => {
      // @ts-expect-error -- strict migration
      const row = runHistory.find((item) => item.run_id === runId);
      return row && canDeleteRun(row);
    });
    if (!deletableIds.length) return;
    setHistoryBusyRunId("__bulk_delete__");
    setActionError("");
    try {
      for (const runId of deletableIds) {
        const response = await fetch(apiUrl(`/ui/runs/${runId}`), { method: "DELETE" });
        if (!response.ok) {
          const message = await response.text();
          throw new Error(message || `Failed to delete run ${runId}`);
        }
      }
      setSelectedHistoryRunIds([]);
      setRefreshTick((value) => value + 1);
    } catch (error: any) {
      setActionError(error instanceof Error ? error.message : "Failed to delete selected runs");
    } finally {
      setHistoryBusyRunId("");
    }
  }

  const allVisibleSelected = sites.length > 0 && selectedSiteIds.length === sites.length;
  const selectedUrls = selectedSites.map((site) => (site as any).url).filter(Boolean);
  const visibleHealthRows = sites.map((site) => healthForSite(site)).filter(Boolean);
  const checkedVisibleCount = visibleHealthRows.length;
  const workingVisibleCount = visibleHealthRows.filter((health) => health.working).length;
  const uncheckedVisibleCount = Math.max(0, sites.length - checkedVisibleCount);
  const notWorkingVisibleCount = visibleHealthRows.filter(isHealthDeleteCandidate).length;
  const downSiteIds = sites
    .filter((site) => {
      const health = healthForSite(site);
      return isHealthDeleteCandidate(health);
    })
    .map((site) => (site as any).id)
    .filter(Boolean);
  const healthCheckTargetCount = sitesForHealthCheck().length;
  const healthCheckScopeOptions = [
    {
      value: "all",
      label: `Check all (${sites.length})`,
      description: "All filtered websites in this table",
    },
    {
      value: "selected",
      label: `Check selected (${selectedSites.length})`,
      description: "Only manually selected websites",
    },
    {
      value: "unchecked",
      label: `Check unchecked (${uncheckedVisibleCount})`,
      description: "Rows without a health result yet",
    },
    {
      value: "not_working",
      label: `Recheck not working (${notWorkingVisibleCount})`,
      description: "Rows currently yellow",
    },
  ];
  const healthSelectionOptions = [
    { value: "choose", label: "Select websites", description: "Choose rows by health state" },
    { value: "working", label: `Working (${workingVisibleCount})` },
    { value: "not_working", label: `Not working (${notWorkingVisibleCount})` },
    { value: "checked", label: `Checked (${checkedVisibleCount})` },
    { value: "unchecked", label: `Unchecked (${uncheckedVisibleCount})` },
    { value: "all", label: `All filtered (${sites.length})` },
    { value: "clear", label: "Clear selection" },
  ];
  const historyPageCount = Math.max(Math.ceil(runHistoryTotal / HISTORY_PAGE_SIZE), 1);
  const historyStart = runHistoryTotal ? historyPage * HISTORY_PAGE_SIZE + 1 : 0;
  const historyEnd = Math.min((historyPage + 1) * HISTORY_PAGE_SIZE, runHistoryTotal);
  const visibleHistoryIds = runHistory.map((row) => (row as any).run_id).filter(Boolean);
  const deletableHistoryIds = runHistory.filter(canDeleteRun).map((row) => (row as any).run_id).filter(Boolean);
  const selectedDeletableHistoryIds = selectedHistoryRunIds.filter((runId) => deletableHistoryIds.includes(runId));
  const allVisibleHistorySelected =
    // @ts-expect-error -- strict migration
    visibleHistoryIds.length > 0 && visibleHistoryIds.every((runId) => selectedHistoryRunIds.includes(runId));
  const historyTotals = useMemo(() => {
    const metrics = summarizeStatusMetrics(runHistory, {
      getStatus: (row) => (row as any).final_status || row.status,
    });
    return runHistory.reduce(
      (acc, row) => {
        // @ts-expect-error -- strict migration
        const status = String((row as any).final_status || row.status || "").toLowerCase();
        acc.tokens += Number((row as any).total_tokens_in || 0) + Number((row as any).total_tokens_out || 0);
        acc.cost += Number((row as any).total_cost_usd ?? (row as any).estimated_total_cost_usd ?? 0);
        // @ts-expect-error -- strict migration
        acc.streams += Number(row.stream_count || 0);
        if (isActiveStatus(status)) acc.active += 1;
        return acc;
      },
      {
        tokens: 0,
        cost: 0,
        streams: 0,
        success: metrics.productive_success_count,
        active: 0,
        failed: metrics.agent_failed_count,
        externalBlocked: metrics.external_blocked_count,
        strictFailed: metrics.strict_failed_count,
        adjustedSuccessRate: metrics.adjusted_success_rate,
        strictSuccessRate: metrics.success_rate,
      },
    );
  }, [runHistory]);
  const globalRunTotal = Number((stats as any).total_runs || runHistoryTotal || 0);
  const globalSuccessRate = globalRunTotal > 0
    // @ts-expect-error -- strict migration
    ? (Number(stats.successful_runs || 0) / globalRunTotal) * 100
    // @ts-expect-error -- strict migration
    : Number(stats.success_rate || 0);
  // @ts-expect-error -- strict migration
  const globalAdjustedSuccessRate = Number(stats.adjusted_success_rate ?? globalSuccessRate ?? 0);
  const batchTotals = useMemo(() => {
    return batchRuns.reduce(
      (acc: any, row: any) => {
        const cost = displayBatchRunCost(row);
        acc.cost += cost.total;
        acc.tokens += runTokenTotal(row);
        acc.streams += toNumber(row.stream_count || row.run?.stream_count, 0);
        return acc;
      },
      { cost: 0, tokens: 0, streams: 0 },
    );
  }, [batchRuns, displayBatchRunCost]);
  const canCancelDisplayedBatch = Boolean(
    displayedBatchDetail
      && (
        isActiveStatus(displayedBatchDetail.status)
        || batchRuns.some((row: any) => isActiveStatus(datasetRunStatus(row)))
      ),
  );

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <PageHeader
          eyebrow="workflow test bench"
          title="Runs"
          description="Manage the website dataset, launch workflow runs in batches, and inspect results by site, batch, agent, model, token usage, and cost."
          icon={<Layers3 className="h-7 w-7 text-primary" />}
          actions={
            <>
              <Button variant="outline" onClick={() => setRefreshTick((value) => value + 1)} disabled={isLoading}>
                <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              <Button variant="accent" onClick={openCreateSite}>
                <Plus className="h-4 w-4" />
                Add website
              </Button>
            </>
          }
        />

        <InlineError
          message={actionError}
          onRetry={() => setRefreshTick((value) => value + 1)}
          retryLabel="Retry sync"
        />

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricTile icon={Globe2} label="Websites" value={formatNumber((stats as any).total || siteTotal)} detail={`${formatNumber((stats as any).unlabeled || 0)} unlabeled`} />
          <MetricTile icon={ListChecks} label="Persisted runs" value={formatNumber(globalRunTotal)} detail={`${formatNumber((stats as any).total_runs || 0)} dataset-linked`} />
          <MetricTile icon={CheckCircle2} label="Success rate" value={pct(globalSuccessRate)} detail="Strict stream success" />
          <MetricTile icon={Bot} label="Agent success" value={pct(globalAdjustedSuccessRate)} detail={`${formatNumber((stats as any).external_blocked_count || 0)} site/server blockers`} />
          <MetricTile icon={Activity} label="Active work" value={hasActiveDatasetWork ? "Live" : "Idle"} detail={`${formatNumber(batches.length)} batches indexed`} />
          <MetricTile
            icon={Database}
            label="Pricing catalog"
            value={isPricingLoading ? "--" : formatNumber(pricingMap?.size || 0)}
            detail={isPricingLoading ? "Loading provider pricing..." : "Loaded from provider pricing API and stored pricing"}
          />
          <MetricTile icon={Clock} label="Latest batch" value={(batches[0] as any)?.status ? datasetStatusLabel((batches[0] as any).status) : "--"} detail={(batches[0] as any)?.created_at ? formatDate((batches[0] as any).created_at) : "No batch yet"} />
          <MetricTile icon={BarChart3} label="Visible tokens" value={formatNumber(historyTotals.tokens || batchTotals.tokens || 0)} detail={tab === "history" ? "Current history page" : "Selected batch rows"} />
          <MetricTile icon={Database} label="Visible cost" value={formatCurrency(historyTotals.cost || batchTotals.cost || 0)} detail={tab === "history" ? `${formatNumber(runHistory.length)} history rows` : `${formatNumber(batchRuns.length)} batch rows`} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2 text-xs">
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className={`h-2 w-2 rounded-full ${hasActiveDatasetWork ? "bg-emerald-500" : "bg-muted-foreground/50"}`} />
            {syncMode === "stream"
              ? "Live sync via server events (updates on change)"
              : hasActiveDatasetWork
                // @ts-expect-error -- strict migration
                ? `Fallback polling every ${Math.round(AUTO_REFRESH_MS / 1000)}s while work is active`
                : "Fallback polling every 15s while idle"}
          </div>
          <div className="text-muted-foreground">
            Last sync: {formatRelativeTime(lastSyncAt)} {lastSyncAt ? `(${formatDate(lastSyncAt)})` : ""}
          </div>
        </div>

        <Tabs value={tab} onValueChange={setRunsTab}>
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="sites">Websites</TabsTrigger>
            <TabsTrigger value="batches">Batches</TabsTrigger>
            <TabsTrigger value="history">Run history</TabsTrigger>
          </TabsList>

          <TabsContent value="sites" className="space-y-4">
            <SitesTab
              sites={sites}
              siteTotal={siteTotal}
              selectedSiteIds={selectedSiteIds}
              // @ts-expect-error -- strict migration
              onSelectSiteIds={setSelectedSiteIds}
              query={query}
              onQueryChange={setQuery}
              language={language}
              label={label}
              isLoading={isLoading}
              actionError={actionError}
              onOpenCreate={() => setSiteDialogOpen(true)}
              onOpenDetail={openSiteDetail}
              // @ts-expect-error -- strict migration
              onRunBatch={(site) => createBatch({ site })}
              healthMap={siteHealthMap}
            />
            <Card>
              <CardHeader className="pb-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">Website dataset</CardTitle>
                    <CardDescription>
                      The CSV is used as the initial seed only; edits here are stored in the database.
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Select
                      className="w-[210px]"
                      value={healthCheckScope}
                      onChange={setHealthCheckScope}
                      options={healthCheckScopeOptions}
                      disabled={isSiteHealthChecking}
                    />
                    <Button
                      variant="outline"
                      onClick={checkVisibleSiteHealth}
                      disabled={!healthCheckTargetCount || isSiteHealthChecking}
                    >
                      <Activity className={`h-4 w-4 ${isSiteHealthChecking ? "animate-pulse" : ""}`} />
                      {isSiteHealthChecking ? "Checking..." : `Check websites (${healthCheckTargetCount})`}
                    </Button>
                    <Select
                      className="w-[190px]"
                      value={healthSelectionAction}
                      onChange={selectSitesByHealth}
                      options={healthSelectionOptions}
                      disabled={!sites.length || isSiteHealthChecking}
                    />
                    <ConfirmAction
                      title="Delete selected websites?"
                      description="Selected websites are removed from the dataset. Existing run records remain linked by run ID and batch history."
                      actionLabel={`Delete ${selectedSiteIds.length} selected`}
                      onConfirm={deleteSelectedSites}
                      trigger={(
                        <Button
                          variant="danger"
                          disabled={!selectedSiteIds.length || busyAction === "delete-selected-sites"}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete selected ({selectedSiteIds.length})
                        </Button>
                      )}
                    />
                    <ConfirmAction
                      title="Delete down websites?"
                      description="Deletes checked dead/fake-success websites: down, seized, parked, empty, limited, asset-only, or HTTP-error rows. Blocked access and anti-bot rows are kept."
                      actionLabel={`Delete ${downSiteIds.length} down`}
                      onConfirm={deleteDownSites}
                      trigger={(
                        <Button
                          variant="danger"
                          disabled={!downSiteIds.length || busyAction === "delete-down-sites"}
                        >
                          <Trash2 className="h-4 w-4" />
                          Delete down ({downSiteIds.length})
                        </Button>
                      )}
                    />
                    <Button
                      variant="outline"
                      // @ts-expect-error -- strict migration
                      onClick={() => createBatch({ urls: selectedUrls })}
                      disabled={!selectedUrls.length || busyAction === "run-selected"}
                    >
                      <Play className="h-4 w-4" />
                      {busyAction === "run-selected" ? "Launching..." : `Run selected (${selectedUrls.length})`}
                    </Button>
                    <Button
                      variant="accent"
                      onClick={() => createBatch({ urls: [] })}
                      disabled={!sites.length || busyAction === "run-filtered"}
                    >
                      <Play className="h-4 w-4" />
                      {busyAction === "run-filtered" ? "Launching..." : "Run all filtered"}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative min-w-[260px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="Search URL, language, label, or notes"
                      className="pl-9"
                    />
                  </div>
                  <Select
                    className="w-[180px]"
                    value={language}
                    onChange={setLanguage}
                              options={languageOptions(languages as any, true)}
                  />
                  <Select
                    className="w-[180px]"
                    value={label}
                    onChange={setLabel}
                              options={labelOptions(labels as any, true)}
                  />
                  <Button variant="ghost" onClick={() => { setQuery(""); setLanguage(""); setLabel(""); }}>
                    Reset
                  </Button>
                  <div className="text-xs text-muted-foreground">
                    Health: {formatNumber(workingVisibleCount)} working / {formatNumber(checkedVisibleCount)} checked
                    {siteHealthCheckedAt ? ` - ${formatRelativeTime(siteHealthCheckedAt)}` : ""}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <div className="max-h-[62vh] overflow-auto">
              <Table className="min-w-[1180px] table-fixed">
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox checked={allVisibleSelected} onCheckedChange={(checked) => toggleAllVisible(checked === true)} aria-label="Select all visible websites" />
                    </TableHead>
                    <TableHead className="w-[340px]">Website</TableHead>
                    <TableHead className="w-[170px]">Language</TableHead>
                    <TableHead className="w-[160px]">Label</TableHead>
                    <TableHead className="w-[280px]">Latest run</TableHead>
                    <TableHead className="w-[95px] text-right">Cost</TableHead>
                    <TableHead className="w-[95px] text-right">Tokens</TableHead>
                    <TableHead className="w-[220px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading ? (
                    Array.from({ length: 7 }).map((_, index) => (
                      <TableRow key={index}>
                        <TableCell colSpan={8}><Skeleton className="h-8 w-full" /></TableCell>
                      </TableRow>
                    ))
                  ) : sites.length ? (
                    sites.map((site) => {
                      // @ts-expect-error -- strict migration
                      const latest = site.latest_run || EMPTY_OBJECT;
                      const status = datasetRunStatus(latest);
                      const cost = effectiveRunCost(latest, pricingMap);
                      return (
                        <TableRow key={(site as any).id} className="h-auto [&>td]:py-2">
                          <TableCell className="align-middle">
                            <Checkbox checked={(selectedSiteIds as any).includes((site as any).id)} onCheckedChange={(checked) => toggleSite((site as any).id, checked === true)} aria-label={`Select ${(site as any).url}`} />
                          </TableCell>
                          <TableCell className="align-middle">
                            <SiteIdentity site={site} health={healthForSite(site)} />
                          </TableCell>
                          <TableCell className="align-middle">
                            <Select
                              value={(site as any).language || ""}
                              onChange={(value: any) => updateSite((site as any).id, { language: value } as any)}
                              options={languageOptions(languages as any, false)}
                            />
                          </TableCell>
                          <TableCell className="align-middle">
                            <Select
                              value={(site as any).label || ""}
                              onChange={(value: any) => updateSite((site as any).id, { label: value } as any)}
                              options={labelOptions(labels as any)}
                            />
                          </TableCell>
                          <TableCell className="align-top">
                            {latest.run_id ? (
                              <div>
                                <Badge tone={statusToneForDataset(status) as any}>{datasetStatusLabel(status)}</Badge>
                                <div className="mt-1">
                                  <Link
                                    href={`/runs/${latest.run_id}`}
                                    className="block max-w-[260px] break-all font-mono text-[11px] text-primary hover:underline"
                                    title={latest.run_id}
                                  >
                                    {latest.run_id}
                                  </Link>
                                </div>
                                <div className="mt-0.5 text-xs text-muted-foreground">
                                  {formatDate(latest.created_at)}
                                </div>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">Not run yet</span>
                            )}
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums text-xs">
                            {formatCurrency(cost.total)}
                            {cost.source === "partial" ? (
                              <div className="text-[11px] text-muted-foreground">partial</div>
                            ) : null}
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums text-xs">
                            {formatNumber(runTokenTotal(latest))}
                          </TableCell>
                          <TableCell className="align-middle">
                            <div className="flex flex-nowrap items-center gap-1.5 whitespace-nowrap">
                              <Button size="sm" variant="outline" onClick={() => openSiteDetail(site)}>
                                <Eye className="h-3.5 w-3.5" />
                                Results
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => createBatch({ site })} disabled={busyAction === `run-site-${(site as any).id}`}>
                                <Play className="h-3.5 w-3.5" />
                                Run
                              </Button>
                              <Button size="icon-sm" variant="ghost" onClick={() => openEditSite(site)} aria-label={`Edit ${(site as any).url}`}>
                                <Edit3 className="h-3.5 w-3.5" />
                              </Button>
                              <ConfirmAction
                                title="Delete website?"
                                description="The website is removed from the dataset. Existing run records remain linked by run ID and batch history."
                                actionLabel="Delete website"
                                onConfirm={() => deleteSite((site as any).id as any)}
                                trigger={(
                                  <Button size="icon-sm" variant="ghost" disabled={busyAction === `delete-site-${(site as any).id}`} aria-label={`Delete ${(site as any).url}`}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                )}
                              />
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })
                  ) : (
                    <TableRow>
                      <TableCell colSpan={8} className="py-14 text-center">
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-foreground">No websites match the current filters</div>
                          <div className="text-xs text-muted-foreground">Try clearing search, language, or label filters.</div>
                          <div>
                            <Button variant="outline" size="sm" onClick={() => { setQuery(""); setLanguage(""); setLabel(""); }}>
                              Reset filters
                            </Button>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              </div>
            </Card>
          </TabsContent>

          <TabsContent value="batches" className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
            <BatchesTab
              batches={batches}
              selectedBatchId={selectedBatchId}
              onSelect={setSelectedBatchId}
              detail={batchDetail}
              isLoading={isBatchLoading}
            />
            <Card className="overflow-hidden">
              <CardHeader className="border-b px-4 py-3">
                <CardTitle className="text-base">Batch runs</CardTitle>
                <CardDescription>Every batch owns site-run rows that link to the same `/runs/id` detail.</CardDescription>
              </CardHeader>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Batch</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batches.length ? (
                    batches.map((batch) => (
                        <TableRow
                          key={(batch as any).batch_id}
                          className={`${(batch as any).batch_id === selectedBatchId ? "bg-muted/40" : ""} [&>td]:py-2.5`}
                          onClick={() => openBatch((batch as any).batch_id)}
                        >
                        <TableCell className="cursor-pointer">
                          <div className="font-mono text-xs">{compactRunId((batch as any).batch_id)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{(batch as any).batch_name || "Untitled batch"}</div>
                          <div className="mt-1 text-[11px] text-muted-foreground">{formatDate((batch as any).created_at)}</div>
                        </TableCell>
                        <TableCell className="cursor-pointer">
                          <Badge tone={statusToneForDataset((batch as any).status) as any}>{datasetStatusLabel((batch as any).status)}</Badge>
                          <div className="mt-2 w-28"><BatchProgress batch={batch} /></div>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={2} className="py-10 text-center">
                        <div className="space-y-2">
                          <div className="text-sm font-medium text-foreground">No batches have been launched yet</div>
                          <div className="text-xs text-muted-foreground">Select websites in the dataset tab and launch a workflow batch.</div>
                          <div>
                            <Button size="sm" variant="outline" onClick={() => setRunsTab("sites")}>
                              Open websites tab
                            </Button>
                          </div>
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>

            <Card className="overflow-hidden">
              <CardHeader className="border-b px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">Batch detail</CardTitle>
                    <CardDescription>
                      Cost and token totals are computed from logged usage or provider pricing when totals are missing.
                    </CardDescription>
                  </div>
                  {selectedBatchId ? (
                    <div className="flex flex-wrap gap-2">
                      {canCancelDisplayedBatch ? (
                        <ConfirmAction
                          title="Cancel this batch?"
                          description="Queued and running site runs in this batch will be marked cancelled and active workers will be asked to stop."
                          actionLabel="Cancel batch"
                          onConfirm={() => cancelBatch(selectedBatchId)}
                          trigger={(
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busyAction === `cancel-batch-${selectedBatchId}`}
                            >
                              <XCircle className="h-4 w-4" />
                              Cancel batch
                            </Button>
                          )}
                        />
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled
                          title="This batch has no queued or running site runs to cancel."
                        >
                          <XCircle className="h-4 w-4" />
                          Cancel batch
                        </Button>
                      )}
                      <Button variant="outline" size="sm" onClick={() => setRefreshTick((value) => value + 1)} disabled={isBatchLoading}>
                        <RefreshCw className={`h-4 w-4 ${isBatchLoading ? "animate-spin" : ""}`} />
                        Refresh batch
                      </Button>
                    </div>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                {displayedBatchDetail ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
                      <MetricTile icon={Activity} label="Status" value={datasetStatusLabel(displayedBatchDetail.status)} detail={displayedBatchDetail.batch_name || "Untitled batch"} />
                      <MetricTile icon={CheckCircle2} label="Completed" value={`${formatNumber(displayedBatchDetail.completed_count || 0)} / ${formatNumber(displayedBatchDetail.requested_count || 0)}`} detail={`${formatNumber(displayedBatchDetail.success_rate || 0)}% strict success`} />
                      <MetricTile icon={Bot} label="Agent success" value={pct(displayedBatchDetail.adjusted_success_rate || 0)} detail={`${formatNumber(displayedBatchDetail.external_blocked_count || 0)} server/site blockers excluded`} />
                      <MetricTile icon={Database} label="Batch cost" value={formatCurrency(batchTotals.cost)} detail={`${formatNumber(batchRuns.length)} site runs`} />
                      <MetricTile icon={BarChart3} label="Tokens" value={formatNumber(batchTotals.tokens)} detail="Summed per site run" />
                      <MetricTile icon={Globe2} label="Streams" value={formatNumber(batchTotals.streams)} detail="Collected streams" />
                    </div>
                    <BatchProgress batch={displayedBatchDetail} />
                    {isBatchLoading && !batchRuns.length ? (
                      <div className="rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        Loading site-run rows for this batch...
                      </div>
                    ) : null}
                    <div className="overflow-hidden rounded-lg border">
                      <div className="max-h-[56vh] overflow-auto">
                      <Table className="min-w-[960px] table-fixed">
                        <TableHeader className="bg-muted/40">
                          <TableRow>
                            <TableHead className="w-[280px]">Website</TableHead>
                            <TableHead className="w-[180px]">Status</TableHead>
                            <TableHead className="w-[240px]">Agent/model</TableHead>
                            <TableHead className="w-[95px] text-right">Tokens</TableHead>
                            <TableHead className="w-[105px] text-right">Cost</TableHead>
                            <TableHead className="w-[240px]">Run</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {batchRuns.length ? (
                            batchRuns.map((row: any) => {
                              const status = datasetRunStatus(row);
                              const cost = displayBatchRunCost(row);
                              const models = summarizeModelUsage(row.model_usage || EMPTY_ARRAY);
                              return (
                                <TableRow key={(row as any).run_id} className="[&>td]:py-2.5">
                                  <TableCell className="max-w-[320px] align-top">
                                    <div className="truncate text-sm font-medium" title={(row as any).url}>{(row as any).url}</div>
                                    <div className="mt-1 flex gap-1.5">
                                      <Badge>{row.language || "unlabeled"}</Badge>
                                      <Badge tone="signal">{row.label || "unlabeled"}</Badge>
                                    </div>
                                  </TableCell>
                                  <TableCell className="align-top">
                                    <Badge tone={statusToneForDataset(status) as any}>{datasetStatusLabel(status)}</Badge>
                                    {row.error_text ? <div className="mt-1 max-w-[220px] truncate text-xs text-destructive" title={row.error_text}>{row.error_text}</div> : null}
                                  </TableCell>
                                  <TableCell className="align-top text-xs text-muted-foreground">
                                    <div>{formatNumber(row.agent_runs?.length || 0)} agents</div>
                                    <div className="mt-1 max-w-[260px] truncate" title={models.join(", ")}>
                                      {models.join(", ") || "No model usage"}
                                    </div>
                                    <div className="mt-1 text-[11px]">
                                      Cost: {cost.source === "estimating" ? "Estimating..." : formatCurrency(cost.total)}
                                      <span className="ml-1 text-muted-foreground">
                                        {batchCostSourceLabel(cost.source)}
                                      </span>
                                    </div>
                                  </TableCell>
                                  <TableCell className="align-top text-right tabular-nums text-xs">
                                    {formatNumber(runTokenTotal(row))}
                                  </TableCell>
                                  <TableCell className="align-top text-right tabular-nums text-xs">
                                    {cost.source === "estimating" ? "--" : formatCurrency(cost.total)}
                                    <div className="text-[11px] text-muted-foreground">
                                      {batchCostSourceLabel(cost.source)}
                                    </div>
                                  </TableCell>
                                  <TableCell className="align-top">
                                    <Button asChild size="sm" variant="outline">
                                      <Link href={`/runs/${(row as any).run_id}`}>
                                        <span className="max-w-[220px] truncate font-mono text-[11px]" title={(row as any).run_id}>
                                          {(row as any).run_id}
                                        </span>
                                      </Link>
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              );
                            })
                          ) : (
                            <TableRow>
                              <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                                {isBatchLoading ? "Loading site runs..." : "This batch has no site runs."}
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                      </div>
                    </div>
                  </>
                ) : isBatchLoading ? (
                  <div className="rounded-lg border border-border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
                    Loading batch detail...
                  </div>
                ) : (
                  <div className="py-16 text-center text-sm text-muted-foreground">
                    Select a batch to view results.
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="history">
            <HistoryTab
              rows={runHistory}
              total={runHistoryTotal}
              status={historyStatus}
              onStatusChange={setHistoryStatusFilter}
              query={historyQuery}
              onQueryChange={setHistorySearch}
              page={historyPage}
              onPageChange={setHistoryPageIndex}
              pageSize={HISTORY_PAGE_SIZE}
              isLoading={isHistoryLoading}
              onRefresh={() => setRefreshTick((v) => v + 1)}
            />
            <Card className="overflow-hidden">
              <CardHeader className="border-b px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base">Run history</CardTitle>
                    <CardDescription>
                      Search, page, select, restart, stop, and delete persisted workflow and agent runs.
                    </CardDescription>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="default" className="font-mono">
                      {formatNumber(runHistoryTotal)} total
                    </Badge>
                    {selectedHistoryRunIds.length ? (
                      <Badge tone="signal" className="font-mono">
                        {formatNumber(selectedHistoryRunIds.length)} selected
                      </Badge>
                    ) : null}
                  </div>
                </div>
              </CardHeader>
              <div className="border-b bg-muted/20 px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="relative min-w-[280px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={historyQuery}
                      onChange={(event) => setHistorySearch(event.target.value)}
                      placeholder="Search run ID, URL, status, actor, provider, or model"
                      className="pl-9"
                    />
                  </div>
                  <Select
                    className="w-[190px]"
                    value={historyStatus}
                    onChange={setHistoryStatusFilter}
                    options={HISTORY_STATUS_FILTERS}
                    placeholder="Status"
                  />
                  <Button
                    variant="ghost"
                    onClick={resetHistoryFilters}
                  >
                    Reset
                  </Button>
                  <ConfirmAction
                    title="Delete selected runs?"
                    description={`Deletes ${selectedDeletableHistoryIds.length} selected persisted run records and their telemetry. Active runs are skipped.`}
                    actionLabel="Delete selected"
                    onConfirm={deleteSelectedHistoryRuns}
                    trigger={(
                      <Button
                        variant="outline"
                        disabled={!selectedDeletableHistoryIds.length || historyBusyRunId === "__bulk_delete__"}
                      >
                        <Trash2 className="h-4 w-4" />
                        Delete selected ({selectedDeletableHistoryIds.length})
                      </Button>
                    )}
                  />
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-6">
                  <MetricTile icon={ListChecks} label="Rows on page" value={formatNumber(runHistory.length)} detail={`${formatNumber(historyStart)}-${formatNumber(historyEnd)} of ${formatNumber(runHistoryTotal)}`} />
                  <MetricTile icon={CheckCircle2} label="Success" value={formatNumber(historyTotals.success)} detail={`${pct(historyTotals.strictSuccessRate)} strict`} />
                  <MetricTile icon={XCircle} label="Agent failures" value={formatNumber(historyTotals.failed)} detail="Visible rows" />
                  <MetricTile icon={Globe2} label="Site blockers" value={formatNumber(historyTotals.externalBlocked)} detail={`${pct(historyTotals.adjustedSuccessRate)} agent success`} />
                  <MetricTile icon={Activity} label="Active" value={formatNumber(historyTotals.active)} detail="Queued or running" />
                  <MetricTile icon={BarChart3} label="Tokens" value={formatNumber(historyTotals.tokens)} detail="Visible rows" />
                  <MetricTile icon={Database} label="Cost" value={formatCurrency(historyTotals.cost)} detail={`${formatNumber(historyTotals.streams)} streams`} />
                </div>
              </div>
              <div className="overflow-auto">
                <Table className="min-w-[1120px] table-fixed">
                  <TableHeader className="bg-muted/40">
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allVisibleHistorySelected}
                          onCheckedChange={(checked) => {
                            // @ts-expect-error -- strict migration
                            setSelectedHistoryRunIds(checked === true ? visibleHistoryIds : []);
                          }}
                          aria-label="Select all visible runs"
                        />
                      </TableHead>
                      <TableHead className="w-[360px]">Run</TableHead>
                      <TableHead className="w-[135px]">Status</TableHead>
                      <TableHead className="w-[230px]">Actor/model</TableHead>
                      <TableHead className="w-[110px] text-right">Tokens</TableHead>
                      <TableHead className="w-[110px] text-right">Cost</TableHead>
                      <TableHead className="w-[260px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runHistory.length ? (
                      runHistory.map((row) => (
                        <TableRow key={(row as any).run_id} className="[&>td]:py-2.5">
                          <TableCell className="align-middle">
                            <Checkbox
                              checked={(selectedHistoryRunIds as any).includes((row as any).run_id)}
                              onCheckedChange={(checked) => {
                                // @ts-expect-error -- strict migration
                                setSelectedHistoryRunIds((current) => {
                                  if (checked === true) return Array.from(new Set([...current, (row as any).run_id]));
                                  return current.filter((runId) => runId !== (row as any).run_id);
                                });
                              }}
                              aria-label={`Select run ${(row as any).run_id}`}
                            />
                          </TableCell>
                          <TableCell className="align-top">
                            <Link
                              href={`/runs/${(row as any).run_id}`}
                              className="block max-w-[360px] break-all font-mono text-[11px] text-primary hover:underline"
                              title={(row as any).run_id}
                            >
                              // @ts-expect-error -- strict migration
                              {(row as any).run_id}
                            </Link>
                            <div className="mt-0.5 max-w-[360px] truncate text-[11px] text-muted-foreground" title={(row as any).url}>
                              {(row as any).url}
                            </div>
                            <div className="mt-1 text-[10px] text-muted-foreground">
                              {formatDate((row as any).created_at || (row as any).started_at)}
                            </div>
                          </TableCell>
                          <TableCell className="align-top">
                            <Badge tone={statusTone((row as any).final_status) as any}>{statusLabel((row as any).final_status)}</Badge>
                          </TableCell>
                          <TableCell className="align-top text-xs text-muted-foreground">
                            <div>{(row as any).root_actor || "--"}</div>
                            <div className="mt-0.5">{[(row as any).primary_provider, (row as any).primary_model].filter(Boolean).join(" / ") || "--"}</div>
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums text-xs">
                            {formatNumber(((row as any).total_tokens_in || 0) + ((row as any).total_tokens_out || 0))}
                          </TableCell>
                          <TableCell className="align-top text-right tabular-nums text-xs">
                            {formatCurrency((row as any).total_cost_usd ?? (row as any).estimated_total_cost_usd ?? 0)}
                          </TableCell>
                          <TableCell className="align-top">
                            <div className="flex flex-wrap gap-1.5">
                              <Button asChild size="sm" variant="outline">
                                <Link href={`/runs/${(row as any).run_id}`}>
                                  <Eye className="h-3.5 w-3.5" />
                                  View
                                </Link>
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={!(row as any).url || historyBusyRunId === (row as any).run_id}
                                // @ts-expect-error -- strict migration
                                onClick={() => createBatch({ urls: [(row as any).url] })}
                              >
                                Restart
                              </Button>
                              {canCancelRun(row) ? (
                                <Button size="sm" variant="outline" disabled={historyBusyRunId === (row as any).run_id} onClick={() => cancelRun((row as any).run_id)}>
                                  Stop
                                </Button>
                              ) : null}
                              {canDeleteRun(row) ? (
                                <ConfirmAction
                                  title="Delete this run?"
                                  description="Removes the run and its persisted telemetry. Batch rows keep their run ID but the run detail will no longer be available."
                                  actionLabel="Delete run"
                                  onConfirm={() => deleteRun((row as any).run_id)}
                                  trigger={(
                                    <Button size="sm" variant="outline" disabled={historyBusyRunId === (row as any).run_id}>
                                      <Trash2 className="h-3.5 w-3.5" />
                                      Delete
                                    </Button>
                                  )}
                                />
                              ) : null}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : isHistoryLoading ? (
                      Array.from({ length: 6 }).map((_, index) => (
                        <TableRow key={`history-loading-${index}`}>
                          <TableCell colSpan={7}>
                            <Skeleton className="h-8 w-full" />
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={7} className="py-14 text-center text-sm text-muted-foreground">
                          No run history matched the current search.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3 text-xs text-muted-foreground">
                <div>
                  Showing {formatNumber(historyStart)}-{formatNumber(historyEnd)} of {formatNumber(runHistoryTotal)} runs.
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={historyPage <= 0 || isHistoryLoading}
                    onClick={() => setHistoryPageIndex(historyPage - 1)}
                  >
                    Previous
                  </Button>
                  <span className="font-mono">
                    Page {formatNumber(historyPage + 1)} / {formatNumber(historyPageCount)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={historyPage >= historyPageCount - 1 || isHistoryLoading}
                    onClick={() => setHistoryPageIndex(historyPage + 1)}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </Card>
          </TabsContent>
        </Tabs>

        <SiteDialog
          open={siteDialogOpen}
          onOpenChange={setSiteDialogOpen}
          form={siteForm}
          setForm={setSiteForm}
          editingSite={editingSite}
          languages={languages}
          labels={labels}
          isSaving={isSiteSaving}
          error={siteSaveError}
          onSave={saveSite}
        />

        <SiteDetailSheet
          open={detailOpen}
          onOpenChange={setDetailOpen}
          siteDetail={siteDetail}
          isLoading={isSiteDetailLoading}
          selectedRunId={selectedRunId}
          setSelectedRunId={setSelectedRunId}
          runDetail={runDetail}
          runDetailLoading={runDetailLoading}
          pricingMap={pricingMap}
          onRunSite={(site: any) => createBatch({ site })}
          onOpenBatch={openBatch}
        />
      </div>
    </TooltipProvider>
  );
}