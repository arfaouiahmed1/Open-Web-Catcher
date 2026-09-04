"use client";

import { useMemo, memo } from "react";
import dynamic from "next/dynamic";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { parseTimestamp } from "@/lib/datetime";

// Dynamic import for reactflow to avoid SSR issues — required per task
const ReactFlow = dynamic(() => import("reactflow").then((mod) => mod.default as unknown as React.ComponentType<Record<string, unknown>>), { ssr: false });
import { Background, Controls, MarkerType } from "reactflow";
import "reactflow/dist/style.css";

const ROOT_X_OFFSET = 60;
const ROOT_Y_OFFSET = 40;
const CHILD_GRID_X_START = 300;
const CHILD_GRID_Y_START = 200;
const NODE_SPACING_X = 290;
const NODE_SPACING_Y = 220;

export interface WorkflowEvent {
  actor?: string;
  kind?: string;
  status?: string;
  timestamp?: string;
  seq?: number;
}

function eventTime(event?: WorkflowEvent | null): string {
  if (!event?.timestamp) return "";
  const parsed = parseTimestamp(event.timestamp);
  if (!parsed) return "";
  return parsed.toLocaleTimeString();
}

function statusFromEvents(actorEvents: WorkflowEvent[]): string {
  if (!actorEvents.length) return "idle";
  if (actorEvents.some((e) => e.kind === "agent_failed")) return "failed";
  if (actorEvents.some((e) => e.kind === "agent_finished")) return "succeeded";
  if (actorEvents.some((e) => e.kind === "agent_started")) return "running";
  if (actorEvents.some((e) => e.kind === "tool_session_connecting")) return "connecting";
  return "idle";
}

function statusStyle(status: string): string {
  if (status === "running") return "border border-[color-mix(in_oklch,var(--signal)_40%,transparent)] bg-[color-mix(in_oklch,var(--signal)_10%,transparent)] animate-pulse";
  if (status === "succeeded") return "border border-[color-mix(in_oklch,var(--mint)_35%,transparent)] bg-[color-mix(in_oklch,var(--mint)_10%,transparent)]";
  if (status === "failed") return "border border-[color-mix(in_oklch,var(--rose)_35%,transparent)] bg-[color-mix(in_oklch,var(--rose)_10%,transparent)]";
  if (status === "connecting") return "border border-[color-mix(in_oklch,var(--sky)_35%,transparent)] bg-[color-mix(in_oklch,var(--sky)_10%,transparent)]";
  return "border border-border bg-muted/30";
}

function StatusIcon({ status }: { status: string }): React.JSX.Element | null {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--signal-text)]" />;
  if (status === "succeeded") return <CheckCircle2 className="h-3.5 w-3.5 text-[var(--mint-text)]" />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 text-[var(--rose-text)]" />;
  return null;
}

interface ActorNodeData {
  label: string;
  status: string;
  count: number;
  latest: string;
}

function ActorNode({ data }: { data: ActorNodeData }): React.JSX.Element {
  return (
    <div className={`min-w-[200px] rounded-2xl px-4 py-3 text-foreground ${statusStyle(data.status)}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <div className="text-sm font-semibold">{data.label}</div>
        <div className="ml-auto"><StatusIcon status={data.status} /></div>
      </div>
      <div className="text-xs text-muted-foreground">{data.count} event{data.count !== 1 ? "s" : ""}</div>
      <div className="mt-1 text-xs text-muted-foreground">{data.latest || "Waiting"}</div>
    </div>
  );
}

const nodeTypes: Record<string, React.ComponentType<{ data: ActorNodeData }>> = { actorNode: ActorNode };

function buildFlow(events: WorkflowEvent[], rootActor: string): { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> } {
  const actors = Array.from(new Set([rootActor, ...events.map((e) => e.actor).filter(Boolean) as string[]]));
  const byActor = new Map<string, WorkflowEvent[]>(actors.map((actor) => [actor, events.filter((e) => e.actor === actor)]));
  const nodes = actors.map((actor, index) => {
    const actorEvents = byActor.get(actor) ?? [];
    const latest = actorEvents[actorEvents.length - 1];
    const status = statusFromEvents(actorEvents);
    return {
      id: actor,
      type: "actorNode",
      position: {
        x: index === 0 ? ROOT_X_OFFSET : CHILD_GRID_X_START + ((index - 1) % 3) * NODE_SPACING_X,
        y: index === 0 ? ROOT_Y_OFFSET : CHILD_GRID_Y_START + Math.floor((index - 1) / 3) * NODE_SPACING_Y,
      },
      data: {
        label: actor,
        status,
        count: actorEvents.length,
        latest: latest ? `${latest.kind} / ${latest.status}${eventTime(latest) ? ` · ${eventTime(latest)}` : ""}` : "Waiting",
      },
    };
  });

  const rootEvents = byActor.get(rootActor) ?? [];
  const rootRunning = statusFromEvents(rootEvents) === "running";
  const latestRootEvent = rootEvents[rootEvents.length - 1];
  const latestTime = eventTime(latestRootEvent ?? null);

  const edges = actors.slice(1).map((actor) => ({
    id: `${rootActor}-${actor}`,
    source: rootActor,
    target: actor,
    animated: rootRunning,
    label: latestTime || "",
    labelStyle: { fill: "var(--mute-2)", fontSize: 10 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "var(--sky-text)" },
    style: { stroke: "var(--sky-text)", strokeWidth: 2 },
  }));

  return { nodes, edges };
}

export interface WorkflowCanvasProps {
  events?: WorkflowEvent[];
  rootActor?: string;
}

export const WorkflowCanvas = memo(function WorkflowCanvas({ events = [], rootActor = "orchestrator" }: WorkflowCanvasProps): React.JSX.Element {
  const flow = useMemo(() => buildFlow(events, rootActor), [events, rootActor]);

  return (
    <Card className="h-[420px] overflow-hidden p-0">
      <div className="h-full w-full">
        <ReactFlow nodes={flow.nodes as never} edges={flow.edges as never} nodeTypes={nodeTypes as never} fitView>
          <Background color="var(--line-hi)" gap={24} />
          <Controls />
        </ReactFlow>
      </div>
    </Card>
  );
});
