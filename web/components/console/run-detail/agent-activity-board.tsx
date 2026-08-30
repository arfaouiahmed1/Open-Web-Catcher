/* eslint-disable */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Clock3, Coins, Cpu, FileJson, Info, Route, Wrench } from "lucide-react";

import { getContextWindow, loadPricing, peakContextUsage } from "@/lib/pricing";
import { actorToStage, STAGE_LABELS, STAGE_ORDER } from "@/lib/run-trace";
import { buildLlmRows } from "@/lib/llm-output-rows";
import { statusLabel, statusTone } from "@/lib/run-status";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDate, formatTime, formatTimestamp, parseTimestamp } from "@/lib/datetime";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const EMPTY_ARRAY: any[] = [];

function stageColor(stage: any) {
  if (stage === "classification") return "var(--sky)";
  if (stage === "landing") return "var(--violet)";
  if (stage === "hosting") return "var(--mint)";
  if (stage === "embedded") return "var(--signal)";
  if (stage === "orchestrator") return "var(--ink)";
  return "var(--mute-2)";
}

function compactDuration(seconds: any) {
  const value = Number(seconds || 0);
  if (!value) return "--";
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`;
}

function trimText(value: any, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function safeLower(value: any) {
  return String(value || "").trim().toLowerCase();
}

function metricTone(value: any) {
  if (value >= 0.85) return "var(--rose)";
  if (value >= 0.6) return "var(--signal)";
  return "var(--mint)";
}

function firstNumber(...values: any[]) {
  for (const value of values) {
    const number = Number(value || 0);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function firstText(...values: any[]) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function latestEventContext(events = EMPTY_ARRAY) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] || {};
    const details = event.details || {};
    const contextWindow = Number(details.context_window || 0);
    const contextTokens = Number(details.context_tokens || details.input_tokens || 0);
    if (contextWindow > 0 || contextTokens > 0) {
      return {
        contextWindow,
        contextTokens,
        contextUsagePct: Number(details.context_usage_pct || 0),
        model: firstText(details.model_name, details.model),
        provider: firstText(details.provider),
      };
    }
  }
  return {
    contextWindow: 0,
    contextTokens: 0,
    contextUsagePct: 0,
    model: "",
    provider: "",
  };
}

function stringifyPreview(value: any, max = 900) {
  if (!value) return "";
  try {
    return trimText(JSON.stringify(value, null, 2), max);
  } catch {
    return trimText(String(value), max);
  }
}

function outputEvidence(rawOutput: any, agentType: any) {
  const payload = rawOutput && typeof rawOutput === "object" ? rawOutput : {};
  const type = safeLower(agentType);
  if (type.includes("landing")) {
    return (Array.isArray(payload.hosting_pages) ? payload.hosting_pages : [])
      .map((item: any) => (typeof item === "string" ? item : item?.url || ""))
      .filter(Boolean)
      .slice(0, 5);
  }
  if (type.includes("hosting") || type.includes("embedded")) {
    return (Array.isArray(payload.servers) ? payload.servers : [])
      .slice(0, 5)
      .map((server: any, index: any) => {
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

function summarizeAgentFocus(event: any, fallbackUrl = "") {
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

function eventSummaryLine(event: any) {
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

function ActorMetric({  label, value, tone = "var(--ink)"  }: any) {
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

function DetailLine({  label, value  }: any) {
  if (value === "" || value === null || value === undefined) return null;
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono">{value}</span>
    </div>
  );
}

function AgentDetailTooltip({  card, color  }: any) {
  const outputPreview = stringifyPreview(card.rawOutput, 1000);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-full border text-muted-foreground transition hover:text-foreground"
          style={{ borderColor: `color-mix(in oklch, ${color} 24%, var(--line))` }}
          aria-label={`${card.actor} details`}
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left" align="start" className="max-w-[420px] p-3 text-[11px]">
        <div className="flex flex-col gap-2">
          <div>
            <div className="text-xs font-semibold text-foreground">{card.actor}</div>
            <div className="mt-0.5 text-muted-foreground">
              {card.stageLabel}{card.invocationIndex > 0 ? ` #${card.invocationIndex}` : ""} · {statusLabel(card.status)}
            </div>
          </div>
          <div className="grid gap-1 rounded-md border border-border bg-background/70 p-2">
            <DetailLine label="Agent run" value={card.agentRunId || "live only"} />
            <DetailLine label="Model" value={card.contextModel || "not reported"} />
            <DetailLine label="Provider" value={card.contextProvider || "not reported"} />
            <DetailLine
              label="Context"
              value={
                card.contextWindow > 0
                  ? `${formatNumber(card.contextTokens)} / ${formatNumber(card.contextWindow)} (${(Math.max(0, Math.min(1, card.contextPct)) * 100).toFixed(1)}%)`
                  : "not reported"
              }
            />
            <DetailLine label="LLM calls" value={formatNumber(card.llmCalls)} />
            <DetailLine label="Tool calls" value={formatNumber(card.toolCalls)} />
            <DetailLine label="Duration" value={compactDuration(card.durationSeconds)} />
          </div>
          {card.focus.detail ? (
            <div className="rounded-md border border-border bg-background/70 p-2 leading-relaxed text-muted-foreground">
              {card.focus.detail}
            </div>
          ) : null}
          {card.outputSummary || card.evidenceRows.length || outputPreview ? (
            <div className="rounded-md border border-border bg-background/70 p-2">
              <div className="mb-1 font-semibold text-foreground">Output</div>
              {card.outputSummary ? <div className="leading-relaxed text-muted-foreground">{card.outputSummary}</div> : null}
              {card.evidenceRows.length ? (
                <div className="mt-2 grid gap-1">
                  {card.evidenceRows.map((item: any, index: any) => (
                    <div key={`${item}-${index}`} className="truncate font-mono text-muted-foreground">
                      {item}
                    </div>
                  ))}
                </div>
              ) : null}
              {!card.outputSummary && !card.evidenceRows.length && outputPreview ? (
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

function OutputTooltip({  card  }: any) {
  const preview = stringifyPreview(card.rawOutput, 1000);
  if (!card.outputSummary && !card.evidenceRows.length && !preview) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium text-muted-foreground transition hover:text-foreground">
          <FileJson className="h-3 w-3" />
          Output details
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[520px] p-3 text-[11px]">
        <div className="flex flex-col gap-2">
          {card.outputSummary ? <div className="leading-relaxed text-muted-foreground">{card.outputSummary}</div> : null}
          {card.evidenceRows.length ? (
            <div className="grid gap-1 rounded-md border border-border bg-background/70 p-2">
              {card.evidenceRows.map((item: any, index: any) => (
                <div key={`${item}-${index}`} className="truncate font-mono text-muted-foreground">
                  {item}
                </div>
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

export function AgentActivityBoard({ 
  agentRollups = EMPTY_ARRAY,
  events = EMPTY_ARRAY,
  runUrl = "",
  primaryModel = "",
  primaryProvider = "",
 }: any) {
  const [pricingMap, setPricingMap] = useState<any>(null);

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
    const eventGroupsByAgentRunId = new Map();
    for (const event of Array.isArray(events) ? events : EMPTY_ARRAY) {
      const actor = String(event?.actor || "").trim();
      if (!actor) continue;
      if (!eventGroups.has(actor)) eventGroups.set(actor, []);
      eventGroups.get(actor).push(event);
      const agentRunId = Number(event?.agent_run_id || event?.details?.agent_run_id || 0);
      if (agentRunId > 0) {
        if (!eventGroupsByAgentRunId.has(agentRunId)) eventGroupsByAgentRunId.set(agentRunId, []);
        eventGroupsByAgentRunId.get(agentRunId).push(event);
      }
    }

    const rollups = Array.isArray(agentRollups) ? agentRollups : EMPTY_ARRAY;
    const rollupActorKeys = new Set(rollups.map((row) => safeLower(row?.actor)).filter(Boolean));
    const workItems = [
      ...rollups.map((row) => {
        const actor = String(row?.actor || row?.agent_type || "agent").trim();
        const agentRunId = Number(row?.agent_run_id || 0);
        const invocationIndex = Number(row?.invocation_index || 0);
        const actorEvents =
          (agentRunId > 0 ? eventGroupsByAgentRunId.get(agentRunId) : null) ||
          (eventGroups.get(actor) || EMPTY_ARRAY).filter((event: any) => {
            const eventInvocation = Number(event?.invocation_index || event?.details?.invocation_index || 0);
            return !invocationIndex || !eventInvocation || eventInvocation === invocationIndex;
          });
        return {
          key: `rollup-${agentRunId || actor}-${invocationIndex}`,
          actor,
          actorRollup: row,
          actorEvents,
        };
      }),
      ...Array.from(eventGroups.keys())
        .filter((actor) => !rollupActorKeys.has(safeLower(actor)))
        .map((actor) => ({
          key: `events-${actor}`,
          actor,
          actorRollup: null,
          actorEvents: eventGroups.get(actor) || EMPTY_ARRAY,
        })),
    ];

    return workItems
      .map(({  key, actor, actorRollup, actorEvents  }: any) => {
        const actorLlmRows = llmRows.filter((row) => safeLower(row.actor) === safeLower(actor));
        const latestEvent = actorEvents[actorEvents.length - 1] || null;
        const recentEvents = actorEvents.slice(-3).reverse();
        const memoryEvents = actorEvents.filter((event: any) => event.kind === "memory_loaded");
        const promptEvents = actorEvents.filter((event: any) => event.kind === "prompt_compiled");
        const memoryInjected = promptEvents.some((event: any) => Boolean(event.details?.memory_injected));
        const latestMemoryEvent = memoryEvents[memoryEvents.length - 1] || null;
        const eventContext = latestEventContext(actorEvents);
        const stage =
          actorToStage(actor) ||
          safeLower(actorRollup?.agent_type) ||
          safeLower(actor);
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        const stageIndex = STAGE_ORDER.indexOf(stage);
        const peak = peakContextUsage(actorLlmRows, pricingMap);
        const contextWindow =
          firstNumber(
            actorRollup?.context_window,
            eventContext.contextWindow,
            peak.contextWindow,
          ) ||
          getContextWindow(
            eventContext.provider || peak.provider || actorRollup?.provider || primaryProvider,
            eventContext.model || peak.model || actorRollup?.model_name || primaryModel,
            actorLlmRows,
            pricingMap,
          );
        const contextTokens = firstNumber(actorRollup?.context_tokens, eventContext.contextTokens, peak.tokens);
        const contextPct = firstNumber(actorRollup?.context_usage_pct, eventContext.contextUsagePct) ||
          (contextWindow > 0 ? contextTokens / contextWindow : 0);
        const focus = summarizeAgentFocus(latestEvent, runUrl);

        return {
          agentRunId: Number(actorRollup?.agent_run_id || 0),
          actor,
          key,
          stage,
          // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
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
          contextTokens,
          contextPct,
          contextModel: eventContext.model || peak.model || actorLlmRows[actorLlmRows.length - 1]?.model || actorRollup?.model_name || primaryModel || "",
          contextProvider: eventContext.provider || peak.provider || actorLlmRows[actorLlmRows.length - 1]?.provider || actorRollup?.provider || primaryProvider || "",
          outputSummary: trimText(actorRollup?.output_summary || "", 180),
          rawOutput: actorRollup?.raw_output || null,
          evidenceRows: outputEvidence(actorRollup?.raw_output, actorRollup?.agent_type || stage),
          continuationCount: Number(actorRollup?.raw_output?.agent_run?.continuation_count || 0),
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
    <TooltipProvider>
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
              key={card.key || `${card.actor}-${card.invocationIndex}`}
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
                    <Badge tone={statusTone(card.status) as any}>{statusLabel(card.status)}</Badge>
                    {card.memoryInjected || card.memoryEvents > 0 ? (
                      <Badge tone="default">
                        {card.memoryEvents > 0 ? `memory ${formatNumber(card.memoryEvents)}` : "memory injected"}
                      </Badge>
                    ) : null}
                    {card.continuationCount > 0 ? (
                      <Badge tone="warning">
                        {formatNumber(card.continuationCount)} continuation{card.continuationCount === 1 ? "" : "s"}
                      </Badge>
                    ) : null}
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  {card.latestTimestamp ? (
                    <div className="text-right text-[10px]" style={{ color: "var(--mute-3)" }}>
                      <div>last update</div>
                      <div className="mt-1 font-mono">
                        {formatTime(card.latestTimestamp)}
                      </div>
                    </div>
                  ) : null}
                  <AgentDetailTooltip card={card} color={color} />
                </div>
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
                      : "not reported"
                  }
                  tone={card.contextWindow > 0 ? contextTone : "var(--mute-2)"}
                />
              </div>

              <div
                className="mt-3 rounded-[14px] border px-3 py-2.5"
                style={{
                  borderColor: `color-mix(in oklch, ${contextTone} 18%, var(--line))`,
                  background: "color-mix(in oklch, var(--bg) 82%, transparent)",
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
                      Context window
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px]" style={{ color: "var(--mute)" }}>
                      {card.contextModel || "model not reported"}
                      {card.contextProvider ? ` · ${card.contextProvider}` : ""}
                    </div>
                  </div>
                  <div className="font-mono text-[12px] font-semibold" style={{ color: card.contextWindow > 0 ? contextTone : "var(--mute-2)" }}>
                    {card.contextWindow > 0
                      ? `${formatNumber(card.contextTokens)} / ${formatNumber(card.contextWindow)}`
                      : "not reported"}
                  </div>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: card.contextWindow > 0 ? `${Math.max(0, Math.min(1, card.contextPct)) * 100}%` : "0%",
                        background: card.contextWindow > 0 ? contextTone : "var(--mute-3)",
                      }}
                    />
                  </div>
                  <div className="w-14 text-right font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
                    {card.contextWindow > 0
                      ? `${(Math.max(0, Math.min(1, card.contextPct)) * 100).toFixed(1)}%`
                      : "--"}
                  </div>
                </div>
              </div>

              {card.recentEvents.length ? (
                <div className="mt-4 space-y-2 border-t pt-3" style={{ borderColor: "var(--line)" }}>
                  <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
                    <Clock3 className="h-3.5 w-3.5" />
                    Recent milestones
                  </div>
                  {card.recentEvents.map((event: any, index: any) => {
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
                  <div className="min-w-0 flex-1 text-[12px]" style={{ color: "var(--mute)" }}>
                    {card.outputSummary}
                  </div>
                  <OutputTooltip card={card} />
                </div>
              ) : null}

              {card.evidenceRows.length ? (
                <div className="mt-3 rounded-[12px] border px-3 py-2.5" style={{ borderColor: "var(--line)", background: "color-mix(in oklch, var(--card) 92%, transparent)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
                      Agent result evidence
                    </div>
                    {!card.outputSummary ? <OutputTooltip card={card} /> : null}
                  </div>
                  <div className="mt-2 grid gap-1.5">
                    {card.evidenceRows.map((item: any, index: any) => (
                      <div key={`${item}-${index}`} className="truncate font-mono text-[11px]" style={{ color: "var(--mute)" }} title={item}>
                        {item}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
    </TooltipProvider>
  );
}