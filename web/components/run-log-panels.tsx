"use client";

import { useMemo, useState, memo } from "react";
import { FilterX } from "lucide-react";
import { filterDecisionEvents } from "@/lib/run-detail-filters";
import { OrchestratorDecisionFeed, type TraceEvent } from "@/components/orchestrator-decision-feed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export interface TracePanelProps {
  events?: TraceEvent[];
  isStreaming?: boolean;
  sharedFilters?: { actor?: string; stage?: string } | null;
  onSharedFiltersChange?: ((next: { actor: string; stage: string }) => void) | null;
  actorOptions?: string[];
  stageOptions?: Array<{ value: string; label: string }>;
}

export const TracePanel = memo(function TracePanel({
  events = [],
  isStreaming = false,
  sharedFilters = null,
  onSharedFiltersChange = null,
  actorOptions = [],
  stageOptions = [],
}: TracePanelProps): React.JSX.Element {
  const [searchTerm, setSearchTerm] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const filteredEvents = useMemo(
    () => filterDecisionEvents(events as never[], (sharedFilters ?? {}) as never, { search: searchTerm, source: sourceFilter } as never) as unknown as TraceEvent[],
    [events, searchTerm, sharedFilters, sourceFilter],
  );
  const hasFilters = Boolean(searchTerm || sourceFilter || sharedFilters?.actor || sharedFilters?.stage);

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="space-y-3 border-b px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-sm">Traces</CardTitle>
            <CardDescription>Runtime intent, handoffs, continuation events, and routing decisions from the live trace.</CardDescription>
          </div>
          <Badge tone={filteredEvents.length ? ("signal" as const) : ("default" as const)}>{filteredEvents.length} observed</Badge>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search traces, actors, tools, routes, or continuation capsules" className="h-8 min-w-[220px] flex-1 text-xs" />
          <Select value={sharedFilters?.actor ?? ""} onChange={(value) => onSharedFiltersChange?.({ actor: value, stage: sharedFilters?.stage ?? "" })} options={[{ value: "", label: "All actors" }, ...actorOptions.map((a) => ({ value: a, label: a }))]} placeholder="Actor" className="min-w-[160px]" />
          <Select value={sharedFilters?.stage ?? ""} onChange={(value) => onSharedFiltersChange?.({ actor: sharedFilters?.actor ?? "", stage: value })} options={[{ value: "", label: "All stages" }, ...stageOptions]} placeholder="Stage" className="min-w-[160px]" />
          <Select value={sourceFilter} onChange={(value) => setSourceFilter(value)} options={[{ value: "", label: "All trace sources" }, { value: "agent_auto", label: "Agent auto" }, { value: "manual", label: "Manual" }]} placeholder="Source" className="min-w-[160px]" />
          {hasFilters ? <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground" onClick={() => { setSearchTerm(""); setSourceFilter(""); onSharedFiltersChange?.({ actor: "", stage: "" }); }}><FilterX className="mr-1 h-3 w-3" />Reset</Button> : null}
        </div>
      </CardHeader>
      <CardContent className="p-4">
        <OrchestratorDecisionFeed events={filteredEvents} isStreaming={isStreaming} />
      </CardContent>
    </Card>
  );
});
