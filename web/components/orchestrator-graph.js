"use client";

import { useEffect, useState } from "react";
import {
  Bot,
  CheckCircle2,
  Code2,
  FileJson,
  Info,
  Loader2,
  MousePointerClick,
  Route,
  ScanSearch,
  XCircle,
} from "lucide-react";

import { buildStageView, getRunTerminalState, normalizeTraceEvents, STAGE_LABELS } from "@/lib/run-trace";
import { getContextWindow, loadPricing } from "@/lib/pricing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatTime, formatTimestamp, parseTimestamp } from "@/lib/datetime";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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

function formatNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(number);
}

function compactDuration(seconds) {
  const value = Number(seconds || 0);
  if (!value) return "";
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`;
}

function outputEvidence(rawOutput, agentType) {
  const payload = rawOutput && typeof rawOutput === "object" ? rawOutput : {};
  const type = String(agentType || "").toLowerCase();
  if (type.includes("landing")) {
    return (Array.isArray(payload.hosting_pages) ? payload.hosting_pages : [])
      .map((item) => (typeof item === "string" ? item : item?.url || ""))
      .filter(Boolean)
      .slice(0, 5);
  }
  if (type.includes("hosting") || type.includes("embedded")) {
    return (Array.isArray(payload.servers) ? payload.servers : [])
      .slice(0, 5)
      .map((server, index) => {
        const label = server?.label || server?.name || `server ${index + 1}`;
        const state = server?.status || server?.player_state || (server?.server_up ? "up" : "unknown");
        const streamCount = [
          ...(Array.isArray(server?.stream_urls) ? server.stream_urls : []),
          ...(Array.isArray(server?.m3u8_urls) ? server.m3u8_urls : []),
          ...(Array.isArray(server?.mpd_urls) ? server.mpd_urls : []),
          ...(Array.isArray(server?.mp4_urls) ? server.mp4_urls : []),
        ].filter(Boolean).length;
        return `${label} | ${state}${streamCount ? ` | streams ${streamCount}` : ""}`;
      });
  }
  return [];
}

function stringifyPreview(value, max = 900) {
  if (!value) return "";
  try {
    return cleanInlineText(JSON.stringify(value, null, 2)).slice(0, max);
  } catch {
    return cleanInlineText(value).slice(0, max);
  }
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

function buildBoard(events, rootActor, agentRollups = [], pricingMap = null, primaryProvider = "", primaryModel = "") {
  const normalized = normalizeTraceEvents(events);
  const stageView = buildStageView(normalized);
  const terminalState = getRunTerminalState(normalized);
  const stageMap = new Map(stageView.stages.map((stage) => [stage.stage, stage]));
  const rollups = Array.isArray(agentRollups) ? agentRollups : [];
  const rollupStages = new Set(
    rollups.map((row) => String(row?.agent_type || row?.actor || "").trim().toLowerCase()).filter(Boolean),
  );
  const eventsByAgentRunId = new Map();
  for (const event of normalized) {
    const agentRunId = Number(event?.agent_run_id || event?.details?.agent_run_id || 0);
    if (agentRunId > 0) {
      if (!eventsByAgentRunId.has(agentRunId)) eventsByAgentRunId.set(agentRunId, []);
      eventsByAgentRunId.get(agentRunId).push(event);
    }
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
      meta: pipelineStarted?.timestamp ? formatTime(pipelineStarted.timestamp) : "",
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
      meta: runtimeReady?.timestamp ? formatTime(runtimeReady.timestamp) : "",
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

  const stageNodeFrom = (stage, rollup = null) => {
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
    const invocationIndex = Number(rollup?.invocation_index || 0);
    const agentRunId = Number(rollup?.agent_run_id || 0);
    const stageEvents = rollup
      ? (
          eventsByAgentRunId.get(agentRunId) ||
          (view.events || []).filter((event) => {
            const eventInvocation = Number(event?.invocation_index || event?.details?.invocation_index || 0);
            const actor = String(event?.actor || "").toLowerCase();
            return actor === String(rollup?.actor || "").toLowerCase() &&
              (!invocationIndex || !eventInvocation || eventInvocation === invocationIndex);
          })
        )
      : (view.events || []);
    const latest = latestEvent(stageEvents, () => true);
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

    const rawOutput = rollup?.raw_output || {};
    const modelName = rollup?.model_name || latestModelEvent?.details?.model_name || primaryModel;
    const providerName = rollup?.provider || latestModelEvent?.details?.provider || primaryProvider;
    const contextWindow = Number(rollup?.context_window || latestModelEvent?.details?.context_window || 0) ||
      getContextWindow(providerName, modelName, [], pricingMap);
    const contextTokens = Number(rollup?.context_tokens || latestModelEvent?.details?.context_tokens || latestModelEvent?.details?.input_tokens || 0);
    const contextPct = Number(rollup?.context_usage_pct || latestModelEvent?.details?.context_usage_pct || (contextWindow > 0 ? contextTokens / contextWindow : 0));
    const outputSummary = cleanInlineText(rollup?.output_summary || "");
    const evidenceRows = outputEvidence(rawOutput, rollup?.agent_type || stage);

    return {
      id: rollup ? `rollup-${agentRunId || rollup.actor}-${invocationIndex}` : stage,
      agentRunId,
      actor: rollup?.actor || stage,
      invocationIndex,
      stage,
      label: STAGE_LABELS[stage] || stage,
      status: rollup?.status || view.status || "idle",
      liveLabel: rollup?.status || view.liveLabel || view.status || "idle",
      accent: stageColor(stage),
      providerModel: cleanInlineText(
        `${providerName || ""} ${modelName || ""}`,
      ),
      detail: cleanInlineText(
        latest?.message || outputSummary || "",
        view.status === "idle" ? "No stage activity recorded." : "Stage activity recorded.",
      ),
      outputSummary,
      rawOutput,
      evidenceRows,
      contextWindow,
      contextTokens,
      contextPct,
      durationSeconds: Number(rollup?.duration_seconds || 0),
      llmAttempts: Number(rollup?.llm_calls || rollup?.llm_calls_made || llmAttempts || 0),
      toolCount: Number(rollup?.tool_calls || rollup?.tool_calls_made || (view.toolCalls || []).length || 0),
      frameCount: (view.frames || []).length,
      recentMilestones,
    };
  };

  const stages = [
    ...rollups.map((rollup) => {
      const stage = String(rollup?.agent_type || rollup?.actor || "agent").trim().toLowerCase();
      return stageNodeFrom(stage, rollup);
    }),
    ...AGENT_STAGES
      .filter((stage) => !rollupStages.has(stage))
      .map((stage) => stageNodeFrom(stage, null)),
  ];

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

function AgentHoverDetails({ node }) {
  const outputPreview = stringifyPreview(node.rawOutput);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 w-8 items-center justify-center rounded-xl border text-muted-foreground transition hover:text-foreground"
          aria-label={`${node.actor || node.label} details`}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" align="start" className="max-w-[440px] p-3 text-[11px]">
        <div className="flex flex-col gap-2">
          <div>
            <div className="text-xs font-semibold text-foreground">{node.actor || node.label}</div>
            <div className="mt-0.5 text-muted-foreground">
              {node.label}{node.invocationIndex > 0 ? ` #${node.invocationIndex}` : ""} · {node.liveLabel}
            </div>
          </div>
          <div className="grid gap-1 rounded-md border border-border bg-background/70 p-2 font-mono">
            <div>agent_run_id: {node.agentRunId || "not persisted"}</div>
            <div>model: {node.providerModel || "not reported"}</div>
            <div>
              context: {node.contextWindow > 0
                ? `${formatNumber(node.contextTokens)} / ${formatNumber(node.contextWindow)} (${(Math.max(0, Math.min(1, node.contextPct)) * 100).toFixed(1)}%)`
                : "not reported"}
            </div>
            <div>llm_calls: {formatNumber(node.llmAttempts)}</div>
            <div>tool_calls: {formatNumber(node.toolCount)}</div>
            {node.durationSeconds > 0 ? <div>duration: {compactDuration(node.durationSeconds)}</div> : null}
          </div>
          {node.outputSummary || node.evidenceRows.length || outputPreview ? (
            <div className="rounded-md border border-border bg-background/70 p-2">
              <div className="mb-1 font-semibold text-foreground">Output</div>
              {node.outputSummary ? <div className="leading-relaxed text-muted-foreground">{node.outputSummary}</div> : null}
              {node.evidenceRows.length ? (
                <div className="mt-2 grid gap-1">
                  {node.evidenceRows.map((item, index) => (
                    <div key={`${item}-${index}`} className="truncate font-mono text-muted-foreground">{item}</div>
                  ))}
                </div>
              ) : null}
              {!node.outputSummary && !node.evidenceRows.length && outputPreview ? (
                <pre className="max-h-48 overflow-hidden whitespace-pre-wrap font-mono text-[10px] text-muted-foreground">
                  {outputPreview}
                </pre>
              ) : null}
            </div>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function OutputHoverDetails({ node }) {
  const preview = stringifyPreview(node.rawOutput);
  if (!node.outputSummary && !node.evidenceRows.length && !preview) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium text-muted-foreground transition hover:text-foreground">
          <FileJson className="h-3 w-3" />
          output
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[520px] p-3 text-[11px]">
        <div className="flex flex-col gap-2">
          {node.outputSummary ? <div className="leading-relaxed text-muted-foreground">{node.outputSummary}</div> : null}
          {node.evidenceRows.length ? (
            <div className="grid gap-1 rounded-md border border-border bg-background/70 p-2">
              {node.evidenceRows.map((item, index) => (
                <div key={`${item}-${index}`} className="truncate font-mono text-muted-foreground">{item}</div>
              ))}
            </div>
          ) : null}
          {preview ? (
            <pre className="max-h-56 overflow-hidden whitespace-pre-wrap rounded-md border border-border bg-background/70 p-2 font-mono text-[10px] text-muted-foreground">
              {preview}
            </pre>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
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
            {node.invocationIndex > 0 ? (
              <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                #{node.invocationIndex}
              </span>
            ) : null}
            <Badge tone={toneForStatus(node.status)} className="uppercase">
              {node.liveLabel}
            </Badge>
          </div>
          {node.actor && node.actor !== node.stage ? (
            <div className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground">{node.actor}</div>
          ) : null}
          {node.providerModel ? (
            <div className="mt-2 font-mono text-[10.5px] text-muted-foreground">{node.providerModel}</div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <AgentHoverDetails node={node} />
          <span
            className="flex h-9 w-9 items-center justify-center rounded-xl"
            style={{ background: `color-mix(in oklch, ${node.accent} 16%, transparent)`, color: node.accent }}
          >
            {statusIcon(node.status, ScanSearch)}
          </span>
        </div>
      </div>

      <div className="mt-3 text-[12px] leading-relaxed text-foreground/90">{node.detail}</div>

      <div className="mt-3 rounded-[13px] border border-border/70 bg-background/55 px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Context window
            </div>
            <div className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground">
              {node.providerModel || "model not reported"}
            </div>
          </div>
          <div className="font-mono text-[12px] font-semibold text-foreground">
            {node.contextWindow > 0
              ? `${formatNumber(node.contextTokens)} / ${formatNumber(node.contextWindow)}`
              : "not reported"}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full"
              style={{
                width: node.contextWindow > 0 ? `${Math.max(0, Math.min(1, node.contextPct)) * 100}%` : "0%",
                background: node.contextPct >= 0.85 ? "var(--rose)" : node.contextPct >= 0.6 ? "var(--signal)" : node.accent,
              }}
            />
          </div>
          <div className="w-14 text-right font-mono text-[10px] text-muted-foreground">
            {node.contextWindow > 0
              ? `${(Math.max(0, Math.min(1, node.contextPct)) * 100).toFixed(1)}%`
              : "--"}
          </div>
        </div>
      </div>

      {node.outputSummary && node.outputSummary !== node.detail ? (
        <div className="mt-2 flex items-start gap-2 rounded-[12px] border border-border/70 bg-background/50 px-3 py-2 text-[11px] text-muted-foreground">
          <div className="min-w-0 flex-1">{node.outputSummary}</div>
          <OutputHoverDetails node={node} />
        </div>
      ) : null}

      {node.evidenceRows.length ? (
        <div className="mt-2 rounded-[12px] border border-border/70 bg-background/50 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Output evidence
            </div>
            {!node.outputSummary ? <OutputHoverDetails node={node} /> : null}
          </div>
          <div className="mt-2 grid gap-1">
            {node.evidenceRows.map((item, index) => (
              <div key={`${item}-${index}`} className="truncate font-mono text-[10.5px] text-muted-foreground" title={item}>
                {item}
              </div>
            ))}
          </div>
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

export function OrchestratorGraph({
  events = [],
  rootActor = "orchestrator",
  agentRollups = [],
  primaryProvider = "",
  primaryModel = "",
}) {
  const [pricingMap, setPricingMap] = useState(null);

  useEffect(() => {
    let alive = true;
    loadPricing().then((map) => {
      if (alive) setPricingMap(map);
    });
    return () => {
      alive = false;
    };
  }, []);

  const board = buildBoard(events, rootActor, agentRollups, pricingMap, primaryProvider, primaryModel);

  return (
    <TooltipProvider>
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
    </TooltipProvider>
  );
}
