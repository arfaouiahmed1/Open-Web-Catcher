"use client";

import {
  Bot,
  CheckCircle2,
  Circle,
  Code2,
  Cpu,
  Loader2,
  MousePointerClick,
  Network,
  Route,
  Search,
  XCircle,
} from "lucide-react";

import { buildStageView, normalizeTraceEvents, STAGE_LABELS } from "@/lib/run-trace";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const AGENT_STAGES = ["classification", "landing", "hosting", "embedded"];

function toneForStatus(status) {
  if (status === "done" || status === "success") return "success";
  if (status === "running" || status === "active") return "signal";
  if (status === "failed" || status === "error") return "danger";
  if (status === "warning" || status === "partial" || status === "cancelled") return "warning";
  return "default";
}

function nodeColor(status, fallback = "var(--mute-3)") {
  if (status === "done" || status === "success") return "var(--mint)";
  if (status === "running" || status === "active") return "var(--signal)";
  if (status === "failed" || status === "error") return "var(--rose)";
  if (status === "warning" || status === "partial" || status === "cancelled") return "var(--signal)";
  return fallback;
}

function stageColor(stage) {
  if (stage === "classification") return "var(--sky)";
  if (stage === "landing") return "var(--violet)";
  if (stage === "hosting") return "var(--mint)";
  if (stage === "embedded") return "var(--signal)";
  if (stage === "orchestrator") return "var(--signal)";
  return "var(--mute-3)";
}

function statusIcon(status, Icon = Bot) {
  if (status === "running" || status === "active") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (status === "done" || status === "success") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "failed" || status === "error") return <XCircle className="h-4 w-4" />;
  return <Icon className="h-4 w-4" />;
}

function compactJson(value) {
  if (!value || typeof value !== "object") return "";
  try {
    return JSON.stringify(value, null, 2).slice(0, 1200);
  } catch {
    return "";
  }
}

function latestEvent(events, predicate) {
  return [...events].reverse().find(predicate);
}

function buildGraph(events, rootActor) {
  const normalized = normalizeTraceEvents(events);
  const stageView = buildStageView(normalized);
  const stageMap = new Map(stageView.stages.map((stage) => [stage.stage, stage]));
  const pipelineStarted = latestEvent(normalized, (event) => event.kind === "pipeline_started");
  const pipelineFinished = latestEvent(normalized, (event) => event.kind === "pipeline_finished" || event.kind === "pipeline_failed");
  const orchestratorDecisions = normalized.filter((event) => event.kind === "orchestrator_decision");
  const latestDecision = orchestratorDecisions.at(-1);

  const preNodes = [
    {
      id: "execute",
      label: "Execute workflow",
      icon: MousePointerClick,
      status: pipelineStarted ? "done" : "idle",
      detail: pipelineStarted?.message || "Waiting for workflow start.",
    },
    {
      id: "init",
      label: "Init browser",
      icon: Code2,
      status: normalized.some((event) => event.kind === "agent_loop_started" || event.kind === "tool_call_started") ? "done" : (pipelineStarted ? "running" : "idle"),
      detail: "Browser and tool runtime initialization.",
    },
    {
      id: "pre-navigation",
      label: "Pre-navigation",
      icon: Search,
      status: normalized.some((event) => event.kind === "tool_call_finished") ? "done" : (pipelineStarted ? "running" : "idle"),
      detail: "Context, page inspection, and first navigation/tool events.",
    },
  ];

  const orchestratorStatus = pipelineFinished
    ? (pipelineFinished.status === "error" ? "failed" : pipelineFinished.status === "warning" ? "partial" : "done")
    : pipelineStarted
      ? "running"
      : "idle";

  const agentNodes = AGENT_STAGES.map((stage) => {
    const view = stageMap.get(stage) || { stage, status: "idle", events: [], toolCalls: [], llmCalls: 0, frames: [] };
    const latest = latestEvent(view.events || [], () => true);
    const llmEvents = (view.events || []).filter((event) => event.kind === "llm_response");
    return {
      id: stage,
      stage,
      label: STAGE_LABELS[stage] || stage,
      status: view.status || "idle",
      detail: latest?.message || view.liveLabel || "No events recorded for this agent.",
      eventCount: (view.events || []).length,
      toolCalls: view.toolCalls || [],
      llmCalls: llmEvents,
      frames: view.frames || [],
    };
  });

  return {
    preNodes,
    orchestrator: {
      id: "orchestrator",
      label: "Orchestrator",
      status: orchestratorStatus,
      detail: latestDecision?.message || pipelineFinished?.message || pipelineStarted?.message || rootActor || "orchestrator",
      decisionCount: orchestratorDecisions.length,
      details: latestDecision?.details || pipelineFinished?.details || {},
    },
    agentNodes,
    totalTools: stageView.toolCalls.length,
    totalLlm: agentNodes.reduce((sum, node) => sum + node.llmCalls.length, 0),
  };
}

function Connector({ vertical = false, active = false }) {
  return (
    <div
      className={vertical ? "mx-auto h-10 w-px border-l border-dashed" : "h-px w-12 border-t border-dashed"}
      style={{
        borderColor: active ? "color-mix(in oklch, var(--signal) 52%, var(--line))" : "var(--line)",
      }}
    />
  );
}

function GraphNode({ node, icon: Icon = Bot, wide = false }) {
  const color = nodeColor(node.status, stageColor(node.stage));
  const details = [node.detail, compactJson(node.details)].filter(Boolean).join("\n\n");
  return (
    <div
      className={`relative rounded-[8px] border bg-card px-3 py-2 shadow-sm ${wide ? "w-[230px]" : "w-[190px]"}`}
      style={{
        borderColor: node.status === "idle" ? "var(--line)" : `color-mix(in oklch, ${color} 42%, var(--line))`,
        boxShadow: node.status === "running" || node.status === "active" ? `0 0 0 1px color-mix(in oklch, ${color} 28%, transparent)` : undefined,
      }}
      title={details || node.label}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[7px]"
          style={{
            background: `color-mix(in oklch, ${color} 14%, transparent)`,
            color,
          }}
        >
          {statusIcon(node.status, Icon)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-semibold text-foreground">{node.label}</div>
          <div className="truncate font-mono text-[10px] text-muted-foreground">
            {node.status}
          </div>
        </div>
        <Badge tone={toneForStatus(node.status)} className="px-1.5 py-0 text-[9px] uppercase">
          {node.status === "idle" ? "idle" : node.status}
        </Badge>
      </div>
      {node.detail ? (
        <div className="mt-2 line-clamp-2 text-[10.5px] leading-relaxed text-muted-foreground">
          {node.detail}
        </div>
      ) : null}
    </div>
  );
}

function MicroNode({ type, label, count, status = "done", detail = "" }) {
  const Icon = type === "llm" ? Cpu : type === "tool" ? Code2 : Network;
  const color = type === "llm" ? "var(--violet)" : type === "tool" ? "var(--sky)" : "var(--mint)";
  return (
    <div
      className="flex min-w-[138px] items-center gap-2 rounded-[8px] border bg-background/90 px-2 py-1.5"
      style={{
        borderColor: count > 0 ? `color-mix(in oklch, ${color} 36%, var(--line))` : "var(--line)",
      }}
      title={detail || `${label}: ${count}`}
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-[6px]" style={{ color }}>
        {statusIcon(count > 0 ? status : "idle", Icon)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground/85">{label}</span>
      <span className="font-mono text-[10px] text-muted-foreground">{count}</span>
    </div>
  );
}

function AgentBranch({ node }) {
  const toolDetail = (node.toolCalls || [])
    .map((tool) => `${tool.toolName || tool.tool_name || "tool"}: ${tool.status || "unknown"}`)
    .join("\n");
  const llmDetail = (node.llmCalls || [])
    .map((event) => `${event.details?.provider || ""} ${event.details?.model_name || ""}`.trim())
    .filter(Boolean)
    .join("\n");
  return (
    <div className="flex flex-col items-center gap-2">
      <GraphNode node={node} icon={Bot} />
      <Connector vertical active={node.status !== "idle"} />
      <div className="flex flex-col gap-1.5">
        <MicroNode type="llm" label="Model calls" count={(node.llmCalls || []).length} detail={llmDetail} />
        <MicroNode type="tool" label="MCP tools" count={(node.toolCalls || []).length} detail={toolDetail} />
        <MicroNode type="artifact" label="Artifacts" count={(node.frames || []).length} detail="Screenshots and visual frames captured for this agent." />
      </div>
    </div>
  );
}

export function OrchestratorGraph({ events = [], rootActor = "orchestrator" }) {
  const graph = buildGraph(events, rootActor);
  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-start gap-2">
          <div>
            <CardTitle className="text-sm">Workflow graph</CardTitle>
            <CardDescription>
              Live orchestrator routing, agents, model calls, tools, and artifacts.
            </CardDescription>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Badge tone="warning" className="font-mono">{graph.orchestrator.decisionCount} decisions</Badge>
            <Badge tone="violet" className="font-mono">{graph.totalLlm} LLM</Badge>
            <Badge tone="signal" className="font-mono">{graph.totalTools} tools</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div
          className="overflow-x-auto"
          style={{
            backgroundImage: "radial-gradient(circle, color-mix(in oklch, var(--mute-3) 32%, transparent) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        >
          <div className="min-w-[1180px] px-6 py-8">
            <div className="flex items-center justify-center">
              {graph.preNodes.map((node, index) => (
                <div key={node.id} className="flex items-center">
                  <GraphNode node={node} icon={node.icon} />
                  <Connector active={node.status !== "idle"} />
                </div>
              ))}
              <GraphNode node={graph.orchestrator} icon={Route} wide />
            </div>

            <Connector vertical active={graph.orchestrator.status !== "idle"} />

            <div className="relative mx-auto flex max-w-[1060px] justify-between gap-4 pt-2">
              <div className="absolute left-[10%] right-[10%] top-1 border-t border-dashed border-border" />
              {graph.agentNodes.map((node) => (
                <AgentBranch key={node.id} node={node} />
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
