"use client";

import {
  Bot,
  CheckCircle2,
  Code2,
  Cpu,
  Loader2,
  MousePointerClick,
  Network,
  Route,
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

function cleanInlineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function latestEvent(events, predicate) {
  return [...events].reverse().find(predicate);
}

function firstEvent(events, predicate) {
  return [...events].find(predicate);
}

function decisionIntent(event) {
  const details = event?.details && typeof event.details === "object" ? event.details : {};
  return (
    details.next_action ||
    details.next_step ||
    details.next_actor ||
    details.next_agent ||
    details.selected_agent ||
    details.route_to ||
    ""
  );
}

function decisionReason(event) {
  const details = event?.details && typeof event.details === "object" ? event.details : {};
  return (
    details.reasoning ||
    details.reason ||
    details.summary ||
    details.note ||
    details.explanation ||
    ""
  );
}

function buildGraph(events, rootActor, agentRollups = []) {
  const normalized = normalizeTraceEvents(events);
  const stageView = buildStageView(normalized);
  const stageMap = new Map(stageView.stages.map((stage) => [stage.stage, stage]));
  const rollupMap = new Map();
  for (const row of agentRollups || []) {
    const key = String(row?.agent_type || row?.actor || "").trim().toLowerCase();
    if (key) rollupMap.set(key, row);
  }
  const pipelineStarted = latestEvent(normalized, (event) => event.kind === "pipeline_started");
  const pipelineTerminal = latestEvent(normalized, (event) =>
    ["pipeline_finished", "pipeline_failed", "run_cancelled", "cancel_requested"].includes(
      event.kind,
    ),
  );
  const orchestratorDecisions = normalized.filter((event) => event.kind === "orchestrator_decision");
  const latestDecision = orchestratorDecisions.at(-1);
  const runtimeReady = firstEvent(
    normalized,
    (event) =>
      event.kind !== "pipeline_started" &&
      (event.actor === "orchestrator" ||
        Boolean(event.actor && AGENT_STAGES.some((stage) => String(event.actor).toLowerCase().includes(stage))) ||
        [
          "agent_started",
          "tool_call_started",
          "tool_call_finished",
          "llm_turn_started",
          "llm_response",
        ].includes(event.kind)),
  );

  const ingressNodes = [
    {
      id: "request",
      label: "Run request",
      icon: MousePointerClick,
      status: pipelineStarted ? "done" : "idle",
      detail: pipelineStarted?.message || "Waiting for workflow start.",
    },
    {
      id: "runtime",
      label: "Runtime active",
      icon: Code2,
      status: runtimeReady ? "done" : pipelineStarted ? "running" : "idle",
      detail:
        runtimeReady?.message ||
        (pipelineStarted
          ? "Waiting for the first orchestrator, agent, model, or tool event."
          : "Runtime has not started."),
    },
  ];

  const orchestratorStatus = pipelineTerminal
    ? pipelineTerminal.kind === "pipeline_failed"
      ? "failed"
      : pipelineTerminal.kind === "run_cancelled" || pipelineTerminal.kind === "cancel_requested"
        ? "cancelled"
        : "done"
    : pipelineStarted
      ? "running"
      : "idle";

  const agentNodes = AGENT_STAGES.map((stage) => {
    const view = stageMap.get(stage) || {
      stage,
      status: "idle",
      events: [],
      toolCalls: [],
      llmCalls: 0,
      frames: [],
    };
    const stageEvents = view.events || [];
    const latest = latestEvent(stageEvents, () => true);
    const rollup = rollupMap.get(stage) || null;
    const llmEvents = stageEvents.filter((event) => String(event.kind || "").startsWith("llm_"));
    const llmAttempts =
      stageEvents.filter((event) => event.kind === "llm_turn_started").length ||
      llmEvents.length;
    const latestModelEvent = latestEvent(
      stageEvents,
      (event) =>
        String(event.kind || "").startsWith("llm_") &&
        (event?.details?.provider || event?.details?.model_name),
    );
    const providerModel = cleanInlineText(
      `${latestModelEvent?.details?.provider || ""} ${latestModelEvent?.details?.model_name || ""}`,
    );
    return {
      id: stage,
      stage,
      label: STAGE_LABELS[stage] || stage,
      status: view.status || rollup?.status || "idle",
      detail:
        latest?.message ||
        cleanInlineText(rollup?.output_summary || "") ||
        view.liveLabel ||
        "No events recorded for this agent.",
      toolCalls: view.toolCalls || [],
      llmCalls: llmEvents,
      llmAttempts,
      frames: view.frames || [],
      providerModel,
      outputSummary: cleanInlineText(rollup?.output_summary || ""),
      recentMilestones: stageEvents.slice(-3).reverse(),
      durationSeconds: Number(rollup?.duration_seconds || 0),
    };
  });

  return {
    ingressNodes,
    orchestrator: {
      id: "orchestrator",
      label: "Orchestrator",
      status: orchestratorStatus,
      detail:
        latestDecision?.message ||
        pipelineTerminal?.message ||
        pipelineStarted?.message ||
        rootActor ||
        "orchestrator",
      decisionCount: orchestratorDecisions.length,
      details: latestDecision?.details || pipelineTerminal?.details || {},
      nextTarget: decisionIntent(latestDecision),
      reason: decisionReason(latestDecision),
    },
    agentNodes,
    totalTools: stageView.toolCalls.length,
    totalLlm: agentNodes.reduce((sum, node) => sum + Number(node.llmAttempts || 0), 0),
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
      className={`relative w-full max-w-full rounded-[10px] border bg-card px-3 py-3 shadow-sm ${wide ? "sm:w-[270px]" : "sm:w-[196px]"}`}
      style={{
        borderColor:
          node.status === "idle"
            ? "var(--line)"
            : `color-mix(in oklch, ${color} 42%, var(--line))`,
        boxShadow:
          node.status === "running" || node.status === "active"
            ? `0 0 0 1px color-mix(in oklch, ${color} 28%, transparent)`
            : undefined,
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
          <div className="truncate font-mono text-[10px] text-muted-foreground">{node.status}</div>
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
      {node.nextTarget || node.reason ? (
        <div className="mt-2 space-y-1 rounded-[8px] border border-border/70 bg-muted/25 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
          {node.nextTarget ? (
            <div>
              <span className="font-semibold text-foreground/80">Next:</span> {node.nextTarget}
            </div>
          ) : null}
          {node.reason ? (
            <div>
              <span className="font-semibold text-foreground/80">Why:</span> {node.reason}
            </div>
          ) : null}
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
      className="flex min-w-0 items-center gap-2 rounded-[8px] border bg-background/90 px-2 py-1.5 sm:min-w-[128px]"
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
    <div className="flex w-full max-w-[260px] flex-col items-center gap-2">
      <GraphNode node={node} icon={Bot} />
      <Connector vertical active={node.status !== "idle"} />
      <div className="flex w-full flex-col gap-1.5">
        {node.providerModel ? (
          <div
            className="rounded-[8px] border px-2.5 py-1.5 font-mono text-[10px]"
            style={{
              borderColor: "var(--line)",
              background: "color-mix(in oklch, var(--card) 90%, transparent)",
              color: "var(--mute-2)",
            }}
            title={node.providerModel}
          >
            {node.providerModel}
          </div>
        ) : null}
        <MicroNode
          type="llm"
          label="Model attempts"
          count={Number(node.llmAttempts || 0)}
          detail={llmDetail}
        />
        <MicroNode
          type="tool"
          label="MCP tools"
          count={(node.toolCalls || []).length}
          detail={toolDetail}
        />
        <MicroNode
          type="artifact"
          label="Artifacts"
          count={(node.frames || []).length}
          detail="Screenshots and visual frames captured for this agent."
        />
        {node.outputSummary || node.recentMilestones?.length ? (
          <details
            className="rounded-[10px] border bg-background/90 px-2.5 py-2 text-[10.5px]"
            style={{ borderColor: "var(--line)" }}
          >
            <summary className="cursor-pointer font-semibold text-foreground/85">
              Stage details
            </summary>
            {node.outputSummary ? (
              <div className="mt-2 text-muted-foreground">
                <span className="font-semibold text-foreground/80">Output:</span> {node.outputSummary}
              </div>
            ) : null}
            {node.durationSeconds > 0 ? (
              <div className="mt-2 text-muted-foreground">
                <span className="font-semibold text-foreground/80">Duration:</span> {node.durationSeconds.toFixed(1)}s
              </div>
            ) : null}
            {node.recentMilestones?.length ? (
              <div className="mt-2 space-y-1.5 text-muted-foreground">
                <div className="font-semibold text-foreground/80">Recent milestones</div>
                {node.recentMilestones.map((event, index) => (
                  <div key={`${node.stage}-${event.seq || event.timestamp || index}`} className="rounded-[8px] bg-muted/25 px-2 py-1.5">
                    {cleanInlineText(event.message || event.kind || "Event")}
                  </div>
                ))}
              </div>
            ) : null}
          </details>
        ) : null}
      </div>
    </div>
  );
}

export function OrchestratorGraph({ events = [], rootActor = "orchestrator", agentRollups = [] }) {
  const graph = buildGraph(events, rootActor, agentRollups);
  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="border-b border-border px-4 py-3">
        <div className="flex flex-wrap items-start gap-2">
          <div>
            <CardTitle className="text-sm">Agent desk</CardTitle>
            <CardDescription>
              Workflow graph with stage branches, model attempts, tool work, artifacts, and expandable run details.
            </CardDescription>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Badge tone="warning" className="font-mono">
              {graph.orchestrator.decisionCount} decisions
            </Badge>
            <Badge tone="violet" className="font-mono">
              {graph.totalLlm} LLM
            </Badge>
            <Badge tone="signal" className="font-mono">
              {graph.totalTools} tools
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div
          className="overflow-hidden"
          style={{
            backgroundImage:
              "radial-gradient(circle, color-mix(in oklch, var(--mute-3) 32%, transparent) 1px, transparent 1px)",
            backgroundSize: "18px 18px",
          }}
        >
          <div className="px-3 py-5 sm:px-5 sm:py-6">
            <div className="flex flex-col items-center gap-5">
              <div className="grid w-full grid-cols-1 items-stretch justify-center gap-3 sm:grid-cols-2">
                {graph.ingressNodes.map((node, index) => (
                  <div key={node.id} className="flex items-center justify-center">
                    <GraphNode node={node} icon={node.icon} />
                    {index < graph.ingressNodes.length - 1 ? (
                      <div className="hidden sm:block">
                        <Connector active={node.status !== "idle"} />
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              <Connector vertical active={graph.orchestrator.status !== "idle"} />

              <div className="flex justify-center">
                <GraphNode node={graph.orchestrator} icon={Route} wide />
              </div>

              <Connector vertical active={graph.orchestrator.status !== "idle"} />

              <div className="relative mx-auto w-full max-w-[1060px] pt-3">
                <div className="absolute left-[12.5%] right-[12.5%] top-0 hidden border-t border-dashed border-border lg:block" />
                <div className="pointer-events-none absolute left-1/2 top-0 hidden h-4 w-px -translate-x-1/2 border-l border-dashed border-border lg:block" />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {graph.agentNodes.map((node) => (
                    <div key={node.id} className="flex flex-col items-center gap-2">
                      <Connector vertical active={node.status !== "idle"} />
                      <AgentBranch node={node} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
