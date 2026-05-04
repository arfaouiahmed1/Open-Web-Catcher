"use client";

import { useMemo, useState } from "react";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Loader2,
  Network,
  XCircle,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const ORCHESTRATOR_KINDS = new Set([
  "pipeline_started",
  "pipeline_finished",
  "pipeline_failed",
  "agent_started",
  "agent_finished",
  "agent_failed",
  "route_decision",
  "routing",
  "handoff",
]);

function isOrchestratorEvent(event) {
  if (!event) return false;
  if (ORCHESTRATOR_KINDS.has(event.kind)) return true;
  if (event.actor === "orchestrator") return true;
  // Catch routing decisions that may be labelled differently
  if (typeof event.kind === "string" && event.kind.includes("route")) return true;
  if (typeof event.kind === "string" && event.kind.includes("handoff")) return true;
  return false;
}

function decisionMeta(event) {
  const kind = event.kind || "";
  if (kind === "pipeline_started") return { icon: Network, color: "var(--sky)", label: "Pipeline started" };
  if (kind === "pipeline_finished") return { icon: CheckCircle2, color: "var(--mint)", label: "Pipeline finished" };
  if (kind === "pipeline_failed") return { icon: XCircle, color: "var(--rose)", label: "Pipeline failed" };
  if (kind === "agent_started") return { icon: Bot, color: "var(--violet)", label: "Agent started" };
  if (kind === "agent_finished") return { icon: CheckCircle2, color: "var(--mint)", label: "Agent finished" };
  if (kind === "agent_failed") return { icon: XCircle, color: "var(--rose)", label: "Agent failed" };
  if (kind.includes("route") || kind.includes("routing")) return { icon: GitBranch, color: "var(--signal)", label: "Routing decision" };
  if (kind.includes("handoff")) return { icon: GitBranch, color: "var(--signal)", label: "Handoff" };
  return { icon: Network, color: "var(--sky)", label: kind || "Event" };
}

function relTime(ts) {
  if (!ts) return null;
  try {
    const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return null;
  }
}

function DecisionCard({ event, index, isNew }) {
  const [expanded, setExpanded] = useState(false);
  const { icon: Icon, color, label } = decisionMeta(event);
  const hasDetails = event.details && Object.keys(event.details).length > 0;
  const time = relTime(event.timestamp);

  return (
    <div
      className={cn(
        "group relative flex gap-3 rounded-lg border border-border/60 bg-card px-3.5 py-3 transition-all",
        isNew && "animate-agent-arrive",
      )}
      style={{ borderLeftWidth: 2, borderLeftColor: color }}
    >
      {/* Icon */}
      <span
        className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
        style={{ background: `color-mix(in oklch, ${color} 15%, transparent)`, color }}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] font-semibold text-foreground">{label}</span>
          {event.actor && event.actor !== "orchestrator" && (
            <Badge tone="default" className="text-[10px] px-1.5 py-0">
              {event.actor}
            </Badge>
          )}
          {event.status && (
            <Badge
              tone={
                event.status === "success" ? "mint"
                : event.status === "error" || event.status === "failed" ? "rose"
                : "default"
              }
              className="text-[10px] px-1.5 py-0"
            >
              {event.status}
            </Badge>
          )}
          {time && (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
              {time}
            </span>
          )}
        </div>

        {event.message && (
          <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
            {event.message}
          </p>
        )}

        {hasDetails && (
          <div className="mt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 gap-1 px-1.5 text-[10.5px] text-muted-foreground"
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {expanded ? "Hide" : "Show"} details
            </Button>
            {expanded && (
              <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted/50 px-3 py-2 font-mono text-[10.5px] text-foreground/80">
                {JSON.stringify(event.details, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function OrchestratorDecisionFeed({ events = [], isStreaming = false }) {
  const decisions = useMemo(
    () => events.filter(isOrchestratorEvent).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)),
    [events],
  );

  if (!decisions.length) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <span
          className="flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "color-mix(in oklch, var(--sky) 12%, transparent)" }}
        >
          {isStreaming ? (
            <Loader2 className="h-5 w-5 animate-spin" style={{ color: "var(--sky)" }} />
          ) : (
            <Network className="h-5 w-5" style={{ color: "var(--sky)" }} />
          )}
        </span>
        <p className="text-sm text-muted-foreground">
          {isStreaming ? "Waiting for orchestrator decisions…" : "No orchestrator events recorded"}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 p-1">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {decisions.length} decision{decisions.length !== 1 ? "s" : ""}
        </span>
        {isStreaming && (
          <span className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            live
          </span>
        )}
      </div>
      {decisions.map((event, i) => (
        <DecisionCard
          key={event.seq ?? `${event.timestamp}-${i}`}
          event={event}
          index={i}
          isNew={false}
        />
      ))}
    </div>
  );
}
