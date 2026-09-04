/**
 * Runs — Sites tab: unified website dataset workspace.
 *
 * Single home for website dataset management: health KPIs, filter/action
 * toolbar (search, language/label filters, health checks, bulk operations),
 * the dataset table, and bulk metadata editing. The site detail drawer lives
 * in runs-page.tsx and opens via onOpenDetail.
 */
"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  CheckCircle2,
  Edit3,
  Eye,
  Globe2,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";
import { EmptyState } from "@/components/console/common/empty-state";
import { LoadingView } from "@/components/console/common/loading-view";
import { SectionPanel } from "@/components/console/common/section-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ConfirmAction } from "@/components/console/common/confirm-action";
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
import { Textarea } from "@/components/ui/textarea";
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
import {
  datasetRunStatus,
  effectiveRunCost,
  runTokenTotal,
  statusToneForDataset,
} from "@/lib/dataset-runs";
import { statusLabel } from "@/lib/run-status";
import { formatCurrency, formatNumber } from "@/lib/utils";

export interface SiteHealth {
  working?: boolean;
  status?: string;
  tone?: string;
  http_status?: number;
  method?: string;
  latency_ms?: number;
  sample_size?: number;
  content_reason?: string;
  error?: string;
  checked_at?: string;
  delete_candidate?: boolean;
}

export interface SitesTabProps {
  sites: Array<Record<string, unknown>>;
  siteTotal: number;
  selectedSiteIds: number[];
  onSelectSiteIds: (ids: number[]) => void;
  query: string;
  onQueryChange: (q: string) => void;
  language: string;
  onLanguageChange: (value: string) => void;
  label: string;
  onLabelChange: (value: string) => void;
  languages: string[];
  labels: string[];
  onResetFilters: () => void;
  isLoading: boolean;
  actionError: string;
  busyAction: string;
  healthMap: Record<string, SiteHealth>;
  healthCheckedAt: string;
  healthCheckScope: string;
  onHealthCheckScopeChange: (value: string) => void;
  onCheckHealth: () => void;
  isHealthChecking: boolean;
  onHealthSelection: (value: string) => void;
  onOpenCreate: () => void;
  onOpenDetail: (site: Record<string, unknown>) => void;
  onOpenEdit: (site: Record<string, unknown>) => void;
  onRunBatch: (site: Record<string, unknown>) => void;
  onRunSelected: () => void;
  onRunFiltered: () => void;
  onDeleteSelected: () => void;
  onDeleteDown: () => void;
  onDeleteSite: (id: number) => void;
  onUpdateSite: (id: number, patch: Record<string, unknown>) => void;
  onBulkUpdate: (ids: number[], patch: Record<string, unknown>) => Promise<void>;
  onToggleAllVisible: (checked: boolean) => void;
  pricingMap: Map<string, unknown> | null;
}

export function siteHealthLabel(health: SiteHealth | null | undefined): string {
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

export function siteHealthDetail(health: SiteHealth | null | undefined): string {
  if (!health) return "Run a health check for this table row";
  const parts: string[] = [];
  if (health.http_status) parts.push(`HTTP ${health.http_status}`);
  if (health.method) parts.push(String(health.method));
  if (health.latency_ms) parts.push(`${formatNumber(health.latency_ms)}ms`);
  if (health.sample_size) parts.push(`${formatNumber(health.sample_size)} bytes checked`);
  if (health.content_reason) parts.push(String(health.content_reason));
  if (health.error) parts.push(String(health.error));
  return parts.join(" · ") || "No probe details";
}

export function isHealthDeleteCandidate(health: SiteHealth | null | undefined): boolean {
  if (!health) return false;
  const status = String(health.status || "").trim().toLowerCase();
  if (status === "blocked" || status === "blocked_access" || status === "anti_bot") return false;
  if (health.delete_candidate === false) return false;
  return !health.working;
}

export function SiteHealthBadge({ health }: { health: SiteHealth | null }) {
  const tone = healthTone(health);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>
          <Badge tone={tone} className="gap-1 text-[10px]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${tone === "success" ? "bg-[var(--mint)]" : tone === "muted" ? "bg-muted-foreground" : "bg-[var(--signal)]"}`}
            />
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

function healthTone(health: SiteHealth | null | undefined): "success" | "warning" | "danger" | "muted" {
  if (!health) return "muted";
  if (health.working) return "success";
  const status = String(health.status || "").trim().toLowerCase();
  if (status === "anti_bot" || status === "blocked" || status === "blocked_access" || status === "limited") {
    return "warning";
  }
  return "danger";
}

function siteRunStatusLabel(value: unknown): string {
  const status = String(value || "").trim().toLowerCase();
  if (!status) return "Queued";
  return statusLabel(status);
}

function formatRelativeTime(value: unknown): string {
  if (!value) return "never";
  const ts = new Date(String(value)).getTime();
  if (!Number.isFinite(ts)) return "--";
  const deltaSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (deltaSec < 5) return "just now";
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  return `${Math.floor(deltaSec / 3600)}h ago`;
}

function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.map((item) => String(item || "").trim()).filter(Boolean)));
}

function faviconHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function siteId(site: Record<string, unknown>): number {
  return Number(site.id || 0);
}

function healthForSite(
  site: Record<string, unknown>,
  healthMap: Record<string, SiteHealth>,
): SiteHealth | null {
  return healthMap[String(site.id ?? "")] || healthMap[String(site.url ?? "")] || null;
}

function SiteFavicon({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
  const host = faviconHostname(url);
  if (!host || failed) {
    return <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" />;
  }
  return (
    <img
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      onError={() => setFailed(true)}
      className="h-4 w-4 shrink-0 rounded-sm"
    />
  );
}


function BulkEditDialog({
  open,
  onOpenChange,
  count,
  languages,
  labels,
  isSaving,
  error,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  languages: string[];
  labels: string[];
  isSaving: boolean;
  error: string;
  onApply: (patch: Record<string, unknown>) => void;
}) {
  const [language, setLanguage] = useState("");
  const [label, setLabel] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    if (open) {
      setLanguage("");
      setLabel("");
      setNotes("");
    }
  }, [open ]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Bulk edit {count} website{count === 1 ? "" : "s"}</DialogTitle>
          <DialogDescription>
            Only fields you change are sent via bulk-update; blank fields keep their current values.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <Select
            label="Language"
            value={language}
            onChange={setLanguage}
            options={[
              { value: "", label: "No change" },
              ...uniqueValues(languages).map((value) => ({ value, label: titleCase(value) })),
            ]}
          />
          <Select
            label="Label"
            value={label}
            onChange={setLabel}
            options={[
              { value: "", label: "No change" },
              ...uniqueValues(labels).map((value) => ({ value, label: titleCase(value) })),
            ]}
          />
          <div className="space-y-2">
            <label htmlFor="sites-bulk-notes" className="text-sm font-semibold">Notes</label>
            <Textarea
              id="sites-bulk-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Leave blank to keep existing notes"
              rows={3}
            />
          </div>
          {error ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={isSaving}
            onClick={() => {
              const patch: Record<string, unknown> = {};
              if (language) patch.language = language;
              if (label) patch.label = label;
              if (notes.trim()) patch.notes = notes.trim();
              onApply(patch);
            }}
          >
            {isSaving ? "Applying…" : `Apply to ${count}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SitesTab({
  sites,
  siteTotal,
  selectedSiteIds,
  onSelectSiteIds,
  query,
  onQueryChange,
  language,
  onLanguageChange,
  label,
  onLabelChange,
  languages,
  labels,
  onResetFilters,
  isLoading,
  actionError,
  busyAction,
  healthMap,
  healthCheckedAt,
  healthCheckScope,
  onHealthCheckScopeChange,
  onCheckHealth,
  isHealthChecking,
  onHealthSelection,
  onOpenCreate,
  onOpenDetail,
  onOpenEdit,
  onRunBatch,
  onRunSelected,
  onRunFiltered,
  onDeleteSelected,
  onDeleteDown,
  onDeleteSite,
  onUpdateSite,
  onBulkUpdate,
  onToggleAllVisible,
  pricingMap,
}: SitesTabProps) {
  const selectedSet = useMemo(() => new Set(selectedSiteIds.map(Number)), [selectedSiteIds]);
  const selectedSites = useMemo(
    () => sites.filter((site) => selectedSet.has(siteId(site))),
    [selectedSet, sites],
  );
  const selectedUrlsCount = useMemo(
    () => selectedSites.filter((site) => String(site.url || "").trim()).length,
    [selectedSites],
  );

  // Debounced search: parent refetches on query change, so wait for a pause.
  const [draftQuery, setDraftQuery] = useState(query);
  useEffect(() => {
    setDraftQuery(query);
  }, [query]);
  useEffect(() => {
    if (draftQuery === query) return undefined;
    const timer = window.setTimeout(() => onQueryChange(draftQuery), 250);
    return () => window.clearTimeout(timer);
  }, [draftQuery, onQueryChange, query]);

  const healthRows = useMemo(
    () => sites.map((site) => healthForSite(site, healthMap)).filter(Boolean) as SiteHealth[],
    [healthMap, sites],
  );
  const workingCount = useMemo(() => healthRows.filter((health) => health.working).length, [healthRows]);
  const downCount = useMemo(
    () => healthRows.filter((health) => !health.working).length,
    [healthRows],
  );
  const uncheckedCount = Math.max(0, sites.length - healthRows.length);
  const deleteCandidateIds = useMemo(
    () =>
      sites
        .filter((site) => isHealthDeleteCandidate(healthForSite(site, healthMap)))
        .map(siteId)
        .filter(Boolean),
    [healthMap, sites],
  );

  const healthCheckTargets = useMemo(() => {
    if (healthCheckScope === "selected") return selectedSites;
    if (healthCheckScope === "unchecked") {
      return sites.filter((site) => !healthForSite(site, healthMap));
    }
    if (healthCheckScope === "not_working") {
      return sites.filter((site) => isHealthDeleteCandidate(healthForSite(site, healthMap)));
    }
    return sites;
  }, [healthCheckScope, healthMap, selectedSites, sites]);
  const healthCheckTargetCount = healthCheckTargets.length;

  const allVisibleSelected = sites.length > 0 && selectedSiteIds.length === sites.length;
  const toggle = (id: number, next: boolean) => {
    const nextSet = new Set(selectedSet);
    if (next) nextSet.add(id);
    else nextSet.delete(id);
    onSelectSiteIds(Array.from(nextSet));
  };

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkSaving, setBulkSaving] = useState(false);
  const [bulkError, setBulkError] = useState("");
  async function applyBulkUpdate(patch: Record<string, unknown>) {
    if (!Object.keys(patch).length) {
      setBulkError("Choose at least one field to update.");
      return;
    }
    setBulkSaving(true);
    setBulkError("");
    try {
      await onBulkUpdate(selectedSites.map(siteId).filter(Boolean), patch);
      setBulkOpen(false);
    } catch (error: unknown) {
      setBulkError(error instanceof Error ? error.message : "Failed to bulk-update websites");
    } finally {
      setBulkSaving(false);
    }
  }

  const languageFilterOptions = useMemo(
    () => [
      { value: "", label: "All languages" },
      ...uniqueValues(languages).map((value) => ({ value, label: titleCase(value) })),
    ],
    [languages],
  );
  const labelFilterOptions = useMemo(
    () => [
      { value: "", label: "All labels" },
      ...uniqueValues(labels).map((value) => ({ value, label: titleCase(value) })),
    ],
    [labels],
  );
  const languageEditOptions = useMemo(
    () => uniqueValues(languages).map((value) => ({ value, label: titleCase(value) })),
    [languages],
  );
  const labelEditOptions = useMemo(
    () => uniqueValues(labels).map((value) => ({ value, label: titleCase(value) })),
    [labels],
  );

  if (isLoading) return <LoadingView label="Loading websites…" variant="skeleton" rows={4} />;

  return (
    <TooltipProvider>
      <div className="space-y-4 animate-fade-up">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="Total Websites" value={formatNumber(siteTotal)} hint={`${formatNumber(sites.length)} shown by current filters`} />
          <MetricCard
            label="Working / Live"
            value={formatNumber(workingCount)}
            hint={`${formatNumber(healthRows.length)} checked in this view`}
          />
          <MetricCard
            label="Down / Dead"
            value={formatNumber(downCount)}
            hint={deleteCandidateIds.length ? `${formatNumber(deleteCandidateIds.length)} delete candidates` : "Blocked and anti-bot rows are kept"}
          />
          <MetricCard
            label="Last Health Check"
            value={healthCheckedAt ? formatRelativeTime(healthCheckedAt) : "never"}
            hint={healthCheckedAt ? new Date(String(healthCheckedAt)).toLocaleString() : "Run a health check for this table"}
          />
        </div>

        {actionError ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive animate-fade-in-soft">
            {actionError}
          </div>
        ) : null}

        <SectionPanel
          title="Website dataset"
          description="The CSV is used as the initial seed only; edits here are stored in the database."
          icon={<Globe2 className="h-3.5 w-3.5" />}
          actions={
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Select
                className="w-full sm:w-[210px]"
                value={healthCheckScope}
                onChange={onHealthCheckScopeChange}
                options={[
                  { value: "all", label: `Check all (${sites.length})`, description: "All filtered websites in this table" },
                  { value: "selected", label: `Check selected (${selectedSites.length})`, description: "Only manually selected websites" },
                  { value: "unchecked", label: `Check unchecked (${uncheckedCount})`, description: "Rows without a health result yet" },
                  { value: "not_working", label: `Recheck not working (${deleteCandidateIds.length})`, description: "Rows currently yellow" },
                ]}
                disabled={isHealthChecking}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={onCheckHealth}
                disabled={!healthCheckTargetCount || isHealthChecking}
              >
                {isHealthChecking ? (
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Activity className="h-3.5 w-3.5" />
                )}
                {isHealthChecking ? "Checking…" : `Check health (${healthCheckTargetCount})`}
              </Button>
              <Select
                className="w-full sm:w-[190px]"
                value="choose"
                onChange={onHealthSelection}
                options={[
                  { value: "choose", label: "Select websites", description: "Choose rows by health state" },
                  { value: "working", label: `Select all working (${workingCount})` },
                  { value: "not_working", label: `Select all down (${deleteCandidateIds.length})` },
                  { value: "checked", label: `Select checked (${healthRows.length})` },
                  { value: "unchecked", label: `Select unchecked (${uncheckedCount})` },
                  { value: "all", label: `Select all filtered (${sites.length})` },
                  { value: "clear", label: "Clear selection" },
                ]}
                disabled={!sites.length || isHealthChecking}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={onRunSelected}
                disabled={!selectedUrlsCount || busyAction === "run-selected"}
              >
                <Play className="h-3.5 w-3.5" />
                {busyAction === "run-selected" ? "Launching…" : `Run selected (${selectedUrlsCount})`}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setBulkError("");
                  setBulkOpen(true);
                }}
                disabled={!selectedSites.length || busyAction === "bulk-update-sites"}
              >
                <Pencil className="h-3.5 w-3.5" />
                Bulk edit ({selectedSites.length})
              </Button>
              <ConfirmAction
                title="Delete selected websites?"
                description="Selected websites are removed from the dataset. Existing run records remain linked by run ID and batch history."
                actionLabel={`Delete ${selectedSiteIds.length} selected`}
                onConfirm={onDeleteSelected}
                trigger={(
                  <Button variant="danger" size="sm" disabled={!selectedSiteIds.length || busyAction === "delete-selected-sites"}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete selected ({selectedSiteIds.length})
                  </Button>
                )}
              />
              <ConfirmAction
                title="Delete down websites?"
                description="Deletes checked dead/fake-success websites: down, seized, parked, empty, limited, asset-only, or HTTP-error rows. Blocked access and anti-bot rows are kept."
                actionLabel={`Delete ${deleteCandidateIds.length} down`}
                onConfirm={onDeleteDown}
                trigger={(
                  <Button variant="danger" size="sm" disabled={!deleteCandidateIds.length || busyAction === "delete-down-sites"}>
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete down ({deleteCandidateIds.length})
                  </Button>
                )}
              />
              <Button
                variant="accent"
                size="sm"
                onClick={onRunFiltered}
                disabled={!sites.length || busyAction === "run-filtered"}
              >
                <Play className="h-3.5 w-3.5" />
                {busyAction === "run-filtered" ? "Launching…" : "Run all filtered"}
              </Button>
            </div>
          }
        >
          <div className="flex flex-wrap items-center gap-3 border-b p-3" style={{ borderColor: "var(--line)" }}>
            <div className="relative min-w-[260px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={draftQuery}
                onChange={(event) => setDraftQuery(event.target.value)}
                placeholder="Search URL, language, label, or notes"
                className="pl-9"
              />
            </div>
            <Select className="w-[180px]" value={language} onChange={onLanguageChange} options={languageFilterOptions} />
            <Select className="w-[180px]" value={label} onChange={onLabelChange} options={labelFilterOptions} />
            <Button variant="ghost" size="sm" onClick={onResetFilters}>
              Reset
            </Button>
            <div className="text-xs text-muted-foreground">
              Health: {formatNumber(workingCount)} working / {formatNumber(healthRows.length)} checked
              {healthCheckedAt ? ` · ${formatRelativeTime(healthCheckedAt)}` : ""}
            </div>
          </div>

          <div className="max-h-[62vh] overflow-auto">
            <Table className="min-w-[1180px] table-fixed">
              <TableHeader className="bg-muted/40">
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={allVisibleSelected}
                      onCheckedChange={(checked) => onToggleAllVisible(checked === true)}
                      aria-label="Select all visible websites"
                    />
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
                {sites.length ? (
                  sites.map((site) => {
                    const id = siteId(site);
                    const url = String(site.url || "");
                    const latest = (site.latest_run || {}) as Record<string, unknown>;
                    const status = datasetRunStatus(latest);
                    const cost = effectiveRunCost(latest, pricingMap);
                    const health = healthForSite(site, healthMap);
                    return (
                      <TableRow key={String(site.id)} className="h-auto [&>td]:py-2">
                        <TableCell className="align-middle">
                          <Checkbox
                            checked={selectedSet.has(id)}
                            onCheckedChange={(checked) => toggle(id, checked === true)}
                            aria-label={`Select ${url}`}
                          />
                        </TableCell>
                        <TableCell className="align-middle">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <SiteFavicon url={url} />
                              <button
                                type="button"
                                onClick={() => onOpenDetail(site)}
                                className="min-w-0 truncate text-left text-sm font-medium text-primary hover:underline"
                                title={`${url} — open site detail`}
                              >
                                {url}
                              </button>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <span>#{id}</span>
                              <SiteHealthBadge health={health} />
                              {site.notes ? (
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="max-w-[200px] truncate">{String(site.notes)}</span>
                                  </TooltipTrigger>
                                  <TooltipContent side="right" className="max-w-xs text-xs">
                                    {String(site.notes)}
                                  </TooltipContent>
                                </Tooltip>
                              ) : null}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell className="align-middle">
                          <Select
                            value={String(site.language || "")}
                            onChange={(value) => onUpdateSite(id, { language: value })}
                            options={languageEditOptions}
                          />
                        </TableCell>
                        <TableCell className="align-middle">
                          <Select
                            value={String(site.label || "")}
                            onChange={(value) => onUpdateSite(id, { label: value })}
                            options={labelEditOptions}
                          />
                        </TableCell>
                        <TableCell className="align-top">
                          {latest.run_id ? (
                            <div>
                              <Badge tone={statusToneForDataset(status)}>{siteRunStatusLabel(status)}</Badge>
                              <div className="mt-1">
                                <a
                                  href={`/runs/${String(latest.run_id)}`}
                                  className="block max-w-[260px] break-all font-mono text-[11px] text-primary hover:underline"
                                  title={String(latest.run_id)}
                                >
                                  {String(latest.run_id)}
                                </a>
                              </div>
                              <div className="mt-0.5 text-xs text-muted-foreground">
                                {latest.created_at ? new Date(String(latest.created_at)).toLocaleString() : ""}
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
                            <Button size="sm" variant="outline" onClick={() => onOpenDetail(site)}>
                              <Eye className="h-3.5 w-3.5" />
                              Results
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => onRunBatch(site)}
                              disabled={busyAction === `run-site-${id}`}
                            >
                              <Play className="h-3.5 w-3.5" />
                              Run
                            </Button>
                            <Button size="icon-sm" variant="ghost" onClick={() => onOpenEdit(site)} aria-label={`Edit ${url}`}>
                              <Edit3 className="h-3.5 w-3.5" />
                            </Button>
                            <ConfirmAction
                              title="Delete website?"
                              description="The website is removed from the dataset. Existing run records remain linked by run ID and batch history."
                              actionLabel="Delete website"
                              onConfirm={() => onDeleteSite(id)}
                              trigger={(
                                <Button size="icon-sm" variant="ghost" disabled={busyAction === `delete-site-${id}`} aria-label={`Delete ${url}`}>
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
                      <EmptyState
                        tone="search"
                        title="No websites match the current filters"
                        description="Try clearing search, language, or label filters — or add a new website."
                      />
                      <div className="mt-3 flex items-center justify-center gap-2">
                        <Button variant="outline" size="sm" onClick={onResetFilters}>
                          Reset filters
                        </Button>
                        <Button variant="accent" size="sm" onClick={onOpenCreate}>
                          <Plus className="h-3 w-3" />
                          Add website
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </SectionPanel>

        {selectedSites.length ? (
          <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-[var(--mint)]" />
            {formatNumber(selectedSites.length)} website{selectedSites.length === 1 ? "" : "s"} selected
            <Button variant="ghost" size="sm" className="ml-auto h-7 text-xs" onClick={() => onSelectSiteIds([])}>
              Clear selection
            </Button>
          </div>
        ) : null}

        <BulkEditDialog
          open={bulkOpen}
          onOpenChange={setBulkOpen}
          count={selectedSites.length}
          languages={languages}
          labels={labels}
          isSaving={bulkSaving || busyAction === "bulk-update-sites"}
          error={bulkError}
          onApply={applyBulkUpdate}
        />
      </div>
    </TooltipProvider>
  );
}
