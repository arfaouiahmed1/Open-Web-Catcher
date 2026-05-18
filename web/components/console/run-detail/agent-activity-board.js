"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Clock3, Coins, Cpu, Route, Wrench } from "lucide-react";

import { getContextWindow, loadPricing, peakContextUsage } from "@/lib/pricing";
import { actorToStage, STAGE_LABELS, STAGE_ORDER } from "@/lib/run-trace";
import { buildLlmRows } from "@/lib/llm-output-rows";
import { statusLabel, statusTone } from "@/lib/run-status";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const EMPTY_ARRAY = [];

function stageColor(stage) {
  if (stage === "classification") return "var(--sky)";
  if (stage === "landing") return "var(--violet)";
  if (stage === "hosting") return "var(--mint)";
  if (stage === "embedded") return "var(--signal)";
  if (stage === "orchestrator") return "var(--ink)";
  return "var(--mute-2)";
}

function compactDuration(seconds) {
  const value = Number(seconds || 0);
  if (!value) return "--";
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`;
}

function trimText(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function safeLower(value) {
  return String(value || "").trim().toLowerCase();
}

function metricTone(value) {
  if (value >= 0.85) return "var(--rose)";
  if (value >= 0.6) return "var(--signal)";
  return "var(--mint)";
}

function summarizeAgentFocus(event, fallbackUrl = "") {
  if (!event) {
    return {
      title: "Waiting for work",
      detail: fallbackUrl ? `No events yet for ${fallbackUrl}` : "No events recorded yet.",
      icon: Activity,
    };
  }

  const details = event.details || {};
  const actor = String(event.actor || "agent");
  const pageType = details.page_type || details.next_node || "";
  const targetUrl = details.url || details.target_url || fallbackUrl || "";
  const toolName =
    details.tool_name ||
    details.name ||
    details.profile ||
    details.tool ||
    "";

  switch (event.kind) {
    case "pipeline_started":
      return {
        title: "Run started",
        detail: targetUrl ? `Tracking ${targetUrl}` : event.message,
        icon: Activity,
      };
    case "orchestrator_decision":
      return {
        title: pageType ? `Routing toward ${pageType}` : "Evaluating route",
        detail: trimText(details.reason || details.reasoning_preview || event.message, 220),
        icon: Route,
      };
    case "orchestrator_handoff_received":
      return {
        title: "Received handoff",
        detail: trimText(details.handoff_preview || event.message, 220),
        icon: Route,
      };
    case "agent_started":
      return {
        title: `${actor} started`,
        detail: targetUrl ? `Working on ${targetUrl}` : trimText(event.message, 220),
        icon: Activity,
      };
    case "memory_loaded":
      return {
        title: "Memory hints loaded",
        detail: trimText(details.hint_preview || event.message, 220),
        icon: Activity,
      };
    case "prompt_compiled":
      return {
        title: "Prompt compiled",
        detail: details.static_cache_hit
          ? "Static prompt cache hit. Ready for the next model or tool step."
          : trimText(event.message, 220),
        icon: Cpu,
      };
    case "tool_session_connecting":
      return {
        title: "Connecting tool session",
        detail: toolName
          ? `Opening MCP profile ${toolName}`
          : trimText(event.message, 220),
        icon: Wrench,
      };
    case "tool_call_started":
      return {
        title: "Running tool call",
        detail: toolName ? `${toolName} is in progress.` : trimText(event.message, 220),
        icon: Wrench,
      };
    case "tool_call_finished":
      return {
        title: "Tool call finished",
        detail: toolName ? `${toolName} returned.` : trimText(event.message, 220),
        icon: Wrench,
      };
    case "llm_response":
      return {
        title: "Model responded",
        detail: trimText(details.content_preview || event.message, 220) || "Response captured.",
        icon: Cpu,
      };
    case "llm_error":
    case "llm_timeout":
    case "llm_rate_limited":
      return {
        title: "Model issue detected",
        detail: trimText(details.error_preview || details.error || event.message, 220),
        icon: Cpu,
      };
    case "agent_finished":
      return {
        title: pageType ? `Returned ${pageType}` : "Agent finished",
        detail: trimText(event.message, 220),
        icon: Activity,
      };
    default:
      return {
        title: trimText(event.message || event.kind || "Agent activity", 80),
        detail: trimText(event.message || "", 220),
        icon: Activity,
      };
  }
}

function eventSummaryLine(event) {
  if (!event) return "";
  const details = event.details || {};
  if (event.kind === "prompt_compiled") {
    if (details.memory_injected) return "prompt compiled with site memory";
    return details.static_cache_hit ? "prompt compiled with cache hit" : "prompt compiled";
  }
  if (event.kind === "memory_loaded") {
    const hintCount = Number(details.hint_count || details.memory_count || 0);
    return hintCount > 0 ? `${formatNumber(hintCount)} memory hints loaded` : "memory hints loaded";
  }
  if (event.kind === "tool_session_connecting") {
    return details.profile ? `connecting ${details.profile}` : "connecting tools";
  }
  if (event.kind === "orchestrator_decision") {
    return details.next_node
      ? `route -> ${details.next_node}`
      : trimText(details.reason || event.message, 80);
  }
  if (event.kind === "agent_finished" && details.page_type) {
    return `returned ${details.page_type}`;
  }
  return trimText(event.message || event.kind || "", 80);
}

function ActorMetric({ label, value, tone = "var(--ink)" }) {
  return (
    <div
      className="rounded-[12px] border px-3 py-2.5"
      style={{
        borderColor: "var(--line)",
        background: "color-mix(in oklch, var(--card) 92%, transparent)",
      }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
        {label}
      </div>
      <div className="mt-1 font-mono text-[12px] font-medium" style={{ color: tone }}>
        {value}
      </div>
    </div>
  );
}

export function AgentActivityBoard({
  agentRollups = EMPTY_ARRAY,
  events = EMPTY_ARRAY,
  runUrl = "",
  primaryModel = "",
  primaryProvider = "",
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

  const llmRows = useMemo(() => buildLlmRows(events), [events]);

  const cards = useMemo(() => {
    const eventGroups = new Map();
    for (const event of Array.isArray(events) ? events : EMPTY_ARRAY) {
      const actor = String(event?.actor || "").trim();
      if (!actor) continue;
      if (!eventGroups.has(actor)) eventGroups.set(actor, []);
      eventGroups.get(actor).push(event);
    }

    const rollups = Array.isArray(agentRollups) ? agentRollups : EMPTY_ARRAY;
    const actorList = Array.from(
      new Set([
        ...rollups.map((row) => String(row?.actor || "").trim()).filter(Boolean),
        ...eventGroups.keys(),
      ]),
    );

    return actorList
      .map((actor) => {
        const actorEvents = eventGroups.get(actor) || EMPTY_ARRAY;
        const actorRollup =
          [...rollups]
            .reverse()
            .find((row) => safeLower(row?.actor) === safeLower(actor)) || null;
        const actorLlmRows = llmRows.filter((row) => safeLower(row.actor) === safeLower(actor));
        const latestEvent = actorEvents[actorEvents.length - 1] || null;
        const recentEvents = actorEvents.slice(-3).reverse();
        const memoryEvents = actorEvents.filter((event) => event.kind === "memory_loaded");
        const promptEvents = actorEvents.filter((event) => event.kind === "prompt_compiled");
        const memoryInjected = promptEvents.some((event) => Boolean(event.details?.memory_injected));
        const latestMemoryEvent = memoryEvents[memoryEvents.length - 1] || null;
        const stage =
          actorToStage(actor) ||
          safeLower(actorRollup?.agent_type) ||
          safeLower(actor);
        const stageIndex = STAGE_ORDER.indexOf(stage);
        const peak = peakContextUsage(actorLlmRows, pricingMap);
        const contextWindow =
          peak.contextWindow ||
          getContextWindow(
            peak.provider || primaryProvider,
            peak.model || primaryModel,
            actorLlmRows,
            pricingMap,
          );
        const contextPct = contextWindow > 0 ? peak.tokens / contextWindow : 0;
        const focus = summarizeAgentFocus(latestEvent, runUrl);

        return {
          actor,
          stage,
          stageLabel: STAGE_LABELS[stage] || actorRollup?.agent_type || actor,
          stageIndex: stageIndex >= 0 ? stageIndex : STAGE_ORDER.length + 1,
          invocationIndex: Number(actorRollup?.invocation_index || 0),
          status: actorRollup?.status || latestEvent?.status || "pending",
          latestEvent,
          recentEvents,
          focus,
          llmCalls: Number(actorRollup?.llm_calls || actorRollup?.llm_calls_made || actorLlmRows.length || 0),
          toolCalls: Number(actorRollup?.tool_calls || actorRollup?.tool_calls_made || 0),
          totalTokens: Number(actorRollup?.total_tokens || 0),
          costUsd: Number(actorRollup?.cost_usd || 0),
          durationSeconds: Number(actorRollup?.duration_seconds || 0),
          contextWindow,
          contextTokens: Number(peak.tokens || 0),
          contextPct,
          contextModel: peak.model || actorLlmRows[actorLlmRows.length - 1]?.model || actorRollup?.model_name || "",
          outputSummary: trimText(actorRollup?.output_summary || "", 180),
          memoryEvents: memoryEvents.length,
          memoryInjected,
          memoryPreview: trimText(
            latestMemoryEvent?.details?.hint_preview ||
              latestMemoryEvent?.details?.summary ||
              latestMemoryEvent?.message ||
              "",
            180,
          ),
          latestTimestamp: latestEvent?.timestamp || actorRollup?.finished_at || actorRollup?.started_at || "",
        };
      })
      .sort((a, b) => {
        const stageDelta = a.stageIndex - b.stageIndex;
        if (stageDelta !== 0) return stageDelta;
        const invocationDelta = a.invocationIndex - b.invocationIndex;
        if (invocationDelta !== 0) return invocationDelta;
        return a.actor.localeCompare(b.actor);
      });
  }, [agentRollups, events, llmRows, pricingMap, primaryModel, primaryProvider, runUrl]);

  if (!cards.length) return null;

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader
        className="border-b px-4 py-4"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in oklch, var(--signal) 8%, transparent), transparent 76%)",
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-medium">Agent desk</CardTitle>
            <CardDescription className="mt-1 text-[12px]">
              Current focus, last milestones, context use, and estimated spend per agent.
            </CardDescription>
          </div>
          <Badge tone="signal">{cards.length} active actors</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 p-4 xl:grid-cols-2">
        {cards.map((card) => {
          const color = stageColor(card.stage);
          const FocusIcon = card.focus.icon;
          const contextTone = metricTone(card.contextPct);
          return (
            <div
              key={`${card.actor}-${card.invocationIndex}`}
              className="rounded-[18px] border p-4"
              style={{
                borderColor: `color-mix(in oklch, ${color} 22%, var(--line))`,
                background:
                  `linear-gradient(180deg, color-mix(in oklch, ${color} 9%, transparent), color-mix(in oklch, var(--card) 94%, transparent) 42%)`,
              }}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.14em]" style={{ color }}>
                      {card.stageLabel}
                    </div>
                    {card.invocationIndex > 0 ? (
                      <span className="rounded-full border px-2 py-0.5 font-mono text-[10px]" style={{ borderColor: "var(--line)", color: "var(--mute-2)" }}>
                        #{card.invocationIndex}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <div className="text-[16px] font-semibold" style={{ color: "var(--ink)" }}>
                      {card.actor}
                    </div>
                    <Badge tone={statusTone(card.status)}>{statusLabel(card.status)}</Badge>
                    {card.memoryInjected || card.memoryEvents > 0 ? (
                      <Badge tone="default">
                        {card.memoryEvents > 0 ? `memory ${formatNumber(card.memoryEvents)}` : "memory injected"}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                {card.latestTimestamp ? (
                  <div className="text-right text-[10px]" style={{ color: "var(--mute-3)" }}>
                    <div>last update</div>
                    <div className="mt-1 font-mono">
                      {new Date(card.latestTimestamp).toLocaleTimeString()}
                    </div>
                  </div>
                ) : null}
              </div>

              <div
                className="mt-4 rounded-[14px] border px-3 py-3"
                style={{
                  borderColor: `color-mix(in oklch, ${color} 18%, transparent)`,
                  background: "color-mix(in oklch, var(--bg) 76%, transparent)",
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="flex h-7 w-7 items-center justify-center rounded-full"
                    style={{
                      background: `color-mix(in oklch, ${color} 16%, transparent)`,
                      color,
                    }}
                  >
                    <FocusIcon className="h-3.5 w-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
                      Current activity
                    </div>
                    <div className="mt-1 text-[13px] font-medium" style={{ color: "var(--ink)" }}>
                      {card.focus.title}
                    </div>
                  </div>
                </div>
                <div className="mt-2 text-[12px] leading-relaxed" style={{ color: "var(--mute)" }}>
                  {card.focus.detail || "No detail available."}
                </div>
              </div>

              {card.memoryPreview ? (
                <div
                  className="mt-3 rounded-[12px] border px-3 py-2.5"
                  style={{
                    borderColor: "var(--line)",
                    background: "color-mix(in oklch, var(--card) 92%, transparent)",
                  }}
                >
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
                    Site memory used
                  </div>
                  <div className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--mute)" }}>
                    {card.memoryPreview}
                  </div>
                </div>
              ) : null}

              <div className="mt-4 grid gap-2 sm:grid-cols-3 xl:grid-cols-6">
                <ActorMetric label="LLM" value={formatNumber(card.llmCalls)} tone="var(--violet)" />
                <ActorMetric label="Tools" value={formatNumber(card.toolCalls)} tone="var(--signal)" />
                <ActorMetric label="Tokens" value={formatNumber(card.totalTokens)} tone="var(--ink)" />
                <ActorMetric label="Cost" value={formatCurrency(card.costUsd)} tone="var(--mint)" />
                <ActorMetric label="Duration" value={compactDuration(card.durationSeconds)} tone="var(--ink)" />
                <ActorMetric
                  label="Context"
                  value={
                    card.contextWindow > 0
                      ? `${formatNumber(card.contextTokens)} / ${formatNumber(card.contextWindow)}`
                      : "not used yet"
                  }
                  tone={card.contextWindow > 0 ? contextTone : "var(--mute-2)"}
                />
              </div>

              {card.contextWindow > 0 ? (
                <div className="mt-3">
                  <div className="flex items-center justify-between gap-2 text-[10px]" style={{ color: "var(--mute-3)" }}>
                    <span className="truncate">{card.contextModel || "context window"}</span>
                    <span>{(Math.max(0, Math.min(1, card.contextPct)) * 100).toFixed(1)}% used</span>
                  </div>
                  <div className="mt-1.5 h-2 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(0, Math.min(1, card.contextPct)) * 100}%`,
                        background: contextTone,
                      }}
                    />
                  </div>
                </div>
              ) : null}

              {card.recentEvents.length ? (
                <div className="mt-4 space-y-2 border-t pt-3" style={{ borderColor: "var(--line)" }}>
                  <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
                    <Clock3 className="h-3.5 w-3.5" />
                    Recent milestones
                  </div>
                  {card.recentEvents.map((event, index) => {
                    const iconColor =
                      event.kind?.includes("llm")
                        ? "var(--violet)"
                        : event.kind?.includes("tool")
                          ? "var(--signal)"
                          : event.kind?.includes("decision")
                            ? "var(--mint)"
                            : color;
                    const Icon =
                      event.kind?.includes("llm")
                        ? Cpu
                        : event.kind?.includes("tool")
                          ? Wrench
                          : event.kind?.includes("decision")
                            ? Route
                            : Activity;
                    return (
                      <div
                        key={`${card.actor}-${event.seq || event.timestamp || index}`}
                        className="flex items-start gap-2 rounded-[12px] border px-3 py-2"
                        style={{
                          borderColor: "var(--line)",
                          background: "color-mix(in oklch, var(--bg) 82%, transparent)",
                        }}
                      >
                        <span className="mt-0.5" style={{ color: iconColor }}>
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[12px] font-medium" style={{ color: "var(--ink)" }}>
                            {trimText(event.message || event.kind || "Event", 100)}
                          </div>
                          <div className="mt-0.5 text-[11px]" style={{ color: "var(--mute)" }}>
                            {eventSummaryLine(event)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {card.outputSummary ? (
                <div className="mt-4 flex items-start gap-2 rounded-[12px] border px-3 py-2.5" style={{ borderColor: "var(--line)", background: "color-mix(in oklch, var(--card) 92%, transparent)" }}>
                  <Coins className="mt-0.5 h-3.5 w-3.5" style={{ color: "var(--mute-3)" }} />
                  <div className="text-[12px]" style={{ color: "var(--mute)" }}>
                    {card.outputSummary}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

