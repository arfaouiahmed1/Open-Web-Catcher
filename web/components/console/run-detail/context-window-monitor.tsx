"use client";

import React, { useMemo } from "react";
import { Gauge, Cpu, Zap, Database, BrainCircuit, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface AgentContextUsage {
  agentName: string;
  role: string;
  model: string;
  contextWindow: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  usagePct: number;
  continuations: number;
}

interface ContextWindowMonitorProps {
  events?: Array<Record<string, unknown>>;
  className?: string;
}

/**
 * Extract context window and token utilization per agent from trace events.
 */
function extractContextUsage(events: Array<Record<string, unknown>> = []): AgentContextUsage[] {
  const usageByActor: Record<string, AgentContextUsage> = {};

  for (const ev of events) {
    const actor = String(ev.actor || ev.stage || "agent").trim().toLowerCase();
    const details = (ev.details || ev.details_json || {}) as Record<string, unknown>;

    if (!usageByActor[actor]) {
      usageByActor[actor] = {
        agentName: actor.replace(/_/g, " "),
        role: actor,
        model: String(details.model_name || details.model || "default"),
        contextWindow: Number(details.context_window || 128000),
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        totalTokens: 0,
        usagePct: 0,
        continuations: 0,
      };
    }

    const current = usageByActor[actor];

    if (details.model_name || details.model) {
      current.model = String(details.model_name || details.model);
    }
    if (details.context_window) {
      current.contextWindow = Number(details.context_window);
    }

    // Accumulate tokens from llm_turn_finished or agent_finished
    if (ev.kind === "llm_turn_finished" || ev.kind === "llm_call_completed" || ev.kind === "agent_loop_started") {
      const input = Number(details.input_tokens || details.prompt_tokens || 0);
      const output = Number(details.output_tokens || details.completion_tokens || 0);
      const cached = Number(details.cached_tokens || details.cached_input_tokens || 0);
      const reasoning = Number(details.reasoning_tokens || details.thought_tokens || 0);

      current.inputTokens = Math.max(current.inputTokens, input);
      current.outputTokens += output;
      current.cachedTokens = Math.max(current.cachedTokens, cached);
      current.reasoningTokens += reasoning;
    }

    if (ev.kind === "context_compaction_triggered" || ev.kind === "context_continued") {
      current.continuations += 1;
    }
  }

  const result: AgentContextUsage[] = [];
  for (const usage of Object.values(usageByActor)) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.reasoningTokens;
    if (usage.totalTokens === 0) continue;

    usage.usagePct = usage.contextWindow > 0
      ? Math.min(100, Math.round((usage.totalTokens / usage.contextWindow) * 1000) / 10)
      : 0;

    result.push(usage);
  }

  return result;
}

export function ContextWindowMonitor({ events = [], className }: ContextWindowMonitorProps) {
  const items = useMemo(() => extractContextUsage(events), [events]);

  if (items.length === 0) {
    return null;
  }

  return (
    <Card className={className}>
      <CardHeader className="border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-primary" />
            <CardTitle className="text-sm font-semibold">Agent Context Windows</CardTitle>
          </div>
          <Badge tone="default" className="text-[11px]">
            {items.length} monitored
          </Badge>
        </div>
        <CardDescription className="text-[12px]">
          Real-time context window token utilization, prompt caching, and reasoning tokens across active agents.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-4 space-y-4">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => {
            const isHighUsage = item.usagePct >= 80;
            const isMediumUsage = item.usagePct >= 60 && item.usagePct < 80;
            const barColor = isHighUsage
              ? "var(--color-rose-500, #f43f5e)"
              : isMediumUsage
              ? "var(--color-amber-500, #f59e0b)"
              : "var(--color-emerald-500, #10b981)";

            return (
              <div
                key={item.role}
                className="flex flex-col rounded-[14px] border border-border/60 bg-muted/20 p-3.5 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <span className="font-semibold text-[13px] capitalize text-foreground">
                      {item.agentName}
                    </span>
                    <p className="font-mono text-[10px] text-muted-foreground truncate max-w-[180px]">
                      {item.model}
                    </p>
                  </div>
                  <div className="text-right">
                    <span className="font-mono text-[12px] font-semibold text-foreground">
                      {item.usagePct}%
                    </span>
                    <p className="text-[10px] text-muted-foreground">utilized</p>
                  </div>
                </div>

                {/* Visual Context Gauge Bar */}
                <div className="space-y-1">
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.min(100, Math.max(2, item.usagePct))}%`,
                        backgroundColor: barColor,
                      }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] font-mono text-muted-foreground">
                    <span>{item.totalTokens.toLocaleString()} tokens</span>
                    <span>{item.contextWindow.toLocaleString()} max</span>
                  </div>
                </div>

                {/* Token Breakdown Chips */}
                <div className="flex flex-wrap gap-1 text-[10px] pt-1">
                  <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-muted-foreground">
                    <Cpu className="h-3 w-3" />
                    In: {item.inputTokens.toLocaleString()}
                  </span>
                  <span className="inline-flex items-center gap-1 rounded bg-muted/60 px-1.5 py-0.5 font-mono text-muted-foreground">
                    <Zap className="h-3 w-3" />
                    Out: {item.outputTokens.toLocaleString()}
                  </span>
                  {item.cachedTokens > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded bg-emerald-500/10 text-emerald-600 px-1.5 py-0.5 font-mono">
                      <Database className="h-3 w-3" />
                      Cached: {item.cachedTokens.toLocaleString()}
                    </span>
                  ) : null}
                  {item.reasoningTokens > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded bg-indigo-500/10 text-indigo-600 px-1.5 py-0.5 font-mono">
                      <BrainCircuit className="h-3 w-3" />
                      Thinking: {item.reasoningTokens.toLocaleString()}
                    </span>
                  ) : null}
                  {item.continuations > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-500/10 text-amber-600 px-1.5 py-0.5 font-mono">
                      <AlertTriangle className="h-3 w-3" />
                      Compactions: {item.continuations}
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
