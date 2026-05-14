"use client";

import {
  Bot,
  CheckCircle2,
  Code2,
  Cpu,
  GitBranch,
  Loader2,
  MousePointerClick,
  Route,
  ScanSearch,
  XCircle,
} from "lucide-react";

import { buildStageView, getRunTerminalState, normalizeTraceEvents, STAGE_LABELS } from "@/lib/run-trace";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const AGENT_STAGES = ["classification", "landing", "hosting", "embedded"];

function toneForStatus(status) {
  if (status === "done" || status === "success" || status === "completed") return "success";
  if (status === "running" || status === "active") return "signal";
  if (status === "failed" || status === "error") return "danger";
  if (status === "cancelled" || status === "warning" || status === "partial") return "warning";
  return "default";
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
  if (status === "done" || status === "success" || status === "completed") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "failed" || status === "error") return <XCircle className="h-4 w-4" />;
  return <Icon className="h-4 w-4" />;
}

function cleanInlineText(value, fallback = "") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || fallback;
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

function buildBoard(events, rootActor, agentRollups = []) {
  const normalized = normalizeTraceEvents(events);
  const stageView = buildStageView(normalized);
  const terminalState = getRunTerminalState(normalized);
  const stageMap = new Map(stageView.stages.map((stage) => [stage.stage, stage]));
  const rollupMap = new Map();
  for (const row of agentRollups || []) {
    const key = String(row?.agent_type || row?.actor || "").trim().toLowerCase();
    if (key) rollupMap.set(key, row);
  }

  const pipelineStarted = latestEvent(normalized, (event) => event.kind === "pipeline_started");
  const pipelineTerminal = terminalState.terminal;
  const runtimeReady = firstEvent(
    normalized,
    (event) =>
      event.kind !== "pipeline_started" &&
      (event.actor === "orchestrator" ||
        Boolean(event.actor && AGENT_STAGES.some((stage) => String(event.actor).toLowerCase().includes(stage))) ||
        ["agent_started", "tool_call_started", "tool_call_finished", "llm_turn_started", "llm_response"].includes(event.kind)),
  );
  const orchestratorDecisions = normalized.filter((event) => event.kind === "orchestrator_decision");
  const latestDecision = orchestratorDecisions.at(-1);

  const topCards = [
    {
      id: "request",
      label: "Run request",
      icon: MousePointerClick,
      status: pipelineStarted ? "done" : "idle",
      detail: cleanInlineText(pipelineStarted?.message, "Waiting for workflow start."),
      accent: "var(--sky)",
      meta: pipelineStarted?.timestamp ? new Date(pipelineStarted.timestamp).toLocaleTimeString() : "",
    },
    {
      id: "runtime",
      label: "Runtime",
      icon: Code2,
      status:
        terminalState.status === "cancelled"
          ? "cancelled"
          : terminalState.status === "failed"
            ? "failed"
            : runtimeReady
              ? "done"
              : pipelineStarted
                ? "running"
                : "idle",
      detail: cleanInlineText(
        runtimeReady?.message,
        pipelineStarted ? "Runtime waiting for the first agent/model/tool event." : "Runtime has not started.",
      ),
      accent: "var(--signal)",
      meta: runtimeReady?.timestamp ? new Date(runtimeReady.timestamp).toLocaleTimeString() : "",
    },
    {
      id: "orchestrator",
      label: "Orchestrator",
      icon: Route,
      status:
        terminalState.status === "completed"
          ? "done"
          : terminalState.status === "failed"
            ? "failed"
            : terminalState.status === "cancelled"
              ? "cancelled"
              : pipelineStarted
                ? "running"
                : "idle",
      detail: cleanInlineText(
        latestDecision?.message || pipelineTerminal?.message,
        rootActor || "orchestrator",
      ),
      accent: "var(--signal)",
      meta: decisionIntent(latestDecision) || "",
      note: decisionReason(latestDecision) || "",
      count: orchestratorDecisions.length,
    },
  ];

  const stages = AGENT_STAGES.map((stage) => {
    const view = stageMap.get(stage) || {
      stage,
      status: "idle",
      events: [],
      toolCalls: [],
      llmCalls: 0,
      frames: [],
      liveLabel: "idle",
      livePhase: "idle",
    };
    const stageEvents = view.events || [];
    const latest = latestEvent(stageEvents, () => true);
    const rollup = rollupMap.get(stage) || null;
    const llmAttempts = stageEvents.filter((event) => event.kind === "llm_turn_started").length;
    const recentMilestones = stageEvents
      .filter((event) => event.kind !== "tool_session_ready")
      .slice(-3)
      .reverse();
    const latestModelEvent = latestEvent(
      stageEvents,
      (event) =>
        String(event.kind || "").startsWith("llm_") &&
        (event?.details?.provider || event?.details?.model_name),
    );

    return {
      id: stage,
      stage,
      label: STAGE_LABELS[stage] || stage,
      status: view.status || "idle",
      liveLabel: view.liveLabel || view.status || "idle",
      accent: stageColor(stage),
      providerModel: cleanInlineText(
        `${latestModelEvent?.details?.provider || ""} ${latestModelEvent?.details?.model_name || ""}`,
      ),
      detail: cleanInlineText(
        latest?.message || rollup?.output_summary || "",
        view.status === "idle" ? "No stage activity recorded." : "Stage activity recorded.",
      ),
      outputSummary: cleanInlineText(rollup?.output_summary || ""),
      durationSeconds: Number(rollup?.duration_seconds || 0),
      llmAttempts,
      toolCount: (view.toolCalls || []).length,
      frameCount: (view.frames || []).length,
      recentMilestones,
    };
  });

  return {
    topCards,
    stages,
    totalTools: stageView.toolCalls.length,
    totalLlm: stages.reduce((sum, node) => sum + Number(node.llmAttempts || 0), 0),
    terminalStatus: terminalState.status,
  };
}

function StatPill({ label, value, tone = "default" }) {
  return (
    <Badge tone={tone} className="px-2 py-0 text-[10px]">
      {label} {value}
    </Badge>
  );
}

function TopCard({ card }) {
  const color = card.accent || "var(--signal)";
  const Icon = card.icon || Bot;
  return (
    <div
      className="rounded-[16px] border px-4 py-3"
      style={{
        borderColor: `color-mix(in oklch, ${color} 26%, var(--line))`,
        background: `linear-gradient(180deg, color-mix(in oklch, ${color} 10%, transparent), color-mix(in oklch, var(--card) 94%, transparent) 58%)`,
      }}
    >
      <div className="flex items-start gap-3">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
          style={{ background: `color-mix(in oklch, ${color} 16%, transparent)`, color }}
        >
          {statusIcon(card.status, Icon)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-foreground">{card.label}</div>
            <Badge tone={toneForStatus(card.status)} className="uppercase">
              {card.status}
            </Badge>
            {typeof card.count === "number" && card.count > 0 ? <Badge tone="default">{card.count}</Badge> : null}
          </div>
          <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{card.detail}</div>
          {card.meta ? <div className="mt-2 font-mono text-[10px] text-muted-foreground/80">{card.meta}</div> : null}
          {card.note ? <div className="mt-1 text-[11px] text-muted-foreground">{card.note}</div> : null}
        </div>
      </div>
    </div>
  );
}

function StageCard({ node }) {
  return (
    <div
      className="rounded-[18px] border px-4 py-4 shadow-sm"
      style={{
        borderColor: `color-mix(in oklch, ${node.accent} 24%, var(--line))`,
        background: `linear-gradient(180deg, color-mix(in oklch, ${node.accent} 10%, transparent), color-mix(in oklch, var(--card) 94%, transparent) 52%)`,
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color: node.accent }}>
              {node.label}
            </span>
            <Badge tone={toneForStatus(node.status)} className="uppercase">
              {node.liveLabel}
            </Badge>
          </div>
          {node.providerModel ? (
            <div className="mt-2 font-mono text-[10.5px] text-muted-foreground">{node.providerModel}</div>
          ) : null}
        </div>
        <span
          className="flex h-9 w-9 items-center justify-center rounded-xl"
          style={{ background: `color-mix(in oklch, ${node.accent} 16%, transparent)`, color: node.accent }}
        >
          {statusIcon(node.status, ScanSearch)}
        </span>
      </div>

      <div className="mt-3 text-[12px] leading-relaxed text-foreground/90">{node.detail}</div>
      {node.outputSummary && node.outputSummary !== node.detail ? (
        <div className="mt-2 rounded-[12px] border border-border/70 bg-background/50 px-3 py-2 text-[11px] text-muted-foreground">
          {node.outputSummary}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <StatPill label="LLM" value={node.llmAttempts} tone="violet" />
        <StatPill label="Tools" value={node.toolCount} tone="signal" />
        <StatPill label="Shots" value={node.frameCount} tone="default" />
        {node.durationSeconds > 0 ? <StatPill label="Sec" value={node.durationSeconds.toFixed(1)} tone="default" /> : null}
      </div>

      {node.recentMilestones.length ? (
        <div className="mt-4 space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Recent milestones</div>
          {node.recentMilestones.map((event, index) => (
            <div
              key={`${node.stage}-${event.seq || event.timestamp || index}`}
              className="rounded-[12px] border border-border/70 bg-background/55 px-3 py-2 text-[11px] text-muted-foreground"
            >
              {cleanInlineText(event.message || event.kind || "Event")}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function OrchestratorGraph({ events = [], rootActor = "orchestrator", agentRollups = [] }) {
  const board = buildBoard(events, rootActor, agentRollups);

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="border-b border-border px-4 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <div>
            <CardTitle className="text-sm">Agent desk</CardTitle>
            <CardDescription>
              Compact execution board for orchestration, stage progress, model attempts, tools, and captured frames.
            </CardDescription>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Badge tone={toneForStatus(board.terminalStatus)} className="uppercase">
              {board.terminalStatus}
            </Badge>
            <Badge tone="violet" className="font-mono">
              {board.totalLlm} LLM
            </Badge>
            <Badge tone="signal" className="font-mono">
              {board.totalTools} tools
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-4">
        <div className="grid gap-3 xl:grid-cols-3">
          {board.topCards.map((card) => (
            <TopCard key={card.id} card={card} />
          ))}
        </div>

        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
          {board.stages.map((node) => (
            <StageCard key={node.id} node={node} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
