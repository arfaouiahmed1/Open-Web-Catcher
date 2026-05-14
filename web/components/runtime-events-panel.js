"use client";

import { useMemo, useState } from "react";
import { Eye, FilterX, Search } from "lucide-react";

import { filterRuntimeEvents } from "@/lib/run-detail-filters";
import { formatNumber } from "@/lib/utils";
import { normalizeTraceEvents } from "@/lib/run-trace";
import { StructuredDataCard } from "@/components/structured-data-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select } from "@/components/ui/select";

function statusTone(status, kind) {
  const s = String(status || "").trim().toLowerCase();
  const k = String(kind || "").trim().toLowerCase();
  if (s === "success" || k.endsWith("_finished") || k === "llm_response") return "success";
  if (s === "error" || s === "failed" || s === "fail" || k.endsWith("_failed") || k === "llm_error" || k === "llm_timeout") return "danger";
  if (s === "warning" || k === "cancel_requested" || k === "run_cancelled" || k === "llm_rate_limited") return "warning";
  if (k.endsWith("_started") || k === "llm_turn_started") return "signal";
  if (k.includes("llm")) return "violet";
  return "default";
}

function actorTone(actor) {
  const a = String(actor || "").toLowerCase();
  if (a.includes("orchestrat")) return "warning";
  if (a.includes("classif")) return "signal";
  if (a.includes("landing")) return "violet";
  if (a.includes("hosting")) return "success";
  if (a.includes("embedded")) return "default";
  return "default";
}

function fmtTimestamp(value) {
  if (!value) return "--";
  try {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  } catch {
    return String(value);
  }
}

function fmtRelative(value) {
  if (!value) return "";
  const date = new Date(value);
  const ms = Date.now() - date.getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function detailHasContent(details) {
  if (!details || typeof details !== "object") return false;
  return Object.keys(details).length > 0;
}

function EventDetailDialog({ event }) {
  const details = event?.details ?? event?.details_json ?? {};
  const tone = statusTone(event?.status, event?.kind);
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
          title="View details"
        >
          <Eye className="h-3 w-3" />
          Details
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-4xl p-0">
        <div className="border-b border-border px-5 py-4">
          <DialogHeader>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={tone} className="font-mono uppercase tracking-wide">
                {event?.kind || "event"}
              </Badge>
              {event?.actor ? <Badge tone={actorTone(event.actor)}>{event.actor}</Badge> : null}
              {event?.status ? <Badge tone={tone}>{event.status}</Badge> : null}
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">#{event?.seq ?? "--"}</span>
            </div>
            <DialogTitle className="mt-2 text-base font-medium">{event?.message || "(no message)"}</DialogTitle>
            <DialogDescription className="font-mono text-[11px]">
              {fmtTimestamp(event?.timestamp)}
              {event?.timestamp ? <span className="ml-2 text-muted-foreground/70">{fmtRelative(event.timestamp)}</span> : null}
            </DialogDescription>
          </DialogHeader>
        </div>
        <div className="px-5 py-4">
          <StructuredDataCard
            title="Details payload"
            data={details}
            emptyLabel="No structured details for this event."
            defaultMode="table"
            search
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EventRow({ event, index }) {
  const tone = statusTone(event?.status, event?.kind);
  const aTone = actorTone(event?.actor);
  const seq = event?.seq ?? index + 1;
  return (
    <div className="grid items-start gap-2 border-b border-border/60 px-4 py-2.5 transition-colors hover:bg-muted/30 md:grid-cols-[64px_minmax(180px,220px)_1fr_auto]">
      <div className="font-mono text-[10px] text-muted-foreground/60">#{seq}</div>
      <div className="flex flex-col gap-1">
        <Badge tone={tone} className="w-fit font-mono uppercase tracking-wide">
          {event?.kind || "event"}
        </Badge>
        {event?.actor ? (
          <Badge tone={aTone} className="w-fit">
            {event.actor}
          </Badge>
        ) : (
          <span className="text-[10px] text-muted-foreground/60">system</span>
        )}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[12px] text-foreground/90" title={event?.message || ""}>
          {event?.message || <span className="text-muted-foreground">(no message)</span>}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[10px] text-muted-foreground/70">
          <span>{fmtTimestamp(event?.timestamp)}</span>
          {event?.timestamp ? (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span>{fmtRelative(event.timestamp)}</span>
            </>
          ) : null}
          {event?.status && event.status !== "info" ? (
            <>
              <span className="text-muted-foreground/40">/</span>
              <span className="uppercase tracking-wide">{event.status}</span>
            </>
          ) : null}
        </div>
      </div>
      <div className="flex justify-end">
        {detailHasContent(event?.details ?? event?.details_json) ? (
          <EventDetailDialog event={event} />
        ) : (
          <span className="px-2 text-[10px] text-muted-foreground/40">--</span>
        )}
      </div>
    </div>
  );
}

export function RuntimeEventsPanel({
  events = [],
  title = "Runtime log",
  description = "Normalized runtime events and agent lifecycle logs.",
  maxRows = 200,
  sharedFilters = null,
  onSharedFiltersChange = null,
  actorOptions = [],
  stageOptions = [],
  terminalStatus = "",
}) {
  const normalized = useMemo(() => normalizeTraceEvents(events), [events]);
  const [searchTerm, setSearchTerm] = useState("");
  const [kindFilter, setKindFilter] = useState("");

  const kinds = useMemo(() => {
    const set = new Set();
    for (const event of normalized) if (event?.kind) set.add(event.kind);
    return Array.from(set).sort();
  }, [normalized]);

  const filtered = useMemo(
    () => filterRuntimeEvents(normalized, sharedFilters || {}, { search: searchTerm, kind: kindFilter }),
    [kindFilter, normalized, searchTerm, sharedFilters],
  );
  const display = useMemo(() => filtered.slice(-maxRows).reverse(), [filtered, maxRows]);
  const hasFilters = Boolean(searchTerm || kindFilter || sharedFilters?.actor || sharedFilters?.stage);

  function resetFilters() {
    setSearchTerm("");
    setKindFilter("");
    onSharedFiltersChange?.({ actor: "", stage: "" });
  }

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="space-y-3 border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-sm font-medium">{title}</CardTitle>
            <CardDescription className="text-xs">{description}</CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <Badge tone="default" className="font-mono">
              {formatNumber(filtered.length)}
              {filtered.length !== normalized.length ? ` / ${formatNumber(normalized.length)}` : ""} events
            </Badge>
            {terminalStatus === "cancelled" ? <Badge tone="warning">terminal: cancelled</Badge> : null}
            {terminalStatus === "failed" ? <Badge tone="danger">terminal: failed</Badge> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Filter by message, kind, actor, or details"
              className="h-8 pl-9 text-xs"
            />
          </div>
          <Select
            value={sharedFilters?.actor || ""}
            onChange={(value) => onSharedFiltersChange?.({ actor: value, stage: sharedFilters?.stage || "" })}
            options={[
              { value: "", label: "All actors" },
              ...actorOptions.map((actor) => ({ value: actor, label: actor })),
            ]}
            placeholder="Actor"
            className="min-w-[170px]"
          />
          <Select
            value={sharedFilters?.stage || ""}
            onChange={(value) => onSharedFiltersChange?.({ actor: sharedFilters?.actor || "", stage: value })}
            options={[
              { value: "", label: "All stages" },
              ...stageOptions,
            ]}
            placeholder="Stage"
            className="min-w-[170px]"
          />
          {kinds.length > 1 ? (
            <Select
              value={kindFilter}
              onChange={(value) => setKindFilter(value)}
              options={[
                { value: "", label: "All kinds" },
                ...kinds.map((kind) => ({ value: kind, label: kind })),
              ]}
              placeholder="Kind"
              className="min-w-[180px]"
            />
          ) : null}
          {hasFilters ? (
            <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={resetFilters}>
              <FilterX className="mr-1 h-3 w-3" />
              Reset
            </Button>
          ) : null}
        </div>
      </CardHeader>

      {!display.length ? (
        <CardContent className="px-4 py-10 text-center text-sm text-muted-foreground">
          {normalized.length
            ? "No events match the current filters."
            : terminalStatus === "cancelled"
              ? "This run was cancelled before any runtime events were persisted."
              : "No runtime events recorded yet. Live and persisted events stream here."}
        </CardContent>
      ) : (
        <ScrollArea className="h-[560px] max-h-[70vh] overflow-y-auto">
          <div>
            {display.map((event, index) => (
              <EventRow
                key={`${event.seq ?? "noseq"}-${event.timestamp ?? ""}-${event.kind ?? ""}-${index}`}
                event={event}
                index={index}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </Card>
  );
}
