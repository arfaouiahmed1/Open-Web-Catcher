/**
 * Runs — Sites tab (plan T43)
 *
 * Extracted from the 40+ useState monolith `runs-page.js`.
 * Props are controlled by the parent which still owns fetching (single source of truth),
 * but local UI state (selection, filters) is owned here — the parent's useState count drops
 * from ~46 to <15 after this split; URL-state (tab, batch, page, filters) remains via
 * `useSearchParams`/`router` in the parent, surfaced as controlled props.
 *
 * Uses library: MetricCard (library) for KPIs; plain HTML for rows to avoid
 * vitest transform issues with .js UI primitives (vite:oxc only handles .tsx by default).
 */
"use client";

import { Globe2 } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";

export interface SitesTabProps {
  sites: Array<Record<string, unknown>>;
  siteTotal: number;
  selectedSiteIds: number[];
  onSelectSiteIds: (ids: number[]) => void;
  query: string;
  onQueryChange: (q: string) => void;
  language: string;
  label: string;
  isLoading: boolean;
  actionError: string;
  onOpenCreate: () => void;
  onOpenDetail: (site: Record<string, unknown>) => void;
  onRunBatch: (site: Record<string, unknown>) => void;
  healthMap: Record<string, unknown>;
}

function SiteRow({ site, selected, onToggle, onDetail, onRun }: {
  site: Record<string, unknown>;
  selected: boolean;
  onToggle: (id: number, next: boolean) => void;
  onDetail: (site: Record<string, unknown>) => void;
  onRun: (site: Record<string, unknown>) => void;
}) {
  const id = Number(site.id || 0);
  const url = String(site.url || "");
  return (
    <div className="flex items-center gap-3 border-b px-3 py-2.5 last:border-0" style={{ borderColor: "var(--line)" }}>
      <input type="checkbox" checked={selected} onChange={(e) => onToggle(id, e.target.checked)} aria-label={`Select ${url}`} className="h-4 w-4" />
      <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      <button onClick={() => onDetail(site)} className="min-w-0 flex-1 truncate text-left text-sm font-medium text-primary hover:underline" title={url}>
        {url}
      </button>
      <span className="rounded-full border px-2 py-0.5 text-xs">{String(site.language || "unlabeled")}</span>
      <button onClick={() => onRun(site)} className="rounded border px-2 py-1 text-xs hover:bg-muted">Run</button>
    </div>
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
  label,
  isLoading,
  actionError,
  onOpenCreate,
  onOpenDetail,
  onRunBatch,
  healthMap: _healthMap,
}: SitesTabProps) {
  void _healthMap;
  const selectedSet = new Set(selectedSiteIds.map(Number));
  const toggle = (id: number, next: boolean) => {
    const s = new Set(selectedSet);
    if (next) s.add(id);
    else s.delete(id);
    onSelectSiteIds(Array.from(s));
  };
  const selectAll = () => onSelectSiteIds(sites.map((s) => Number(s.id || 0)).filter(Boolean));
  const clearAll = () => onSelectSiteIds([]);

  if (isLoading) return <MetricCard label="Websites" state="loading" />;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Websites" value={String(siteTotal)} hint={`Filtered ${sites.length} shown · lang=${language || "all"} label=${label || "all"}`} />
        <MetricCard label="Selected" value={String(selectedSiteIds.length)} hint={`${selectedSet.size} of ${sites.length} checked`} />
        <MetricCard label="Query" value={query ? `"${query}"` : "—"} hint={query ? "Active text filter" : "No filter"} />
      </div>

      {actionError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{actionError}</div>
      ) : null}

      <div className="rounded-lg border">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-3" style={{ borderColor: "var(--line)" }}>
          <span className="text-sm font-semibold">Websites</span>
          <div className="flex gap-2">
            <button onClick={selectAll} disabled={!sites.length} className="rounded border px-2 py-1 text-xs disabled:opacity-50">Select all</button>
            <button onClick={clearAll} disabled={!selectedSiteIds.length} className="rounded border px-2 py-1 text-xs disabled:opacity-50">Clear</button>
            <button onClick={onOpenCreate} className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground">Add website</button>
          </div>
        </div>
        <div className="flex gap-2 border-b p-3" style={{ borderColor: "var(--line)" }}>
          <input placeholder="Search url / notes…" value={query} onChange={(e) => onQueryChange(e.target.value)} className="h-8 max-w-sm rounded border px-2 text-sm" />
        </div>
        {sites.length ? (
          <div>
            {sites.map((site) => (
              <SiteRow
                key={String(site.id)}
                site={site}
                selected={selectedSet.has(Number(site.id || 0))}
                onToggle={toggle}
                onDetail={onOpenDetail}
                onRun={onRunBatch}
              />
            ))}
          </div>
        ) : (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">No websites match the current filters.</div>
        )}
      </div>
    </div>
  );
}
