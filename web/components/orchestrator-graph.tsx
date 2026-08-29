"use client";

import { useEffect, useState, memo } from "react";
import { Bot, CheckCircle2, Code2, FileJson, Info, Loader2, MousePointerClick, Route, ScanSearch, XCircle } from "lucide-react";
import { buildStageView, getRunTerminalState, normalizeTraceEvents, STAGE_LABELS } from "@/lib/run-trace";
import { getContextWindow, loadPricing } from "@/lib/pricing";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatTime, parseTimestamp } from "@/lib/datetime";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

const AGENT_STAGES = ["classification", "landing", "hosting", "embedded"] as const;

function toneForStatus(status: string): "success" | "signal" | "danger" | "warning" | "default" {
  if (status === "done" || status === "success" || status === "completed") return "success";
  if (status === "running" || status === "active") return "signal";
  if (status === "failed" || status === "error") return "danger";
  if (status === "cancelled" || status === "warning" || status === "partial") return "warning";
  return "default";
}

function stageColor(stage: string): string {
  if (stage === "classification") return "var(--sky)";
  if (stage === "landing") return "var(--violet)";
  if (stage === "hosting") return "var(--mint)";
  if (stage === "embedded") return "var(--signal)";
  if (stage === "orchestrator") return "var(--signal)";
  return "var(--mute-3)";
}

function statusIcon(status: string, Icon: React.ComponentType<{ className?: string }> = Bot): React.JSX.Element {
  if (status === "running" || status === "active") return <Loader2 className="h-4 w-4 animate-spin" />;
  if (status === "done" || status === "success" || status === "completed") return <CheckCircle2 className="h-4 w-4" />;
  if (status === "failed" || status === "error") return <XCircle className="h-4 w-4" />;
  return <Icon className="h-4 w-4" />;
}

function cleanInlineText(value: unknown, fallback = ""): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}

function formatNumber(value: unknown): string {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(number);
}

function compactDuration(seconds: unknown): string {
  const value = Number(seconds || 0);
  if (!value) return "";
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`;
}

function outputEvidence(rawOutput: unknown, agentType?: string): string[] {
  const payload = (rawOutput && typeof rawOutput === "object" ? (rawOutput as Record<string, unknown>) : {}) as Record<string, unknown>;
  const type = String(agentType ?? "").toLowerCase();
  if (type.includes("landing")) {
    return ((Array.isArray(payload.hosting_pages) ? payload.hosting_pages : []) as unknown[]).map((item) => (typeof item === "string" ? item : (item as Record<string, unknown>)?.url as string ?? "")).filter(Boolean).slice(0, 5) as string[];
  }
  if (type.includes("hosting") || type.includes("embedded")) {
    return ((Array.isArray(payload.servers) ? payload.servers : []) as unknown[]).slice(0, 5).map((server, index) => {
      const s = server as Record<string, unknown>;
      const label = (s?.label as string) ?? (s?.name as string) ?? `server ${index + 1}`;
      const state = (s?.status as string) ?? (s?.player_state as string) ?? ((s?.server_up as boolean) ? "up" : "unknown");
      const streamCount = [
        ...((Array.isArray(s?.stream_urls) ? s.stream_urls : []) as unknown[]),
        ...((Array.isArray(s?.m3u8_urls) ? s.m3u8_urls : []) as unknown[]),
        ...((Array.isArray(s?.mpd_urls) ? s.mpd_urls : []) as unknown[]),
        ...((Array.isArray(s?.mp4_urls) ? s.mp4_urls : []) as unknown[]),
      ].filter(Boolean).length;
      return `${label} | ${state}${streamCount ? ` | streams ${streamCount}` : ""}`;
    });
  }
  return [];
}

function latestEvent<T>(events: T[], predicate: (e: T) => boolean): T | undefined {
  return [...events].reverse().find(predicate);
}

function firstEvent<T>(events: T[], predicate: (e: T) => boolean): T | undefined {
  return [...events].find(predicate);
}

export interface OrchestratorGraphProps {
  events?: Array<Record<string, unknown>>;
  rootActor?: string;
  agentRollups?: Array<Record<string, unknown>>;
  primaryProvider?: string;
  primaryModel?: string;
}

export const OrchestratorGraph = memo(function OrchestratorGraph({ events = [], rootActor = "orchestrator", agentRollups = [], primaryProvider = "", primaryModel = "" }: OrchestratorGraphProps): React.JSX.Element {
  type TraceEvent = Record<string, unknown> & { kind?: string; actor?: string; timestamp?: string; details?: Record<string, unknown> };
  const normalized = normalizeTraceEvents(events as never[]) as unknown as TraceEvent[];
  const stageView = buildStageView(normalized as never[]);
  const terminalState = getRunTerminalState(normalized as never[]);

  // Keep pricing load for future context-window chips
  const [, setPricing] = useState<Map<string, unknown> | null>(null);
  useEffect(() => {
    void loadPricing().then((m) => setPricing(m as Map<string, unknown>));
  }, []);

  const stageMap = new Map<string, (typeof stageView.stages)[number]>( (stageView.stages as unknown as Array<{ stage: string } & Record<string, unknown>>).map((s) => [s.stage, s as never]));

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="border-b px-4 py-3">
        <CardTitle className="text-sm">Orchestrator Graph</CardTitle>
        <CardDescription>Stage health derived from the normalized trace. New code should prefer library/StepTimeline for pure step lists.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        {AGENT_STAGES.map((stage) => {
          const entry = stageMap.get(stage) as { status?: string; liveLabel?: string; events?: unknown[] } | undefined;
          const status = (entry?.status as string) ?? "idle";
          const tone = toneForStatus(status);
          const rollup = (agentRollups as Array<Record<string, unknown>>).find((r) => String(r.agent_type ?? r.actor ?? "").toLowerCase().includes(stage));
          const evidence = rollup ? outputEvidence(rollup.raw_output as unknown, stage) : [];
          return (
            <div key={stage} className="rounded-xl border p-3" style={{ borderColor: `color-mix(in oklch, ${stageColor(stage)} 18%, transparent)`, background: `color-mix(in oklch, ${stageColor(stage)} 6%, transparent)` }}>
              <div className="flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full" style={{ background: `color-mix(in oklch, ${stageColor(stage)} 16%, transparent)`, color: stageColor(stage) }}>
                  {statusIcon(status)}
                </span>
                <span className="text-[12px] font-semibold" style={{ color: stageColor(stage) }}>{(STAGE_LABELS as Record<string, string>)[stage] ?? stage}</span>
                <Badge tone={tone} className="ml-auto text-[10px]">{status}</Badge>
              </div>
              <div className="mt-2 text-[11.5px] leading-snug text-muted-foreground line-clamp-2">{cleanInlineText(entry?.liveLabel ?? (terminalState.isTerminal ? terminalState.status : "idle"), "Waiting")}</div>
              {rollup ? (
                <div className="mt-2 flex flex-wrap gap-1.5 text-[10.5px]">
                  <span className="rounded-full border bg-background/60 px-2 py-0.5 font-mono">{formatNumber((rollup.total_tokens as number) ?? 0)} tok</span>
                  <span className="rounded-full border bg-background/60 px-2 py-0.5 font-mono">{formatNumber((rollup.cost_usd as number) ?? 0)} USD</span>
                </div>
              ) : null}
              {evidence.length ? (
                <div className="mt-2 space-y-1">
                  {evidence.map((line, i) => (
                    <div key={i} className="truncate rounded border bg-card px-1.5 py-1 font-mono text-[10px]" title={line}>{line}</div>
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
});
