"use client";

import { useMemo } from "react";
import ReactFlow, { Background, Controls, MarkerType } from "reactflow";
import "reactflow/dist/style.css";

import { Card } from "@/components/ui/card";

function buildFlow(events, rootActor) {
  const actors = Array.from(new Set([rootActor, ...events.map((event) => event.actor).filter(Boolean)]));
  const nodes = actors.map((actor, index) => {
    const actorEvents = events.filter((event) => event.actor === actor);
    const latest = actorEvents[actorEvents.length - 1];
    return {
      id: actor,
      position: {
        x: index === 0 ? 60 : 280 + ((index - 1) % 3) * 260,
        y: index === 0 ? 40 : 180 + Math.floor((index - 1) / 3) * 220
      },
      data: {
        label: actor,
        count: actorEvents.length,
        latest: latest ? `${latest.kind} / ${latest.status}` : "Waiting"
      },
      style: {
        borderRadius: 24,
        border: "1px solid rgba(255,255,255,0.12)",
        background: actor === rootActor ? "linear-gradient(135deg, rgba(117,169,255,0.2), rgba(255,255,255,0.04))" : "rgba(255,255,255,0.04)",
        color: "#ffffff",
        padding: 18,
        minWidth: 190
      }
    };
  });

  const edges = actors.slice(1).map((actor) => ({
    id: `${rootActor}-${actor}`,
    source: rootActor,
    target: actor,
    markerEnd: { type: MarkerType.ArrowClosed, color: "#75a9ff" },
    style: { stroke: "#75a9ff", strokeWidth: 2 }
  }));

  return { nodes, edges };
}

export function WorkflowCanvas({ events = [], rootActor = "orchestrator" }) {
  const flow = useMemo(() => buildFlow(events, rootActor), [events, rootActor]);

  return (
    <Card className="h-[560px] overflow-hidden p-0">
      <div className="h-full w-full">
        <ReactFlow nodes={flow.nodes} edges={flow.edges} fitView>
          <Background color="rgba(255,255,255,0.06)" gap={24} />
          <Controls />
        </ReactFlow>
      </div>
    </Card>
  );
}
