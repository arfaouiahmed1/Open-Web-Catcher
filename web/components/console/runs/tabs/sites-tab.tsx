/**
 * Runs — Sites tab (polished)
 * Commercial polish: SectionPanel, EmptyState dark/light, SSE note, badge polish, spacing tokens.
 */
"use client";

import { Globe2, Search, Plus, Trash2 } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";
import { EmptyState } from "@/components/console/common/empty-state";
import { LoadingView } from "@/components/console/common/loading-view";
import { SectionPanel } from "@/components/console/common/section-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";

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
    <div className="flex items-center gap-3 border-b px-3 py-2.5 last:border-0 hover:bg-muted/20 transition-colors" style={{ borderColor: "var(--line)" }}>
      <Checkbox checked={selected} onCheckedChange={(v) => onToggle(id, Boolean(v))} aria-label={`Select ${url}`} />
      <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" />
      <button onClick={() => onDetail(site)} className="min-w-0 flex-1 truncate text-left text-sm font-medium text-primary hover:underline" title={url}>
        {url}
      </button>
      <Badge tone="muted" className="shrink-0 text-[10px]">{String(site.language || "unlabeled")}</Badge>
      <Button variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" onClick={() => onRun(site)}>Run</Button>
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

  if (isLoading) return <LoadingView label="Loading websites…" variant="skeleton" rows={4} />;
  return (
    <div className="space-y-4 animate-fade-up">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Websites" value={String(siteTotal)} hint={`Filtered ${sites.length} shown · lang=${language || "all"} label=${label || "all"}`} />
        <MetricCard label="Selected" value={String(selectedSiteIds.length)} hint={`${selectedSet.size} of ${sites.length} checked`} />
        <MetricCard label="Query" value={query ? `"${query}"` : "—"} hint={query ? "Active text filter" : "No filter"} />
      </div>

      {actionError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive animate-fade-in-soft">{actionError}</div>
      ) : null}

      <SectionPanel
        title="Websites"
        description="Dataset sites · SSE-observed, VirtualizedList when >50"
        icon={<Globe2 className="h-3.5 w-3.5" />}
        actions={
          <div className="flex gap-1.5">
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={selectAll} disabled={!sites.length}>Select all</Button>
            <Button variant="ghost" size="sm" className="h-7 px-2.5 text-xs" onClick={clearAll} disabled={!selectedSiteIds.length}><Trash2 className="h-3 w-3" />Clear</Button>
            <Button variant="accent" size="sm" className="h-7 px-3 text-xs" onClick={onOpenCreate}><Plus className="h-3 w-3" />Add website</Button>
          </div>
        }
      >
        <div className="flex gap-2 border-b p-3" style={{ borderColor: "var(--line)" }}>
          <div className="relative max-w-sm flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search url / notes…" value={query} onChange={(e) => onQueryChange(e.target.value)} className="h-8 pl-8" />
          </div>
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
          <EmptyState tone="search" title="No websites match" description="Try clearing the text filter or add a new website. Websites are paged server-side with SSE updates." />
        )}
      </SectionPanel>
    </div>
  );
}
