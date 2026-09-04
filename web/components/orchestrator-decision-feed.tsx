"use client";

import { useMemo, useState, memo } from "react";
import { Bot, CheckCircle2, ChevronDown, ChevronRight, GitBranch, Network, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { StructuredDataCard } from "@/components/structured-data-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { parseTimestamp } from "@/lib/datetime";

export interface TraceEvent {
  kind?: string;
  actor?: string;
  status?: string;
  message?: string;
  timestamp?: string;
  seq?: number;
  details?: Record<string, unknown>;
}

const ORCHESTRATOR_KINDS = new Set<string>([
  "pipeline_started",
  "pipeline_finished",
  "pipeline_failed",
  "agent_started",
  "agent_finished",
  "agent_failed",
  "route_decision",
  "orchestrator_decision",
  "routing",
  "handoff",
  "orchestrator_handoff_received",
  "context_compaction_started",
  "context_compaction_finished",
  "agent_loop_started",
  "agent_loop_finished",
  "agent_stop_requested",
  "embedded_handoff_missing",
]);

export function isOrchestratorEvent(event: TraceEvent | null | undefined): boolean {
  if (!event) return false;
  if (ORCHESTRATOR_KINDS.has(event.kind ?? "")) return true;
  if (event.actor === "orchestrator") return true;
  if (typeof event.kind === "string" && event.kind.includes("route")) return true;
  if (typeof event.kind === "string" && event.kind.includes("handoff")) return true;
  return false;
}

function decisionMeta(event: TraceEvent): { icon: typeof Network; color: string; label: string } {
  const kind = event.kind ?? "";
  if (kind === "pipeline_started") return { icon: Network, color: "var(--sky)", label: "Pipeline started" };
  if (kind === "pipeline_finished") return { icon: CheckCircle2, color: "var(--mint)", label: "Pipeline finished" };
  if (kind === "pipeline_failed") return { icon: XCircle, color: "var(--rose)", label: "Pipeline failed" };
  if (kind === "agent_started") return { icon: Bot, color: "var(--violet)", label: "Agent started" };
  if (kind === "agent_finished") return { icon: CheckCircle2, color: "var(--mint)", label: "Agent finished" };
  if (kind === "agent_failed") return { icon: XCircle, color: "var(--rose)", label: "Agent failed" };
  if (kind.includes("context_compaction")) return { icon: GitBranch, color: "var(--signal)", label: "Context continuation" };
  if (kind === "agent_stop_requested") return { icon: XCircle, color: "var(--signal)", label: "Agent stop requested" };
  if (kind === "agent_loop_started") return { icon: Bot, color: "var(--violet)", label: "Agent loop started" };
  if (kind === "agent_loop_finished") return { icon: CheckCircle2, color: "var(--mint)", label: "Agent loop finished" };
  if (kind.includes("route") || kind.includes("routing")) return { icon: GitBranch, color: "var(--signal)", label: "Routing decision" };
  if (kind.includes("handoff")) return { icon: GitBranch, color: "var(--signal)", label: "Handoff" };
  return { icon: Network, color: "var(--sky)", label: kind || "Event" };
}

function relTime(ts?: string): string | null {
  if (!ts) return null;
  try {
    const d = parseTimestamp(ts);
    return d ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;
  } catch {
    return null;
  }
}

function decisionIntent(event: TraceEvent): string {
  const details = (event?.details && typeof event.details === "object" ? event.details : {}) as Record<string, unknown>;
  return String(details.next_action ?? details.next_step ?? details.next_actor ?? details.next_agent ?? details.selected_agent ?? details.route_to ?? "");
}

function decisionReason(event: TraceEvent): string {
  const details = (event?.details && typeof event.details === "object" ? event.details : {}) as Record<string, unknown>;
  return String(details.reasoning ?? details.reason ?? details.summary ?? details.note ?? details.explanation ?? "");
}

const DecisionCard = memo(function DecisionCard({ event, isNew = false }: { event: TraceEvent; isNew?: boolean }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { icon: Icon, color, label } = decisionMeta(event);
  const hasDetails = Boolean(event.details && Object.keys(event.details).length > 0);
  const time = relTime(event.timestamp);
  const intent = decisionIntent(event);
  const reason = decisionReason(event);

  return (
    <div className={cn("group relative flex gap-3 rounded-lg border border-border/60 bg-card px-3.5 py-3 transition-[border-color,background-color,box-shadow] motion-reduce:transition-none", isNew && "animate-agent-arrive")} style={{ borderLeftWidth: 2, borderLeftColor: color }}>
      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ background: `color-mix(in oklch, ${color} 15%, transparent)`, color }}>
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] font-semibold text-foreground">{label}</span>
          {event.actor && event.actor !== "orchestrator" ? <Badge tone="default" className="px-1.5 py-0 text-[10px]">{event.actor}</Badge> : null}
          {event.status ? <Badge tone={event.status === "success" ? "mint" as const : event.status === "error" || event.status === "failed" ? "rose" as const : "default"} className="px-1.5 py-0 text-[10px]">{event.status}</Badge> : null}
          {time ? <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">{time}</span> : null}
        </div>

        {event.message ? <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{event.message}</p> : null}
        {intent ? <p className="mt-1 text-[11.5px] text-foreground/90"><span className="font-semibold">Next:</span> {intent}</p> : null}
        {reason ? <p className="mt-1 text-[11px] text-muted-foreground"><span className="font-semibold">Why:</span> {reason}</p> : null}

        {hasDetails ? (
          <div className="mt-2">
            <Button variant="ghost" size="sm" className="h-6 gap-1 px-1.5 text-[10.5px] text-muted-foreground" onClick={() => setExpanded((c) => !c)}>
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {expanded ? "Hide" : "Show"} details
            </Button>
            {expanded ? <div className="mt-2"><StructuredDataCard title="Decision payload" data={event.details} defaultMode="table" search compact /></div> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export interface OrchestratorDecisionFeedProps {
  events?: TraceEvent[];
  isStreaming?: boolean;
}

export const OrchestratorDecisionFeed = memo(function OrchestratorDecisionFeed({ events = [], isStreaming = false }: OrchestratorDecisionFeedProps): React.JSX.Element {
  const decisions = useMemo(() => events.filter(isOrchestratorEvent).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)), [events]);

  if (!decisions.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span className="flex h-10 w-10 items-center justify-center rounded-full border" style={{ borderColor: "var(--line)", color: "var(--mute)" }}>
          <GitBranch className="h-4 w-4" />
        </span>
        <div>
          <div className="text-sm font-medium text-foreground">No orchestrator decisions yet</div>
          <p className="mt-1 text-xs text-muted-foreground">Routing and handoff events will appear here as the pipeline runs.</p>
        </div>
        {isStreaming ? <span className="text-[11px] text-muted-foreground animate-pulse">Listening…</span> : null}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {decisions.map((event, idx) => (
        <DecisionCard key={`${event.seq ?? idx}-${event.kind}`} event={event} isNew={isStreaming && idx === decisions.length - 1} />
      ))}
    </div>
  );
});
