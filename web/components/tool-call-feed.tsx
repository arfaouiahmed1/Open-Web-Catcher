"use client";

import { useMemo, useState, memo } from "react";
import { Camera, ChevronDown, ExternalLink, FilterX, Wrench } from "lucide-react";
import { filterToolCalls } from "@/lib/run-detail-filters";
import { STAGE_LABELS } from "@/lib/run-trace";
import { formatNumber } from "@/lib/utils";
import { StructuredDataCard } from "@/components/structured-data-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export interface ToolCall {
  key: string;
  toolName: string;
  actor?: string;
  stage?: string;
  status?: string;
  target?: string;
  startSeq?: number;
  durationSeconds?: number;
  screenshots?: string[];
  args?: Record<string, unknown>;
  result?: unknown;
}

function toneForStatus(status?: string): { badge: string; text: string; border: string; bg: string } {
  const normalized = String(status ?? "").toLowerCase();
  if (normalized === "error" || normalized === "failed") {
    return { badge: "danger", text: "var(--rose)", border: "color-mix(in oklch, var(--rose) 24%, transparent)", bg: "color-mix(in oklch, var(--rose) 8%, transparent)" };
  }
  if (normalized === "running") {
    return { badge: "signal", text: "var(--signal)", border: "color-mix(in oklch, var(--signal) 24%, transparent)", bg: "color-mix(in oklch, var(--signal) 9%, transparent)" };
  }
  if (normalized === "cancelled") {
    return { badge: "warning", text: "var(--signal)", border: "color-mix(in oklch, var(--signal) 24%, transparent)", bg: "color-mix(in oklch, var(--signal) 8%, transparent)" };
  }
  return { badge: "success", text: "var(--mint)", border: "color-mix(in oklch, var(--mint) 24%, transparent)", bg: "color-mix(in oklch, var(--mint) 8%, transparent)" };
}

const SummaryStrip = memo(function SummaryStrip({ total, filtered, actors = [], stages = [] }: { total: number; filtered: number; actors?: string[]; stages?: string[] }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge tone="default" className="font-mono">
        {formatNumber(filtered)}
        {filtered !== total ? ` / ${formatNumber(total)}` : ""} calls
      </Badge>
      {actors.length ? <Badge tone="default">{formatNumber(actors.length)} actors</Badge> : null}
      {stages.length ? <Badge tone="default">{formatNumber(stages.length)} stages</Badge> : null}
    </div>
  );
});

const ToolCallRow = memo(function ToolCallRow({ call }: { call: ToolCall }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [activeScreenshot, setActiveScreenshot] = useState(call.screenshots?.[0] ?? "");
  const tone = toneForStatus(call.status);
  const stageLabel = (STAGE_LABELS as Record<string, string>)[call.stage ?? ""] ?? call.actor ?? "Agent";
  const hasDetails = Boolean((call.args && Object.keys(call.args).length) || call.result || (call.screenshots ?? []).length);

  return (
    <Card className="overflow-hidden shadow-card" style={{ borderColor: tone.border, background: tone.bg }}>
      <button type="button" onClick={() => hasDetails && setExpanded((c) => !c)} className="flex w-full items-start gap-3 px-3 py-3 text-left" disabled={!hasDetails}>
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background/70" style={{ color: tone.text }}>
          <Wrench className="h-4 w-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: tone.text }}>
              {stageLabel}
            </span>
            {call.actor ? <Badge tone="default" className="font-mono">{call.actor}</Badge> : null}
            <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-foreground/80">{call.toolName}</span>
            {call.startSeq ? <span className="font-mono text-[10px] text-muted-foreground/60">#{call.startSeq}</span> : null}
            <Badge tone={tone.badge as never} className="ml-auto uppercase">
              {String(call.status ?? "success")}
            </Badge>
          </div>

          {call.target ? <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={call.target}>{call.target}</div> : null}

          <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10px] text-muted-foreground/70">
            {call.durationSeconds ? <span>{Number(call.durationSeconds).toFixed(2)}s</span> : null}
            {(call.screenshots ?? []).length ? <span>{formatNumber(call.screenshots!.length)} shot{call.screenshots!.length === 1 ? "" : "s"}</span> : null}
          </div>
        </div>

        {hasDetails ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 transition-transform" style={{ color: "var(--muted-foreground)", transform: expanded ? "rotate(180deg)" : "rotate(0deg)" }} /> : null}
      </button>

      {expanded ? (
        <div className="space-y-3 border-t border-border px-3 pb-3 pt-3">
          {activeScreenshot ? (
            <div className="overflow-hidden rounded-lg border border-border bg-muted/20">
              <img src={activeScreenshot} alt={`${call.toolName} screenshot`} className="max-h-64 w-full object-cover" />
              <div className="flex items-center gap-2 border-t border-border px-2.5 py-1.5">
                <span className="truncate font-mono text-[10px] text-muted-foreground">{activeScreenshot}</span>
                <a href={activeScreenshot} target="_blank" rel="noreferrer" className="ml-auto shrink-0 text-muted-foreground">
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          ) : null}

          {(call.screenshots ?? []).length > 1 ? (
            <div className="flex gap-2 overflow-x-auto">
              {call.screenshots!.map((url, index) => (
                <button
                  key={`${url}-${index}`}
                  type="button"
                  onClick={() => setActiveScreenshot((c) => (c === url ? "" : url))}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-1 text-[10px] font-medium"
                  style={{ background: activeScreenshot === url ? "color-mix(in oklch, var(--signal) 16%, transparent)" : "var(--background)", color: activeScreenshot === url ? "var(--signal)" : "var(--muted-foreground)" }}
                >
                  <Camera className="h-3 w-3" />
                  {index + 1}
                </button>
              ))}
            </div>
          ) : null}

          {call.args && Object.keys(call.args).length ? <StructuredDataCard title="Inputs" data={call.args} defaultMode="table" search compact /> : null}
          {call.result ? <StructuredDataCard title="Result" data={call.result} defaultMode="table" search compact /> : null}
        </div>
      ) : null}
    </Card>
  );
});

export interface ToolCallFeedProps {
  toolCalls?: ToolCall[];
  title?: string;
  emptyLabel?: string;
  maxHeight?: number;
  sharedFilters?: { actor?: string; stage?: string } | null;
  onSharedFiltersChange?: ((next: { actor: string; stage: string }) => void) | null;
  actorOptions?: string[];
  stageOptions?: Array<{ value: string; label: string }>;
}

export const ToolCallFeed = memo(function ToolCallFeed({
  toolCalls = [],
  title = "Tool Calls",
  emptyLabel = "Tool calls will appear here.",
  maxHeight = 540,
  sharedFilters = null,
  onSharedFiltersChange = null,
  actorOptions = [],
  stageOptions = [],
}: ToolCallFeedProps): React.JSX.Element {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const filtered = useMemo(() => filterToolCalls(toolCalls as never[], (sharedFilters ?? {}) as never, { search, status: statusFilter } as never) as unknown as ToolCall[], [search, sharedFilters, statusFilter, toolCalls]);
  const statuses = useMemo(() => Array.from(new Set(toolCalls.map((call) => String(call.status ?? "").toLowerCase()).filter(Boolean))).sort(), [toolCalls]);
  const filteredActors = useMemo(() => Array.from(new Set(filtered.map((call) => String(call.actor ?? "").trim()).filter(Boolean))), [filtered]);
  const filteredStages = useMemo(() => Array.from(new Set(filtered.map((call) => String(call.stage ?? "").trim()).filter(Boolean))), [filtered]);

  const hasAnyFilters = Boolean(search || statusFilter || sharedFilters?.actor || sharedFilters?.stage);

  function resetFilters(): void {
    setSearch("");
    setStatusFilter("");
    onSharedFiltersChange?.({ actor: "", stage: "" });
  }

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="space-y-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Wrench className="h-4 w-4 text-primary" />
              <CardTitle className="text-[12px] font-semibold uppercase tracking-[0.12em] text-primary">{title}</CardTitle>
            </div>
            <CardDescription className="mt-1 text-xs">Track tool activity by actor, stage, status, target, and payload content.</CardDescription>
          </div>
          <SummaryStrip total={toolCalls.length} filtered={filtered.length} actors={filteredActors} stages={filteredStages} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tool, target, payload, or actor" className="h-8 min-w-[220px] flex-1 text-xs" />
          <Select value={sharedFilters?.actor ?? ""} onChange={(value) => onSharedFiltersChange?.({ actor: value, stage: sharedFilters?.stage ?? "" })} options={[{ value: "", label: "All actors" }, ...actorOptions.map((actor) => ({ value: actor, label: actor }))]} placeholder="Actor" className="min-w-[170px]" />
          <Select value={sharedFilters?.stage ?? ""} onChange={(value) => onSharedFiltersChange?.({ actor: sharedFilters?.actor ?? "", stage: value })} options={[{ value: "", label: "All stages" }, ...stageOptions]} placeholder="Stage" className="min-w-[170px]" />
          {statuses.length > 1 ? <Select value={statusFilter} onChange={(value) => setStatusFilter(value)} options={[{ value: "", label: "All statuses" }, ...statuses.map((s) => ({ value: s, label: s }))]} placeholder="Status" className="min-w-[160px]" /> : null}
          {hasAnyFilters ? <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={resetFilters}><FilterX className="mr-1 h-3 w-3" />Reset</Button> : null}
        </div>
      </CardHeader>

      <CardContent className="space-y-2 overflow-y-auto p-3" style={{ maxHeight }}>
        {filtered.length ? filtered.map((call) => <ToolCallRow key={call.key} call={call} />) : <div className="flex h-36 items-center justify-center text-sm text-muted-foreground/60">{toolCalls.length ? "No tool calls match the current filters." : emptyLabel}</div>}
      </CardContent>
    </Card>
  );
});
