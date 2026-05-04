"use client";

import { useEffect, useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber } from "@/lib/utils";
import { getContextWindow, loadPricing, peakContextUsage } from "@/lib/pricing";
import { cn } from "@/lib/utils";

function stageTone(stage) {
  if (stage === "classification") return "var(--sky)";
  if (stage === "landing") return "var(--violet)";
  if (stage === "hosting") return "var(--mint)";
  if (stage === "embedded") return "var(--signal)";
  return "var(--mute)";
}

function compact(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function toneFor(pct) {
  if (pct >= 0.85) return "var(--rose)";
  if (pct >= 0.6) return "var(--amber, #f59e0b)";
  return "var(--signal)";
}

export function ContextWindowMeter({
  llmCalls = [],
  primaryModel = "",
  primaryProvider = "",
  groups = [],
  focusKey = "",
  compact: compactMode = false,
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

  const peak = useMemo(
    () => peakContextUsage(llmCalls, pricingMap),
    [llmCalls, pricingMap],
  );
  const contextWindow =
    peak.contextWindow ||
    getContextWindow(
      peak.provider || primaryProvider,
      peak.model || primaryModel,
      llmCalls,
      pricingMap,
    );
  const tokens = peak.tokens;
  const pct = contextWindow > 0 ? tokens / contextWindow : 0;
  const pctClamped = Math.max(0, Math.min(1, pct));
  const color = toneFor(pctClamped);
  const modelLabel = peak.model || primaryModel || "model";

  const groupRows = useMemo(() => {
    return (groups || [])
      .map((group, index) => {
        const peakGroup = peakContextUsage(group.llmCalls, pricingMap);
        const contextWindowValue =
          peakGroup.contextWindow ||
          getContextWindow(
            peakGroup.provider || primaryProvider,
            peakGroup.model || primaryModel,
            group.llmCalls,
            pricingMap,
          );
        const tokensValue = peakGroup.tokens;
        const pctValue =
          contextWindowValue > 0 ? tokensValue / contextWindowValue : 0;
        return {
          ...group,
          order: Number(group.order ?? index),
          color: stageTone(group.stage),
          tokens: tokensValue,
          contextWindow: contextWindowValue,
          pct: pctValue,
          pctClamped: Math.max(0, Math.min(1, pctValue)),
          modelLabel: peakGroup.model || primaryModel || "model",
        };
      })
      .filter((group) => group.contextWindow > 0 || group.tokens > 0)
      .sort((a, b) => {
        if (focusKey) {
          const aFocus = a.key === focusKey || a.stage === focusKey;
          const bFocus = b.key === focusKey || b.stage === focusKey;
          if (aFocus !== bFocus) return aFocus ? -1 : 1;
        }
        return Number(a.order || 0) - Number(b.order || 0);
      });
  }, [focusKey, groups, pricingMap, primaryModel, primaryProvider]);

  if (compactMode) {
    return (
      <div className="flex items-baseline gap-2">
        <span
          className="font-mono text-[16px] font-semibold"
          style={{ color }}
        >
          {contextWindow > 0 ? `${(pctClamped * 100).toFixed(1)}%` : "--"}
        </span>
        <span
          className="text-[10px] uppercase tracking-[0.12em]"
          style={{ color: "var(--mute-2)" }}
        >
          context
        </span>
        {contextWindow > 0 ? (
          <span className="font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
            {compact(tokens)} / {compact(contextWindow)}
          </span>
        ) : null}
      </div>
    );
  }

  if (groupRows.length) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-baseline justify-between gap-3 p-4">
          <div>
            <CardTitle className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              Context Window
            </CardTitle>
            <div className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
              Peak input per stage or agent instead of one workflow-wide total.
            </div>
          </div>
          <div className="text-right text-[10px] text-muted-foreground">
            <div>{groupRows.length} tracked group{groupRows.length === 1 ? "" : "s"}</div>
          </div>
        </CardHeader>

        <CardContent className="grid gap-3 p-4 pt-0 lg:grid-cols-2">
          {groupRows.map((group) => {
            const color = toneFor(group.pctClamped);
            const isFocused = focusKey && (group.key === focusKey || group.stage === focusKey);
            return (
              <div
                key={group.key}
                className={cn("rounded-[12px] border p-3 transition-colors", isFocused && "stage-running")}
                style={{
                  borderColor: isFocused
                    ? `color-mix(in oklch, ${group.color} 36%, transparent)`
                    : "var(--line)",
                  background: isFocused
                    ? `color-mix(in oklch, ${group.color} 10%, transparent)`
                    : "color-mix(in oklch, var(--bg) 78%, transparent)",
                }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div
                      className="text-[11px] font-semibold"
                      style={{ color: group.color }}
                    >
                      {group.label}
                    </div>
                    <div
                      className="mt-0.5 text-[10.5px]"
                      style={{ color: "var(--mute-2)" }}
                    >
                      {group.status || "tracked"}
                    </div>
                  </div>
                  <div className="text-right">
                    <div
                      className="font-mono text-[18px] font-semibold"
                      style={{ color }}
                    >
                      {group.contextWindow > 0
                        ? `${(group.pctClamped * 100).toFixed(1)}%`
                        : "--"}
                    </div>
                    <div
                      className="font-mono text-[10px]"
                      style={{ color: "var(--mute-3)" }}
                    >
                      {formatNumber(group.tokens)} / {formatNumber(group.contextWindow)}
                    </div>
                  </div>
                </div>

                <div
                  className="relative mt-3 h-2 overflow-hidden rounded-full"
                  style={{ background: "var(--line)" }}
                >
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${group.pctClamped * 100}%`,
                      background: color,
                    }}
                  />
                </div>

                <div
                  className="mt-2 flex items-center justify-between gap-3 font-mono text-[10px]"
                  style={{ color: "var(--mute-3)" }}
                >
                  <span className="truncate">{group.modelLabel}</span>
                  <span>headroom {compact(Math.max(group.contextWindow - group.tokens, 0))}</span>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-baseline justify-between gap-3 p-4">
        <div>
          <CardTitle className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Context Window
          </CardTitle>
          <div className="mt-0.5 font-mono text-2xl font-semibold" style={{ color }}>
            {contextWindow > 0 ? `${(pctClamped * 100).toFixed(1)}%` : "--"}
          </div>
        </div>
        <div className="text-right text-[10px] text-muted-foreground">
          <div className="font-mono">{modelLabel}</div>
          <div className="font-mono">
            {contextWindow > 0
              ? `${formatNumber(tokens)} / ${formatNumber(contextWindow)}`
              : "no window data"}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-4 pt-0">
        <div
        className="relative mt-3 h-2 overflow-hidden rounded-full"
        style={{ background: "var(--line)" }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${pctClamped * 100}%`,
            background: color,
          }}
        />
        {[0.25, 0.5, 0.75].map((mark) => (
          <div
            key={mark}
            className="absolute top-0 h-full w-px"
            style={{
              left: `${mark * 100}%`,
              background: "color-mix(in oklch, var(--ink) 18%, transparent)",
            }}
          />
        ))}
        </div>

        <div className="mt-2 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
          <span>peak input</span>
          <span>headroom: {compact(Math.max(contextWindow - tokens, 0))}</span>
        </div>
      </CardContent>
    </Card>
  );
}
