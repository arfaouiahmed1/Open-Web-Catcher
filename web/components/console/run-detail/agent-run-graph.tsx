/* eslint-disable */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Activity, Bot, CheckCircle2, Clock3, Cpu, GitBranch, Loader2, Maximize2, Radio, Wrench, XCircle } from "lucide-react";
import { Background, Controls, Handle, MarkerType, MiniMap, Position } from "reactflow";
import "reactflow/dist/style.css";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatTime } from "@/lib/datetime";
import { buildAgentRunGraph, type AgentGraphStatus, type AgentRunGraphEvent, type AgentRunGraphNode } from "@/lib/agent-run-graph";
import { formatNumber } from "@/lib/utils";
import { AgentInspectorPanel } from "@/components/console/run-detail/agent-inspector-panel";

const ReactFlow = dynamic(
  () => import("reactflow").then((module) => module.default as unknown as React.ComponentType<Record<string, unknown>>),
  { ssr: false },
);

const EMPTY_ARRAY: AgentRunGraphEvent[] = [];
const EMPTY_ROLLUPS: Record<string, unknown>[] = [];

function statusColor(status: AgentGraphStatus): string {
  if (status === "running") return "var(--signal)";
  if (status === "success") return "var(--mint)";
  if (status === "failed") return "var(--rose)";
  if (status === "partial") return "var(--sky)";
  if (status === "queued") return "var(--violet)";
  if (status === "skipped") return "var(--mute-2)";
  return "var(--mute)";
}

function statusLabel(status: AgentGraphStatus): string {
  if (status === "unknown") return "Waiting";
  if (status === "partial") return "Partial";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function statusIcon(status: AgentGraphStatus) {
  if (status === "running") return Loader2;
  if (status === "success") return CheckCircle2;
  if (status === "failed") return XCircle;
  if (status === "queued") return Radio;
  return Activity;
}

function compactMetric(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return formatNumber(value);
}

function compactDuration(value: number): string {
  if (!value) return "--";
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`;
}

function safeEventText(event: AgentRunGraphEvent): string {
  const raw = String(event.message || event.kind || "Runtime event").replace(/\s+/g, " ").trim();
  return raw.replace(/https?:\/\/[^\s)]+/gi, "[target]");
}

function eventIcon(kind: string) {
  if (kind.startsWith("llm_")) return Cpu;
  if (kind.startsWith("tool_")) return Wrench;
  if (kind.includes("handoff") || kind.includes("decision")) return GitBranch;
  return Activity;
}

function MetricTile({ label, value, detail, tone = "var(--ink)" }: { label: string; value: string; detail: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-[12px] border px-3 py-2.5" style={{ borderColor: "var(--line)", background: "color-mix(in oklch, var(--bg) 82%, transparent)" }}>
      <div className="truncate text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }} title={label}>{label}</div>
      <div className="mt-1 font-mono text-[15px] font-semibold whitespace-nowrap tabular-nums" style={{ color: tone }} title={value}>{value}</div>
      <div className="mt-0.5 truncate text-[10px]" style={{ color: "var(--mute)" }} title={detail}>{detail}</div>
    </div>
  );
}

function ContextBar({ node, compact = false }: { node: AgentRunGraphNode; compact?: boolean }) {
  const pct = node.contextWindow > 0 ? Math.max(0, Math.min(1, node.contextUsagePct)) : 0;
  const tone = pct >= 0.85 ? "var(--rose)" : pct >= 0.6 ? "var(--signal)" : "var(--mint)";
  return (
    <div className={compact ? "mt-2" : "mt-3"}>
      <div className="flex items-center justify-between gap-2 text-[10px]">
        <span className="truncate uppercase tracking-[0.1em]" style={{ color: "var(--mute-3)" }}>Context window</span>
        <span className="shrink-0 font-mono" style={{ color: node.contextWindow ? tone : "var(--mute-2)" }}>
          {node.contextWindow ? `${(pct * 100).toFixed(1)}%` : "not reported"}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${pct * 100}%`, background: node.contextWindow ? tone : "var(--mute-3)" }} />
      </div>
    </div>
  );
}

function GraphNode({ data, selected }: { data: AgentRunGraphNode & { onSelect?: (id: string) => void }; selected?: boolean }) {
  const color = data.kind === "root" ? "var(--signal)" : statusColor(data.status);
  const Icon = data.kind === "root" ? Bot : statusIcon(data.status);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${data.stageLabel} ${data.actor}, ${statusLabel(data.status)}, ${data.eventCount} events`}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          data.onSelect?.(data.id);
        }
      }}
      onClick={() => data.onSelect?.(data.id)}
      className="min-w-[214px] max-w-[230px] rounded-[16px] border px-3 py-3 text-left shadow-sm transition-[border-color,box-shadow]"
      style={{
        borderColor: selected ? color : `color-mix(in oklch, ${color} 36%, var(--line))`,
        background: `linear-gradient(180deg, color-mix(in oklch, ${color} 12%, transparent), color-mix(in oklch, var(--card) 96%, transparent) 58%)`,
        boxShadow: selected ? `0 0 0 2px color-mix(in oklch, ${color} 18%, transparent)` : undefined,
      }}
    >
      <Handle type="target" position={Position.Left} style={{ width: 7, height: 7, border: 0, background: color }} />
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ background: `color-mix(in oklch, ${color} 16%, transparent)`, color }}>
          <Icon className={`h-3.5 w-3.5 ${data.status === "running" ? "animate-spin" : ""}`} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color }}>{data.stageLabel}</div>
          <div className="mt-0.5 truncate text-[13px] font-semibold" style={{ color: "var(--ink)" }} title={data.actor}>{data.actor}</div>
        </div>
        <span className="shrink-0 rounded-full border px-1.5 py-0.5 text-[9px] font-medium" style={{ borderColor: `color-mix(in oklch, ${color} 30%, var(--line))`, color }}>
          {statusLabel(data.status)}
        </span>
      </div>
      <div className="mt-2 line-clamp-2 min-h-[28px] text-[11px] leading-relaxed" style={{ color: "var(--mute)" }}>{data.safeLatestActivity}</div>
      <div className="mt-2 grid grid-cols-3 gap-1 border-t pt-2 text-[10px]" style={{ borderColor: "var(--line)" }}>
        <div><div style={{ color: "var(--mute-3)" }}>events</div><div className="mt-0.5 font-mono" style={{ color: "var(--ink)" }}>{compactMetric(data.eventCount)}</div></div>
        <div><div style={{ color: "var(--mute-3)" }}>tools</div><div className="mt-0.5 font-mono" style={{ color: "var(--ink)" }}>{compactMetric(data.toolCalls)}</div></div>
        <div><div style={{ color: "var(--mute-3)" }}>tokens</div><div className="mt-0.5 font-mono" style={{ color: "var(--ink)" }}>{compactMetric(data.totalTokens)}</div></div>
      </div>
      <ContextBar node={data} compact />
      <Handle type="source" position={Position.Right} style={{ width: 7, height: 7, border: 0, background: color }} />
    </div>
  );
}

const nodeTypes = { agentNode: GraphNode };

function layoutNodes(nodes: AgentRunGraphNode[], onSelect: (id: string) => void) {
  const lanes = new Map<number, number>();
  return nodes.map((node) => {
    if (node.kind === "root") {
      return { id: node.id, type: "agentNode", position: { x: 30, y: 190 }, data: { ...node, onSelect } };
    }
    const lane = lanes.get(node.stageIndex) || 0;
    lanes.set(node.stageIndex, lane + 1);
    return {
      id: node.id,
      type: "agentNode",
      position: { x: 320 + node.stageIndex * 275, y: 58 + lane * 170 },
      data: { ...node, onSelect },
    };
  });
}

function graphEdges(edges: Array<{ id: string; source: string; target: string; kind: string; animated: boolean }>) {
  return edges.map((edge) => {
    const color = edge.kind === "handoff" ? "var(--signal)" : edge.kind === "continuation" ? "var(--violet)" : "var(--sky-text)";
    return {
      ...edge,
      type: "smoothstep",
      animated: edge.animated,
      label: edge.kind === "handoff" ? "handoff" : undefined,
      labelStyle: { fill: "var(--mute-2)", fontSize: 9, fontFamily: "var(--font-mono)" },
      labelBgStyle: { fill: "var(--card)", fillOpacity: 0.92 },
      markerEnd: { type: MarkerType.ArrowClosed, color },
      style: { stroke: color, strokeWidth: edge.kind === "handoff" ? 2 : 1.5, strokeDasharray: edge.kind === "continuation" ? "4 4" : undefined },
    };
  });
}

export interface AgentRunGraphProps {
  runId?: string;
  events?: AgentRunGraphEvent[];
  agentRollups?: Record<string, unknown>[];
  rootActor?: string;
  streamConnected?: boolean;
  streamStatus?: string;
  completed?: boolean;
  runStatus?: string;
  /** Hide tool input arguments in the inspector (display settings). */
  showToolArgs?: boolean;
}

export function AgentRunGraph({
  runId = "",
  events = EMPTY_ARRAY,
  agentRollups = EMPTY_ROLLUPS,
  rootActor = "orchestrator",
  streamConnected = false,
  streamStatus = "",
  completed = false,
  runStatus = "",
  showToolArgs = true,
}: AgentRunGraphProps) {
  const graph = useMemo(() => buildAgentRunGraph({ events, agentRollups, rootActor }), [agentRollups, events, rootActor]);
  const defaultSelectedId = graph.agentNodes.find((node) => node.status === "running")?.id || graph.agentNodes[graph.agentNodes.length - 1]?.id || "root";
  const [selectedId, setSelectedId] = useState(defaultSelectedId);

  useEffect(() => {
    setSelectedId(defaultSelectedId);
  }, [defaultSelectedId, runId]);

  const selectNode = useCallback((id: string) => setSelectedId(id), []);
  const flowNodes = useMemo(() => layoutNodes(graph.nodes, selectNode), [graph.nodes, selectNode]);
  const flowEdges = useMemo(() => graphEdges(graph.edges), [graph.edges]);
  const selectedNode = graph.nodes.find((node) => node.id === selectedId) || graph.nodes[0];
  const normalizedRunStatus = String(runStatus || "").toLowerCase();
  const active = graph.summary.activeAgentCount > 0 || (!completed && ["queued", "running", "retrying", "leased"].includes(normalizedRunStatus)) || (!completed && !graph.summary.completedAgentCount && graph.summary.eventCount > 0);
  const liveLabel = streamConnected ? "SSE connected" : active ? (streamStatus || "Waiting for stream") : "Snapshot";
  const contextPct = graph.summary.contextWindow > 0 ? Math.max(0, Math.min(1, graph.summary.contextUsagePct)) : 0;

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="border-b px-4 py-4" style={{ borderColor: "var(--line)", background: "linear-gradient(180deg, color-mix(in oklch, var(--signal) 7%, transparent), transparent 76%)" }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-sm font-medium">Live agent run map</CardTitle>
              <span className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.1em]" style={{ borderColor: streamConnected ? "color-mix(in oklch, var(--mint) 34%, var(--line))" : "var(--line)", color: streamConnected ? "var(--mint-text)" : "var(--mute-2)" }} aria-live="polite">
                <span className={`h-1.5 w-1.5 rounded-full ${streamConnected ? "animate-pulse" : ""}`} style={{ background: streamConnected ? "var(--mint)" : "var(--mute-2)" }} />
                {liveLabel}
              </span>
            </div>
            <CardDescription className="mt-1 text-[12px]">Execution topology, agent work, handoffs, tools, tokens, and context pressure derived from the run stream.</CardDescription>
          </div>
          <div className="flex items-center gap-2 text-[10px]" style={{ color: "var(--mute-2)" }}>
            <Maximize2 className="h-3.5 w-3.5" />
            <span>Click a node to inspect</span>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 p-4">
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          <MetricTile label="Agents ran" value={formatNumber(graph.summary.agentCount)} detail={`${formatNumber(graph.summary.completedAgentCount)} completed`} tone="var(--signal)" />
          <MetricTile label="Active now" value={formatNumber(graph.summary.activeAgentCount)} detail={active ? "Live execution" : "No active agents"} tone="var(--mint)" />
          <MetricTile label="Events" value={formatNumber(graph.summary.eventCount)} detail="Observed telemetry" tone="var(--sky)" />
          <MetricTile label="Context peak" value={graph.summary.contextWindow ? `${(contextPct * 100).toFixed(1)}%` : "--"} detail={graph.summary.contextWindow ? `${compactMetric(graph.summary.contextTokens)} / ${compactMetric(graph.summary.contextWindow)}` : "Not reported"} tone={graph.summary.contextWindow ? "var(--signal)" : "var(--ink)"} />
          <MetricTile label="Context windows" value={formatNumber(graph.summary.contextWindowCount)} detail="Agent nodes with telemetry" tone="var(--violet)" />
          <MetricTile label="Tool calls" value={formatNumber(graph.summary.toolCallCount)} detail="Finished / observed" tone="var(--signal)" />
          <MetricTile label="LLM calls" value={formatNumber(graph.summary.llmCallCount)} detail={`${compactMetric(graph.summary.totalTokens)} tokens`} tone="var(--violet)" />
        </div>

        <div className="overflow-hidden rounded-[16px] border" style={{ borderColor: "var(--line)", background: "color-mix(in oklch, var(--bg) 72%, transparent)" }}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2.5" style={{ borderColor: "var(--line)" }}>
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-2)" }}>
              <GitBranch className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
              Observed execution path
            </div>
            <div className="flex flex-wrap items-center gap-3 text-[10px]" style={{ color: "var(--mute-3)" }}>
              <span className="flex items-center gap-1"><span className="h-1.5 w-5 rounded-full" style={{ background: "var(--sky-text)" }} />control</span>
              <span className="flex items-center gap-1"><span className="h-1.5 w-5 rounded-full" style={{ background: "var(--signal)" }} />handoff</span>
              <span className="flex items-center gap-1"><span className="h-0.5 w-5" style={{ borderTop: "1px dashed var(--violet)" }} />continuation</span>
            </div>
          </div>
          <div className="h-[470px] w-full min-w-0">
            <ReactFlow
              nodes={flowNodes as never}
              edges={flowEdges as never}
              nodeTypes={nodeTypes as never}
              fitView
              fitViewOptions={{ padding: 0.2, minZoom: 0.45, maxZoom: 1.1 }}
              minZoom={0.35}
              maxZoom={1.5}
              nodesConnectable={false}
              onNodeClick={(_event: unknown, node: { id: string }) => selectNode(node.id)}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="var(--line-hi)" gap={24} size={1} />
              <Controls showInteractive={false} />
              <MiniMap pannable zoomable nodeColor={(node: { data?: AgentRunGraphNode }) => statusColor(node.data?.status || "unknown")} maskColor="color-mix(in oklch, var(--bg) 76%, transparent)" />
            </ReactFlow>
          </div>
        </div>
        {selectedNode ? (
          <AgentInspectorPanel node={selectedNode} events={events} totalCostUsd={graph.agentNodes.reduce((sum, node) => sum + Number(node.costUsd || 0), 0)} showToolArgs={showToolArgs} />
        ) : null}
      </CardContent>
    </Card>
  );
}
