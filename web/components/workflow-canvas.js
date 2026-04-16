"use client";

import { useMemo } from "react";
import ReactFlow, { Background, Controls, MarkerType } from "reactflow";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import "reactflow/dist/style.css";

import { Card } from "@/components/ui/card";

function eventTime(event) {
  if (!event?.timestamp) return "";
  const parsed = new Date(event.timestamp);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString();
}

function statusFromEvents(actorEvents) {
  if (!actorEvents.length) return "idle";
  if (actorEvents.some((event) => event.kind === "agent_failed")) return "failed";
  if (actorEvents.some((event) => event.kind === "agent_finished")) return "succeeded";
  if (actorEvents.some((event) => event.kind === "agent_started")) return "running";
  if (actorEvents.some((event) => event.kind === "tool_session_connecting")) return "connecting";
  return "idle";
}

function statusStyle(status) {
  if (status === "running") return "border border-signal/40 bg-signal/10 animate-pulse";
  if (status === "succeeded") return "border border-emerald-500/35 bg-emerald-500/10";
  if (status === "failed") return "border border-ember/35 bg-ember/10";
  if (status === "connecting") return "border border-sky-400/35 bg-sky-400/10";
  return "border border-white/12 bg-white/[0.04]";
}

function StatusIcon({ status }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 animate-spin text-signal" />;
  if (status === "succeeded") return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 text-ember" />;
  return null;
}

function ActorNode({ data }) {
  return (
    <div className={`min-w-[200px] rounded-2xl px-4 py-3 text-white ${statusStyle(data.status)}`}>
      <div className="mb-1.5 flex items-center gap-2">
        <div className="text-sm font-semibold">{data.label}</div>
        <div className="ml-auto"><StatusIcon status={data.status} /></div>
      </div>
      <div className="text-xs text-slate-400">{data.count} event{data.count !== 1 ? "s" : ""}</div>
      <div className="mt-1 text-xs text-slate-500">{data.latest || "Waiting"}</div>
    </div>
  );
}

const nodeTypes = { actorNode: ActorNode };

function buildFlow(events, rootActor) {
  const actors = Array.from(new Set([rootActor, ...events.map((event) => event.actor).filter(Boolean)]));
  const byActor = new Map(actors.map((actor) => [actor, events.filter((event) => event.actor === actor)]));
  const nodes = actors.map((actor, index) => {
    const actorEvents = byActor.get(actor) || [];
    const latest = actorEvents[actorEvents.length - 1];
    const status = statusFromEvents(actorEvents);
    return {
      id: actor,
      type: "actorNode",
      position: {
        x: index === 0 ? 60 : 300 + ((index - 1) % 3) * 290,
        y: index === 0 ? 40 : 200 + Math.floor((index - 1) / 3) * 220,
      },
      data: {
        label: actor,
        status,
        count: actorEvents.length,
        latest: latest ? `${latest.kind} / ${latest.status}${eventTime(latest) ? ` · ${eventTime(latest)}` : ""}` : "Waiting",
      },
    };
  });

  const rootEvents = byActor.get(rootActor) || [];
  const rootRunning = statusFromEvents(rootEvents) === "running";
  const latestRootEvent = rootEvents[rootEvents.length - 1];
  const latestTime = eventTime(latestRootEvent);

  const edges = actors.slice(1).map((actor) => ({
    id: `${rootActor}-${actor}`,
    source: rootActor,
    target: actor,
    animated: rootRunning,
    label: latestTime || "",
    labelStyle: { fill: "#94a3b8", fontSize: 10 },
    markerEnd: { type: MarkerType.ArrowClosed, color: "#75a9ff" },
    style: { stroke: "#75a9ff", strokeWidth: 2 },
  }));

  return { nodes, edges };
}

export function WorkflowCanvas({ events = [], rootActor = "orchestrator" }) {
  const flow = useMemo(() => buildFlow(events, rootActor), [events, rootActor]);

  return (
    <Card className="h-[420px] overflow-hidden p-0">
      <div className="h-full w-full">
        <ReactFlow nodes={flow.nodes} edges={flow.edges} nodeTypes={nodeTypes} fitView>
          <Background color="rgba(255,255,255,0.06)" gap={24} />
          <Controls />
        </ReactFlow>
      </div>
    </Card>
  );
}
