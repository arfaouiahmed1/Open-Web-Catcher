"use client";

import { useEffect, useMemo, useState, memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { getContextWindow, loadPricing, peakContextUsage } from "@/lib/pricing";

interface LlmCall {
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

interface Group {
  key: string;
  label: string;
  stage?: string;
  llmCalls?: LlmCall[];
  actor?: string;
  agentType?: string;
  order?: number;
  invocationIndex?: number;
  status?: string;
}

function stageTone(stage?: string): string {
  if (stage === "classification") return "var(--sky)";
  if (stage === "landing") return "var(--violet)";
  if (stage === "hosting") return "var(--mint)";
  if (stage === "embedded") return "var(--signal)";
  return "var(--mute)";
}

function compact(value: number | string): string {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function toneFor(pct: number): string {
  if (pct >= 0.85) return "var(--rose)";
  if (pct >= 0.6) return "var(--amber, #f59e0b)";
  return "var(--signal)";
}

export interface ContextWindowMeterProps {
  llmCalls?: LlmCall[];
  primaryModel?: string;
  primaryProvider?: string;
  groups?: Group[];
  focusKey?: string;
  compact?: boolean;
}

export const ContextWindowMeter = memo(function ContextWindowMeter({
  llmCalls = [],
  primaryModel = "",
  primaryProvider = "",
  groups = [],
  focusKey = "",
  compact: compactMode = false,
}: ContextWindowMeterProps): React.JSX.Element {
  const [pricingMap, setPricingMap] = useState<Map<string, unknown> | null>(null);

  useEffect(() => {
    let alive = true;
    loadPricing().then((map) => {
      if (alive) setPricingMap(map as Map<string, unknown>);
    });
    return () => {
      alive = false;
    };
  }, []);

  const peak = useMemo(() => peakContextUsage(llmCalls as never[], pricingMap as never) as { tokens: number; contextWindow: number; provider?: string; model?: string }, [llmCalls, pricingMap]);
  const contextWindow = peak.contextWindow || (getContextWindow(peak.provider ?? primaryProvider, peak.model ?? primaryModel, llmCalls as never[], pricingMap as never) as number);
  const tokens = peak.tokens as number;
  const pct = contextWindow > 0 ? tokens / contextWindow : 0;
  const pctClamped = Math.max(0, Math.min(1, pct));
  const color = toneFor(pctClamped);

  const groupRows = useMemo(() => {
    return (groups || [])
      .map((group, index) => {
        const peakGroup = peakContextUsage((group.llmCalls ?? []) as never[], pricingMap as never) as { tokens: number; contextWindow: number; provider?: string; model?: string };
        const contextWindowValue = peakGroup.contextWindow || (getContextWindow(peakGroup.provider ?? primaryProvider, peakGroup.model ?? primaryModel, (group.llmCalls ?? []) as never[], pricingMap as never) as number);
        const tokensValue = peakGroup.tokens as number;
        const pctValue = contextWindowValue > 0 ? tokensValue / contextWindowValue : 0;
        return {
          ...group,
          order: Number((group as unknown as Record<string, unknown>).order ?? index),
          color: stageTone(group.stage),
          tokens: tokensValue,
          contextWindow: contextWindowValue,
          pct: pctValue,
          pctClamped: Math.max(0, Math.min(1, pctValue)),
          modelLabel: peakGroup.model ?? primaryModel ?? "model",
        };
      })
      .filter((group) => group.contextWindow > 0 || group.tokens > 0)
      .sort((a, b) => {
        if (focusKey) {
          const aFocus = a.key === focusKey || a.stage === focusKey || a.actor === focusKey || a.agentType === focusKey;
          const bFocus = b.key === focusKey || b.stage === focusKey || b.actor === focusKey || b.agentType === focusKey;
          if (aFocus !== bFocus) return aFocus ? -1 : 1;
        }
        const orderDelta = Number(a.order || 0) - Number(b.order || 0);
        if (orderDelta !== 0) return orderDelta;
        const invocationDelta = Number(a.invocationIndex || 0) - Number(b.invocationIndex || 0);
        if (invocationDelta !== 0) return invocationDelta;
        return String(a.label || "").localeCompare(String(b.label || ""));
      });
  }, [focusKey, groups, pricingMap, primaryModel, primaryProvider]);

  if (compactMode) {
    return (
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[16px] font-semibold" style={{ color }}>{contextWindow > 0 ? `${(pctClamped * 100).toFixed(1)}%` : "--"}</span>
        <span className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--mute-2)" }}>context</span>
        {contextWindow > 0 ? <span className="font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>{compact(tokens)} / {compact(contextWindow)}</span> : null}
      </div>
    );
  }

  if (groupRows.length) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-3 p-4">
          <div>
            <CardTitle className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Context Window</CardTitle>
            <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground">Peak input per agent invocation instead of one workflow-wide total.</div>
          </div>
          <div className="text-right text-[10px] text-muted-foreground">
            <div>{groupRows.length} tracked group{groupRows.length === 1 ? "" : "s"}</div>
          </div>
        </CardHeader>

        <CardContent className="grid gap-3 p-4 pt-0 lg:grid-cols-2">
          {groupRows.map((group) => {
            const c = toneFor(group.pctClamped);
            const isFocused = Boolean(focusKey && (group.key === focusKey || group.stage === focusKey || group.actor === focusKey || group.agentType === focusKey));
            return (
              <div key={group.key} className={cn("rounded-[12px] border p-3 transition-colors", isFocused && "stage-running")} style={{ borderColor: isFocused ? `color-mix(in oklch, ${group.color} 36%, transparent)` : "var(--line)", background: isFocused ? `color-mix(in oklch, ${group.color} 10%, transparent)` : "color-mix(in oklch, var(--bg) 78%, transparent)" }}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold" style={{ color: group.color }}>{group.label}</div>
                    <div className="mt-0.5 text-[10.5px]" style={{ color: "var(--mute-2)" }}>{group.status ?? "tracked"}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono text-[18px] font-semibold" style={{ color: c }}>{group.contextWindow > 0 ? `${(group.pctClamped * 100).toFixed(1)}%` : "--"}</div>
                    <div className="font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>{compact(group.tokens)} / {compact(group.contextWindow)}</div>
                  </div>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
                  <div className="h-full rounded-full transition-all" style={{ width: `${group.pctClamped * 100}%`, background: c }} />
                </div>
                <div className="mt-1.5 font-mono text-[10px] text-muted-foreground truncate" title={group.modelLabel}>{group.modelLabel}</div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 p-4">
        <CardTitle className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Context Window</CardTitle>
        <span className="font-mono text-[10px] text-muted-foreground">{compact(tokens)} / {compact(contextWindow)}</span>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[28px] font-semibold leading-none" style={{ color }}>{contextWindow > 0 ? `${(pctClamped * 100).toFixed(1)}%` : "--"}</span>
          <span className="text-[11px] text-muted-foreground">{tokens.toLocaleString()} tokens peak</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pctClamped * 100}%`, background: color }} />
        </div>
        <div className="font-mono text-[10px] text-muted-foreground">{String(peak.model ?? primaryModel ?? "model")} {contextWindow ? `· ${compact(contextWindow)} window` : ""}</div>
      </CardContent>
    </Card>
  );
});
