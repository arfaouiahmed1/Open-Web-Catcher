"use client";

import { useMemo, useState, memo } from "react";
import { Eye, FilterX } from "lucide-react";
import { filterRuntimeEvents } from "@/lib/run-detail-filters";
import { formatNumber } from "@/lib/utils";
import { normalizeTraceEvents } from "@/lib/run-trace";
import { StructuredDataCard } from "@/components/structured-data-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";
import { parseTimestamp } from "@/lib/datetime";

export interface TraceEvent {
  seq?: number;
  kind?: string;
  actor?: string;
  status?: string;
  message?: string;
  timestamp?: string;
  details?: Record<string, unknown>;
  details_json?: Record<string, unknown>;
}

function statusTone(status?: string, kind?: string): string {
  const s = String(status ?? "").trim().toLowerCase();
  const k = String(kind ?? "").trim().toLowerCase();
  if (s === "success" || k.endsWith("_finished") || k === "llm_response") return "success";
  if (s === "error" || s === "failed" || s === "fail" || k.endsWith("_failed") || k === "llm_error" || k === "llm_timeout") return "danger";
  if (s === "warning" || k === "cancel_requested" || k === "run_cancelled" || k === "llm_rate_limited") return "warning";
  if (k.endsWith("_started") || k === "llm_turn_started") return "signal";
  if (k.includes("llm")) return "violet";
  return "default";
}

function actorTone(actor?: string): string {
  const a = String(actor ?? "").toLowerCase();
  if (a.includes("orchestrat")) return "warning";
  if (a.includes("classif")) return "signal";
  if (a.includes("landing")) return "violet";
  if (a.includes("hosting")) return "success";
  if (a.includes("embedded")) return "default";
  return "default";
}

function fmtTimestamp(value?: string): string {
  if (!value) return "--";
  try {
    const date = parseTimestamp(value);
    if (!date) return String(value);
    return date.toLocaleString();
  } catch {
    return String(value);
  }
}

function fmtRelative(value?: string): string {
  if (!value) return "";
  const date = parseTimestamp(value);
  if (!date) return "";
  const ms = Date.now() - date.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function detailHasContent(details: unknown): boolean {
  if (!details || typeof details !== "object") return false;
  return Object.keys(details as object).length > 0;
}

const EventDetailDialog = memo(function EventDetailDialog({ event }: { event: TraceEvent }): React.JSX.Element {
  const details = (event?.details ?? event?.details_json ?? {}) as Record<string, unknown>;
  const tone = statusTone(event?.status, event?.kind);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground" title="View details">
          <Eye className="h-3 w-3" />
          Details
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl p-0">
        <div className="border-b border-border px-5 py-4">
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone as never}>{event?.kind ?? "event"}</Badge>
              {event?.actor ? <Badge tone={actorTone(event.actor) as never}>{event.actor}</Badge> : null}
              {event?.status ? <Badge tone={tone as never}>{event.status}</Badge> : null}
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">#{event?.seq ?? "--"}</span>
            </div>
            <DialogTitle className="mt-2 text-base font-medium">{event?.message ?? "(no message)"}</DialogTitle>
            <DialogDescription className="font-mono text-[11px]">
              {fmtTimestamp(event?.timestamp)}
              {event?.timestamp ? <span className="ml-2 text-muted-foreground/70">{fmtRelative(event.timestamp)}</span> : null}
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="px-5 py-4">
          <StructuredDataCard title="Details payload" data={details} emptyLabel="No structured details for this event." defaultMode="table" search />
        </div>
      </DialogContent>
    </Dialog>
  );
});

const EventRow = memo(function EventRow({ event, index }: { event: TraceEvent; index: number }): React.JSX.Element {
  const tone = statusTone(event?.status, event?.kind);
  const aTone = actorTone(event?.actor);
  const seq = event?.seq ?? index + 1;
  return (
    <div className="grid items-start gap-2 border-b border-border/60 px-4 py-2.5 transition-colors hover:bg-muted/30 md:grid-cols-[64px_minmax(180px,220px)_1fr_auto]">
      <div className="font-mono text-[10px] text-muted-foreground/75">#{seq}</div>
      <div className="flex flex-col gap-1">
        <Badge tone={tone as never} className="w-fit font-mono uppercase tracking-wide">
          {event?.kind ?? "event"}
        </Badge>
        {event?.actor ? <Badge tone={aTone as never} className="w-fit">{event.actor}</Badge> : <span className="text-[10px] text-muted-foreground/75">system</span>}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12px] text-foreground/90" title={event?.message ?? ""}>
          {event?.message ?? <span className="text-muted-foreground">(no message)</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground/70">
          <span>{fmtTimestamp(event?.timestamp)}</span>
          {event?.timestamp ? <><span className="text-muted-foreground/75">/</span><span>{fmtRelative(event.timestamp)}</span></> : null}
          {event?.status && event.status !== "info" ? <><span className="text-muted-foreground/75">/</span><span className="uppercase tracking-wide">{event.status}</span></> : null}
        </div>
      </div>
      <div className="flex justify-end">
        {detailHasContent(event?.details ?? event?.details_json) ? <EventDetailDialog event={event} /> : <span className="px-2 text-[10px] text-muted-foreground/75">--</span>}
      </div>
    </div>
  );
});

export interface RuntimeEventsPanelProps {
  events?: TraceEvent[];
  title?: string;
  description?: string;
  maxRows?: number;
  sharedFilters?: { actor?: string; stage?: string } | null;
  onSharedFiltersChange?: ((next: { actor: string; stage: string }) => void) | null;
  actorOptions?: string[];
  stageOptions?: Array<{ value: string; label: string }>;
  terminalStatus?: string;
}

export const RuntimeEventsPanel = memo(function RuntimeEventsPanel({
  events = [],
  title = "Runtime log",
  description = "Normalized runtime events and agent lifecycle logs.",
  maxRows = 200,
  sharedFilters = null,
  onSharedFiltersChange = null,
  actorOptions = [],
  stageOptions = [],
  terminalStatus = "",
}: RuntimeEventsPanelProps): React.JSX.Element {
  const normalized = useMemo(() => normalizeTraceEvents(events as never[]) as unknown as TraceEvent[], [events]);
  const [searchTerm, setSearchTerm] = useState("");
  const [kindFilter, setKindFilter] = useState("");

  const kinds = useMemo(() => {
    const set = new Set<string>();
    for (const event of normalized) if (event?.kind) set.add(event.kind as string);
    return Array.from(set).sort();
  }, [normalized]);

  const filtered = useMemo(() => filterRuntimeEvents(normalized as never[], (sharedFilters ?? {}) as never, { search: searchTerm, kind: kindFilter } as never) as unknown as TraceEvent[], [kindFilter, normalized, searchTerm, sharedFilters]);
  const display = useMemo(() => filtered.slice(-maxRows).reverse(), [filtered, maxRows]);
  const hasFilters = Boolean(searchTerm || kindFilter || sharedFilters?.actor || sharedFilters?.stage);

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="space-y-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm">{title}</CardTitle>
            <CardDescription className="mt-1 text-xs">{description}</CardDescription>
          </div>
          <Badge tone="default" className="font-mono">{formatNumber(filtered.length)} / {formatNumber(normalized.length)}</Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search runtime events" className="h-8 min-w-[220px] flex-1 text-xs" />
          <Select value={sharedFilters?.actor ?? ""} onChange={(value) => onSharedFiltersChange?.({ actor: value, stage: sharedFilters?.stage ?? "" })} options={[{ value: "", label: "All actors" }, ...actorOptions.map((actor) => ({ value: actor, label: actor }))]} placeholder="Actor" className="min-w-[160px]" />
          <Select value={sharedFilters?.stage ?? ""} onChange={(value) => onSharedFiltersChange?.({ actor: sharedFilters?.actor ?? "", stage: value })} options={[{ value: "", label: "All stages" }, ...stageOptions]} placeholder="Stage" className="min-w-[160px]" />
          <Select value={kindFilter} onChange={(value) => setKindFilter(value)} options={[{ value: "", label: "All kinds" }, ...kinds.map((k) => ({ value: k, label: k }))]} placeholder="Kind" className="min-w-[160px]" />
          {hasFilters ? <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={() => { setSearchTerm(""); setKindFilter(""); onSharedFiltersChange?.({ actor: "", stage: "" }); }}><FilterX className="mr-1 h-3 w-3" />Reset</Button> : null}
        </div>
        {terminalStatus ? <div className="text-[11px] text-muted-foreground">Terminal: {terminalStatus}</div> : null}
      </CardHeader>

      <CardContent className="p-0">
        {display.length ? (
          <ScrollArea className="max-h-[520px]">
            <div>
              {display.map((event, idx) => (
                <EventRow key={`${event.seq ?? idx}-${event.kind}`} event={event} index={idx} />
              ))}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex h-36 items-center justify-center text-sm text-muted-foreground/75">{normalized.length ? "No events match the current filters." : "Runtime events will appear here."}</div>
        )}
      </CardContent>
    </Card>
  );
});
