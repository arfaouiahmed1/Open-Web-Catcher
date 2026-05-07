"use client";

/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
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
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  XCircle,
} from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import {
  datasetRunStatus,
  effectiveRunCost,
  runTokenTotal,
  statusToneForDataset,
  summarizeModelUsage,
  toNumber,
} from "@/lib/dataset-runs";
import { loadPricing } from "@/lib/pricing";
import {
  canCancelRun,
  canDeleteRun,
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const AUTO_REFRESH_MS = 8000;
const CUSTOM_LANGUAGE = "__custom__";
const EMPTY_ARRAY = [];
const EMPTY_OBJECT = {};

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

function formatDate(value) {
  if (!value) return "--";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function formatDuration(seconds) {
  const value = Number(seconds || 0);
  if (!value) return "--";
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${Math.round(value % 60)}s`;
}

function compactRunId(runId) {
  const value = String(runId || "");
  return value ? `${value.slice(0, 12)}...` : "--";
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

function isActiveStatus(value) {
  return ["queued", "running", "retrying", "leased"].includes(String(value || "").toLowerCase());
}

function datasetStatusLabel(value) {
  const status = String(value || "").trim().toLowerCase();
  if (!status) return "Queued";
  return statusLabel(status);
}

function SiteIdentity({ site }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <a
          href={site.url}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 truncate text-sm font-medium text-foreground hover:underline"
          title={site.url}
        >
          {site.url}
        </a>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>#{site.id}</span>
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

function MetricTile({ icon: Icon, label, value, detail }) {
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

function BatchProgress({ batch }) {
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
}) {
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
            onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
            placeholder="https://example.com"
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Language"
              value={form.language}
              onChange={(value) =>
                setForm((current) => ({
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
              onChange={(value) => setForm((current) => ({ ...current, label: value }))}
              options={labelOptions(labels)}
            />
          </div>
          {form.language === CUSTOM_LANGUAGE ? (
            <Input
              value={form.customLanguage}
              onChange={(event) =>
                setForm((current) => ({ ...current, customLanguage: event.target.value }))
              }
              placeholder="Type any language"
            />
          ) : null}
          <Textarea
            value={form.notes}
            onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))}
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
}) {
  const site = siteDetail?.site || EMPTY_OBJECT;
  const runs = siteDetail?.runs || EMPTY_ARRAY;
  const summary = siteDetail?.summary || EMPTY_OBJECT;
  const selectedRun = runs.find((run) => run.run_id === selectedRunId) || runs[0] || null;
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
                  href={site.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-1.5 truncate text-base font-semibold text-primary hover:underline"
                >
                  <span className="truncate">{site.url || "--"}</span>
                  <ExternalLink className="h-4 w-4 shrink-0" />
                </a>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge>{site.language || "unlabeled"}</Badge>
                  <Badge tone="signal">{site.label || "unlabeled"}</Badge>
                  <Badge tone={site.success_rate >= 80 ? "success" : site.success_rate > 0 ? "warning" : "default"}>
                    {formatNumber(site.success_rate || 0)}% success
                  </Badge>
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
                      runs.map((row) => {
                        const status = datasetRunStatus(row);
                        const cost = effectiveRunCost(row, pricingMap);
                        return (
                          <TableRow
                            key={row.run_id}
                            className={row.run_id === selectedRunId ? "bg-muted/40" : undefined}
                          >
                            <TableCell className="align-top">
                              <Link href={`/runs/${row.run_id}`} className="font-mono text-xs text-primary hover:underline">
                                {compactRunId(row.run_id)}
                              </Link>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {formatDate(row.created_at)}
                              </div>
                            </TableCell>
                            <TableCell className="align-top">
                              <Badge tone={statusToneForDataset(status)}>
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
                              <Button size="sm" variant="outline" onClick={() => setSelectedRunId(row.run_id)}>
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
                            onClick={() => onOpenBatch(datasetContext.batch.batch_id)}
                          >
                            {datasetContext.batch.batch_name || compactRunId(datasetContext.batch.batch_id)}
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
                                (agentRollups.length ? agentRollups : selectedRun.agent_runs || EMPTY_ARRAY).map((agent, index) => (
                                  <TableRow key={`${agent.actor || agent.agent_type || "agent"}-${index}`}>
                                    <TableCell className="text-xs">
                                      <div className="font-medium">{agent.agent_type || agent.actor || "--"}</div>
                                      <div className="text-muted-foreground">{agent.actor || "--"}</div>
                                    </TableCell>
                                    <TableCell>
                                      <Badge tone={statusToneForDataset(agent.status)}>
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
                            {screenshots.slice(0, 4).map((screenshot, index) => {
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
  const [tab, setTab] = useState("sites");
  const [sites, setSites] = useState([]);
  const [siteTotal, setSiteTotal] = useState(0);
  const [meta, setMeta] = useState({ languages: FALLBACK_LANGUAGES, labels: FALLBACK_LABELS, stats: {} });
  const [batches, setBatches] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const [batchDetail, setBatchDetail] = useState(null);
  const [runHistory, setRunHistory] = useState([]);
  const [runHistoryTotal, setRunHistoryTotal] = useState(0);
  const [pricingMap, setPricingMap] = useState(null);
  const [selectedSiteIds, setSelectedSiteIds] = useState([]);
  const [query, setQuery] = useState("");
  const [language, setLanguage] = useState("");
  const [label, setLabel] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isBatchLoading, setIsBatchLoading] = useState(false);
  const [actionError, setActionError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [siteDialogOpen, setSiteDialogOpen] = useState(false);
  const [editingSite, setEditingSite] = useState(null);
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
  const [siteDetail, setSiteDetail] = useState(null);
  const [isSiteDetailLoading, setIsSiteDetailLoading] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [runDetail, setRunDetail] = useState(null);
  const [runDetailLoading, setRunDetailLoading] = useState(false);
  const [historyBusyRunId, setHistoryBusyRunId] = useState("");
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [isPricingLoading, setIsPricingLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  const languages = meta.languages || FALLBACK_LANGUAGES;
  const labels = meta.labels || FALLBACK_LABELS;
  const stats = meta.stats || EMPTY_OBJECT;

  const selectedSites = useMemo(
    () => sites.filter((site) => selectedSiteIds.includes(site.id)),
    [selectedSiteIds, sites],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const batchId = params.get("batch") || "";
    if (batchId) {
      setSelectedBatchId(batchId);
      setTab("batches");
    }
  }, []);

  const hasActiveDatasetWork = useMemo(() => {
    const siteActive = sites.some((site) =>
      isActiveStatus(datasetRunStatus(site.latest_run || EMPTY_OBJECT)),
    );
    const batchActive = isActiveStatus(batchDetail?.status) || batches.some((batch) => isActiveStatus(batch.status));
    return siteActive || batchActive;
  }, [batchDetail?.status, batches, sites]);

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
        languages: metaPayload.languages || FALLBACK_LANGUAGES,
        labels: metaPayload.labels || FALLBACK_LABELS,
        stats: metaPayload.stats || {},
      });
      setSites(sitesPayload.sites || []);
      setSiteTotal(sitesPayload.total || 0);
      setBatches(batchesPayload.batches || []);
      setSelectedSiteIds((current) =>
        current.filter((id) => (sitesPayload.sites || []).some((site) => site.id === id)),
      );
      const nextBatchId =
        selectedBatchId || (tab === "batches" ? batchesPayload.batches?.[0]?.batch_id : "") || "";
      if (nextBatchId) {
        setSelectedBatchId(nextBatchId);
      } else {
        setBatchDetail(null);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to load runs dashboard");
    } finally {
      setIsLoading(false);
    }
  }, [label, language, query, selectedBatchId, tab]);

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
  }, [refreshTick]);

  useEffect(() => {
    if (!hasActiveDatasetWork) return undefined;
    const timer = setInterval(() => setRefreshTick((value) => value + 1), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [hasActiveDatasetWork]);

  useEffect(() => {
    if (tab !== "history") return undefined;
    let cancelled = false;
    setIsHistoryLoading(true);
    apiFetch(`/ui/runs?limit=25&offset=0&query=${encodeURIComponent(query)}`)
      .then((payload) => {
        if (!cancelled) {
          setRunHistory(payload.rows || []);
          setRunHistoryTotal(payload.total || 0);
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
  }, [query, refreshTick, tab]);

  useEffect(() => {
    if (tab !== "batches") return undefined;
    const batchId = selectedBatchId || batches[0]?.batch_id || "";
    if (!batchId) {
      setBatchDetail(null);
      return undefined;
    }
    let cancelled = false;
    setIsBatchLoading(true);
    apiFetch(`/api/datasets/batches/${batchId}`)
      .then((detail) => {
        if (!cancelled) {
          setSelectedBatchId(batchId);
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
  }, [batches, selectedBatchId, tab]);

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
      .catch(() => {
        if (!cancelled) setRunDetail(null);
      })
      .finally(() => {
        if (!cancelled) setRunDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId]);

  function toggleSite(siteId, checked) {
    setSelectedSiteIds((current) => {
      if (checked) return Array.from(new Set([...current, siteId]));
      return current.filter((id) => id !== siteId);
    });
  }

  function toggleAllVisible(checked) {
    if (!checked) {
      setSelectedSiteIds([]);
      return;
    }
    setSelectedSiteIds(sites.map((site) => site.id));
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

  function openEditSite(site) {
    const knownLanguage = languageOptions(languages).some((option) => option.value === site.language);
    setEditingSite(site);
    setSiteSaveError("");
    setSiteForm({
      url: site.url || "",
      language: knownLanguage || !site.language ? site.language || "english" : CUSTOM_LANGUAGE,
      customLanguage: knownLanguage ? "" : site.language || "",
      label: site.label || "piracy",
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
    } catch (error) {
      setSiteSaveError(error instanceof Error ? error.message : "Failed to save website");
    } finally {
      setIsSiteSaving(false);
    }
  }

  async function updateSite(siteId, patch) {
    setActionError("");
    try {
      await apiFetch(`/api/datasets/sites/${siteId}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      setRefreshTick((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to update website");
    }
  }

  async function deleteSite(siteId) {
    setBusyAction(`delete-site-${siteId}`);
    setActionError("");
    try {
      await apiFetch(`/api/datasets/sites/${siteId}`, { method: "DELETE" });
      setSelectedSiteIds((current) => current.filter((id) => id !== siteId));
      setRefreshTick((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to delete website");
    } finally {
      setBusyAction("");
    }
  }

  async function createBatch({ urls = [], site = null } = {}) {
    setBusyAction(urls.length ? "run-selected" : site ? `run-site-${site.id}` : "run-filtered");
    setActionError("");
    try {
      const body = {
        batch_name: site
          ? `Single site: ${site.url}`
          : urls.length
            ? `Selected websites (${urls.length})`
            : `Filtered websites${language ? ` / ${language}` : ""}${label ? ` / ${label}` : ""}`,
        language,
        label,
        query,
        limit: 0,
        urls: site ? [site.url] : urls,
      };
      const created = await apiFetch("/api/datasets/batches", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setSelectedBatchId(created.batch_id);
      setBatchDetail(created);
      setTab("batches");
      setRefreshTick((value) => value + 1);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to launch workflow batch");
    } finally {
      setBusyAction("");
    }
  }

  async function openSiteDetail(site) {
    setDetailOpen(true);
    setIsSiteDetailLoading(true);
    setSiteDetail(null);
    setSelectedRunId("");
    try {
      const detail = await apiFetch(`/api/datasets/sites/${site.id}?limit=30`);
      setSiteDetail(detail);
      const firstRunId = detail.runs?.[0]?.run_id || "";
      setSelectedRunId(firstRunId);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to load website detail");
    } finally {
      setIsSiteDetailLoading(false);
    }
  }

  async function openBatch(batchId) {
    if (!batchId) return;
    setTab("batches");
    setSelectedBatchId(batchId);
    setIsBatchLoading(true);
    try {
      const detail = await apiFetch(`/api/datasets/batches/${batchId}`);
      setBatchDetail(detail);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Failed to load batch");
    } finally {
      setIsBatchLoading(false);
    }
  }

  async function cancelRun(runId) {
    setHistoryBusyRunId(runId);
    try {
      await fetch(apiUrl(`/ui/runs/${runId}/cancel`), { method: "POST" });
      setRefreshTick((value) => value + 1);
    } finally {
      setHistoryBusyRunId("");
    }
  }

  async function deleteRun(runId) {
    setHistoryBusyRunId(runId);
    try {
      await fetch(apiUrl(`/ui/runs/${runId}`), { method: "DELETE" });
      setRefreshTick((value) => value + 1);
    } finally {
      setHistoryBusyRunId("");
    }
  }

  const allVisibleSelected = sites.length > 0 && selectedSiteIds.length === sites.length;
  const selectedUrls = selectedSites.map((site) => site.url).filter(Boolean);
  const batchRuns = batchDetail?.runs || EMPTY_ARRAY;
  const batchTotals = useMemo(() => {
    return batchRuns.reduce(
      (acc, row) => {
        const cost = effectiveRunCost(row, pricingMap);
        acc.cost += cost.total;
        acc.tokens += runTokenTotal(row);
        acc.streams += toNumber(row.stream_count || row.run?.stream_count, 0);
        return acc;
      },
      { cost: 0, tokens: 0, streams: 0 },
    );
  }, [batchRuns, pricingMap]);

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

        {actionError ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{actionError}</span>
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <MetricTile icon={Globe2} label="Websites" value={formatNumber(stats.total || siteTotal)} detail={`${formatNumber(stats.unlabeled || 0)} unlabeled`} />
          <MetricTile icon={CheckCircle2} label="Success rate" value={`${formatNumber(stats.success_rate || 0)}%`} detail={`${formatNumber(stats.successful_runs || 0)} / ${formatNumber(stats.total_runs || 0)} completed`} />
          <MetricTile icon={Activity} label="Batches" value={formatNumber(batches.length)} detail={hasActiveDatasetWork ? "Active work polling" : "No active batch"} />
          <MetricTile
            icon={Database}
            label="Pricing catalog"
            value={isPricingLoading ? "--" : formatNumber(pricingMap?.size || 0)}
            detail={isPricingLoading ? "Loading provider pricing..." : "Loaded from provider pricing API and stored pricing"}
          />
          <MetricTile icon={Clock} label="Latest batch" value={batches[0]?.status ? datasetStatusLabel(batches[0].status) : "--"} detail={batches[0]?.created_at ? formatDate(batches[0].created_at) : "No batch yet"} />
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="h-auto flex-wrap justify-start">
            <TabsTrigger value="sites">Websites</TabsTrigger>
            <TabsTrigger value="batches">Batches</TabsTrigger>
            <TabsTrigger value="history">Run history</TabsTrigger>
          </TabsList>

          <TabsContent value="sites" className="space-y-4">
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
                    <Button
                      variant="outline"
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
                    options={languageOptions(languages, true)}
                  />
                  <Select
                    className="w-[180px]"
                    value={label}
                    onChange={setLabel}
                    options={labelOptions(labels, true)}
                  />
                  <Button variant="ghost" onClick={() => { setQuery(""); setLanguage(""); setLabel(""); }}>
                    Reset
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-hidden">
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead className="w-10">
                      <Checkbox checked={allVisibleSelected} onCheckedChange={(checked) => toggleAllVisible(checked === true)} aria-label="Select all visible websites" />
                    </TableHead>
                    <TableHead>Website</TableHead>
                    <TableHead className="w-[170px]">Language</TableHead>
                    <TableHead className="w-[160px]">Label</TableHead>
                    <TableHead>Latest run</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
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
                      const latest = site.latest_run || EMPTY_OBJECT;
                      const status = datasetRunStatus(latest);
                      const cost = effectiveRunCost(latest, pricingMap);
                      return (
                        <TableRow key={site.id}>
                          <TableCell className="align-top">
                            <Checkbox checked={selectedSiteIds.includes(site.id)} onCheckedChange={(checked) => toggleSite(site.id, checked === true)} aria-label={`Select ${site.url}`} />
                          </TableCell>
                          <TableCell className="align-top">
                            <SiteIdentity site={site} />
                          </TableCell>
                          <TableCell className="align-top">
                            <Select
                              value={site.language || ""}
                              onChange={(value) => updateSite(site.id, { language: value })}
                              options={languageOptions(languages, false)}
                            />
                          </TableCell>
                          <TableCell className="align-top">
                            <Select
                              value={site.label || ""}
                              onChange={(value) => updateSite(site.id, { label: value })}
                              options={labelOptions(labels)}
                            />
                          </TableCell>
                          <TableCell className="align-top">
                            {latest.run_id ? (
                              <div>
                                <Badge tone={statusToneForDataset(status)}>{datasetStatusLabel(status)}</Badge>
                                <div className="mt-1">
                                  <Link href={`/runs/${latest.run_id}`} className="font-mono text-xs text-primary hover:underline">
                                    {compactRunId(latest.run_id)}
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
                          <TableCell className="align-top">
                            <div className="flex flex-wrap gap-1.5">
                              <Button size="sm" variant="outline" onClick={() => openSiteDetail(site)}>
                                <Eye className="h-3.5 w-3.5" />
                                Results
                              </Button>
                              <Button size="sm" variant="outline" onClick={() => createBatch({ site })} disabled={busyAction === `run-site-${site.id}`}>
                                <Play className="h-3.5 w-3.5" />
                                Run
                              </Button>
                              <Button size="icon-sm" variant="ghost" onClick={() => openEditSite(site)} aria-label={`Edit ${site.url}`}>
                                <Edit3 className="h-3.5 w-3.5" />
                              </Button>
                              <ConfirmAction
                                title="Delete website?"
                                description="The website is removed from the dataset. Existing run records remain linked by run ID and batch history."
                                actionLabel="Delete website"
                                onConfirm={() => deleteSite(site.id)}
                                trigger={(
                                  <Button size="icon-sm" variant="ghost" disabled={busyAction === `delete-site-${site.id}`} aria-label={`Delete ${site.url}`}>
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
                      <TableCell colSpan={8} className="py-14 text-center text-sm text-muted-foreground">
                        No websites match the current filters.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Card>
          </TabsContent>

          <TabsContent value="batches" className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
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
                        key={batch.batch_id}
                        className={batch.batch_id === selectedBatchId ? "bg-muted/40" : undefined}
                        onClick={() => openBatch(batch.batch_id)}
                      >
                        <TableCell className="cursor-pointer">
                          <div className="font-mono text-xs">{compactRunId(batch.batch_id)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{batch.batch_name || "Untitled batch"}</div>
                          <div className="mt-1 text-[11px] text-muted-foreground">{formatDate(batch.created_at)}</div>
                        </TableCell>
                        <TableCell className="cursor-pointer">
                          <Badge tone={statusToneForDataset(batch.status)}>{datasetStatusLabel(batch.status)}</Badge>
                          <div className="mt-2 w-28"><BatchProgress batch={batch} /></div>
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={2} className="py-10 text-center text-sm text-muted-foreground">
                        No batches have been launched yet.
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
                    <Button variant="outline" size="sm" onClick={() => openBatch(selectedBatchId)} disabled={isBatchLoading}>
                      <RefreshCw className={`h-4 w-4 ${isBatchLoading ? "animate-spin" : ""}`} />
                      Refresh batch
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="space-y-4 p-4">
                {batchDetail ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                      <MetricTile icon={Activity} label="Status" value={datasetStatusLabel(batchDetail.status)} detail={batchDetail.batch_name || "Untitled batch"} />
                      <MetricTile icon={CheckCircle2} label="Completed" value={`${formatNumber(batchDetail.completed_count || 0)} / ${formatNumber(batchDetail.requested_count || 0)}`} detail={`${formatNumber(batchDetail.success_rate || 0)}% success`} />
                      <MetricTile icon={Database} label="Batch cost" value={formatCurrency(batchTotals.cost)} detail={`${formatNumber(batchRuns.length)} site runs`} />
                      <MetricTile icon={BarChart3} label="Tokens" value={formatNumber(batchTotals.tokens)} detail="Summed per site run" />
                      <MetricTile icon={Globe2} label="Streams" value={formatNumber(batchTotals.streams)} detail="Collected streams" />
                    </div>
                    <BatchProgress batch={batchDetail} />
                    <div className="overflow-hidden rounded-lg border">
                      <Table>
                        <TableHeader className="bg-muted/40">
                          <TableRow>
                            <TableHead>Website</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Agent/model</TableHead>
                            <TableHead className="text-right">Tokens</TableHead>
                            <TableHead className="text-right">Cost</TableHead>
                            <TableHead>Run</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {batchRuns.length ? (
                            batchRuns.map((row) => {
                              const status = datasetRunStatus(row);
                              const cost = effectiveRunCost(row, pricingMap);
                              const models = summarizeModelUsage(row.model_usage || EMPTY_ARRAY);
                              return (
                                <TableRow key={row.run_id}>
                                  <TableCell className="max-w-[320px] align-top">
                                    <div className="truncate text-sm font-medium" title={row.url}>{row.url}</div>
                                    <div className="mt-1 flex gap-1.5">
                                      <Badge>{row.language || "unlabeled"}</Badge>
                                      <Badge tone="signal">{row.label || "unlabeled"}</Badge>
                                    </div>
                                  </TableCell>
                                  <TableCell className="align-top">
                                    <Badge tone={statusToneForDataset(status)}>{datasetStatusLabel(status)}</Badge>
                                    {row.error_text ? <div className="mt-1 max-w-[220px] truncate text-xs text-destructive" title={row.error_text}>{row.error_text}</div> : null}
                                  </TableCell>
                                  <TableCell className="align-top text-xs text-muted-foreground">
                                    <div>{formatNumber(row.agent_runs?.length || 0)} agents</div>
                                    <div className="mt-1 max-w-[260px] truncate" title={models.join(", ")}>
                                      {models.join(", ") || "No model usage"}
                                    </div>
                                  </TableCell>
                                  <TableCell className="align-top text-right tabular-nums text-xs">
                                    {formatNumber(runTokenTotal(row))}
                                  </TableCell>
                                  <TableCell className="align-top text-right tabular-nums text-xs">
                                    {formatCurrency(cost.total)}
                                  </TableCell>
                                  <TableCell className="align-top">
                                    <Button asChild size="sm" variant="outline">
                                      <Link href={`/runs/${row.run_id}`}>
                                        {compactRunId(row.run_id)}
                                      </Link>
                                    </Button>
                                  </TableCell>
                                </TableRow>
                              );
                            })
                          ) : (
                            <TableRow>
                              <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                                This batch has no site runs.
                              </TableCell>
                            </TableRow>
                          )}
                        </TableBody>
                      </Table>
                    </div>
                  </>
                ) : isBatchLoading ? (
                  <div className="space-y-3 py-4">
                    <Skeleton className="h-20 rounded-xl" />
                    <Skeleton className="h-10 rounded-xl" />
                    <Skeleton className="h-48 rounded-xl" />
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
            <Card className="overflow-hidden">
              <CardHeader className="border-b px-4 py-3">
                <CardTitle className="text-base">Run history</CardTitle>
                <CardDescription>
                  The full persisted run table remains available for direct workflow and agent run debugging.
                </CardDescription>
              </CardHeader>
              <Table>
                <TableHeader className="bg-muted/40">
                  <TableRow>
                    <TableHead>Run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actor/model</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runHistory.length ? (
                    runHistory.map((row) => (
                      <TableRow key={row.run_id}>
                        <TableCell className="align-top">
                          <Link href={`/runs/${row.run_id}`} className="font-mono text-xs text-primary hover:underline">
                            {compactRunId(row.run_id)}
                          </Link>
                          <div className="mt-1 max-w-[360px] truncate text-xs text-muted-foreground" title={row.url}>
                            {row.url}
                          </div>
                        </TableCell>
                        <TableCell className="align-top">
                          <Badge tone={statusTone(row.final_status)}>{statusLabel(row.final_status)}</Badge>
                        </TableCell>
                        <TableCell className="align-top text-xs text-muted-foreground">
                          <div>{row.root_actor || "--"}</div>
                          <div className="mt-1">{[row.primary_provider, row.primary_model].filter(Boolean).join(" / ") || "--"}</div>
                        </TableCell>
                        <TableCell className="align-top text-right tabular-nums text-xs">
                          {formatNumber((row.total_tokens_in || 0) + (row.total_tokens_out || 0))}
                        </TableCell>
                        <TableCell className="align-top text-right tabular-nums text-xs">
                          {formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}
                        </TableCell>
                        <TableCell className="align-top">
                          <div className="flex flex-wrap gap-1.5">
                            <Button asChild size="sm" variant="outline">
                              <Link href={`/runs/${row.run_id}`}>
                                <Eye className="h-3.5 w-3.5" />
                                View
                              </Link>
                            </Button>
                            {canCancelRun(row) ? (
                              <Button size="sm" variant="outline" disabled={historyBusyRunId === row.run_id} onClick={() => cancelRun(row.run_id)}>
                                Stop
                              </Button>
                            ) : null}
                            {canDeleteRun(row) ? (
                              <ConfirmAction
                                title="Delete this run?"
                                description="Removes the run and its persisted telemetry. Batch rows keep their run ID but the run detail will no longer be available."
                                actionLabel="Delete run"
                                onConfirm={() => deleteRun(row.run_id)}
                                trigger={(
                                  <Button size="sm" variant="outline" disabled={historyBusyRunId === row.run_id}>
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
                        <TableCell colSpan={6}>
                          <Skeleton className="h-8 w-full" />
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow>
                      <TableCell colSpan={6} className="py-14 text-center text-sm text-muted-foreground">
                        No run history matched the current search.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
              <div className="border-t px-4 py-3 text-xs text-muted-foreground">
                Showing {formatNumber(runHistory.length)} of {formatNumber(runHistoryTotal)} runs.
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
          onRunSite={(site) => createBatch({ site })}
          onOpenBatch={openBatch}
        />
      </div>
    </TooltipProvider>
  );
}
