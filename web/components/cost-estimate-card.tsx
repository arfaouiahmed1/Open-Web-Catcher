"use client";

import { useEffect, useMemo, useState, memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { estimateRunCost, loadPricing, synthCallsFromModelUsage } from "@/lib/pricing";
import type { ComponentState } from "@/components/library/types";
import { StateFrame } from "@/components/library/StateFrame";

interface PricingMap extends Map<string, { context_window: number }> {}

interface LlmCall {
  provider?: string;
  model?: string;
  usage_metadata_json?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ModelUsage {
  provider?: string;
  model?: string;
  [key: string]: unknown;
}

interface AgentRollup {
  agent_type?: string;
  actor?: string;
  agent_run_id?: string | number;
  cost_usd?: number;
  llm_calls?: number;
  total_tokens?: number;
}

interface RunCostTotals {
  total: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  calls: number;
  computed: number;
  unpriced: number;
}

const Bar = memo(function Bar({ label, value, total, color }: { label: string; value: number; total: number; color: string }): React.JSX.Element {
  const pct = total > 0 ? Math.max(0, Math.min(1, value / total)) * 100 : 0;
  return (
    <div className="flex flex-col gap-1.5 rounded-[14px] border px-3 py-2.5" style={{ borderColor: "var(--line)", background: "color-mix(in oklch, var(--card) 90%, transparent)" }}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-medium" style={{ color: "var(--mute-2)" }}>{label}</span>
        <span className="font-mono text-[11.5px]" style={{ color: "var(--ink)" }}>
          {formatCurrency(value)} <span style={{ color: "var(--mute-3)" }}>- {pct.toFixed(0)}%</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
        <div className="h-full rounded-full transition-[width] motion-reduce:transition-none" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
});

const AgentCostBreakdown = memo(function AgentCostBreakdown({ agentRollups = [] }: { agentRollups?: AgentRollup[] }): React.JSX.Element | null {
  const rows = (Array.isArray(agentRollups) ? agentRollups : []).filter((row) => Number(row?.cost_usd || 0) > 0 || Number(row?.llm_calls || 0) > 0).slice(0, 6);
  if (!rows.length) return null;
  return (
    <div className="mt-2 space-y-1.5 border-t border-border pt-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Agent costs</div>
      {rows.map((row) => (
        <div key={`${row.agent_type}-${row.agent_run_id ?? row.actor}`} className="flex items-center justify-between gap-3 rounded-md bg-muted/25 px-2 py-1.5">
          <div className="min-w-0">
            <div className="truncate text-[11.5px] font-medium text-foreground/85">{row.actor ?? row.agent_type ?? "agent"}</div>
            <div className="font-mono text-[10px] text-muted-foreground">{formatNumber(row.llm_calls ?? 0)} calls / {formatNumber(row.total_tokens ?? 0)} tokens</div>
          </div>
          <div className="shrink-0 font-mono text-[11px] text-foreground/85">{formatCurrency(row.cost_usd ?? 0)}</div>
        </div>
      ))}
    </div>
  );
});

export interface CostEstimateCardProps {
  llmCalls?: LlmCall[];
  modelUsage?: ModelUsage[];
  agentRollups?: AgentRollup[];
  compact?: boolean;
  unavailable?: boolean;
  state?: ComponentState;
}

export const CostEstimateCard = memo(function CostEstimateCard({
  llmCalls = [],
  modelUsage = [],
  agentRollups = [],
  compact = false,
  unavailable = false,
  state,
}: CostEstimateCardProps): React.JSX.Element {
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

  const effectiveCalls = useMemo(() => {
    const rows = Array.isArray(llmCalls) ? llmCalls : [];
    if (rows.length > 0) return rows as unknown[];
    return synthCallsFromModelUsage(modelUsage as unknown[]) as unknown[];
  }, [llmCalls, modelUsage]);

  const totals = useMemo(() => estimateRunCost(effectiveCalls as never[], pricingMap as never) as RunCostTotals, [effectiveCalls, pricingMap]);

  const coverage = totals.calls > 0 ? Math.round((totals.computed / totals.calls) * 100) : 0;
  const coverageLabel = coverage >= 100 ? "Fully priced" : coverage > 0 ? "Partially priced" : "Pricing missing";

  if (state && state !== "success") {
    return (
      <StateFrame component="CostEstimateCard" state={state} emptyLabel="No cost data.">
        <div />
      </StateFrame>
    );
  }

  if (compact) {
    return (
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[16px] font-semibold" style={{ color: "var(--mint)" }}>{formatCurrency(totals.total)}</span>
        <span className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--mute-2)" }}>est. cost</span>
        {totals.calls > 0 ? <span className="font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>{coverage}% priced</span> : null}
      </div>
    );
  }

  if (unavailable) {
    return (
      <Card className="overflow-hidden shadow-card">
        <CardHeader className="flex flex-row items-start justify-between gap-3 p-4" style={{ background: "linear-gradient(180deg, color-mix(in oklch, var(--signal) 8%, transparent), transparent 72%)" }}>
          <div>
            <CardTitle className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Estimated Cost</CardTitle>
            <div className="mt-1 font-mono text-[31px] font-semibold leading-none" style={{ color: "var(--signal)" }}>--</div>
            <p className="mt-2 text-[12px]" style={{ color: "var(--mute)" }}>No persisted LLM telemetry was available for this run.</p>
          </div>
          <div className="flex flex-col items-end gap-2 text-right text-[10px] text-muted-foreground">
            <span className="rounded-full border px-2.5 py-1 font-medium uppercase tracking-[0.12em]" style={{ borderColor: "var(--line)", color: "var(--signal)", background: "color-mix(in oklch, var(--signal) 10%, transparent)" }}>Trace missing</span>
            <div>0% priced</div>
          </div>
        </CardHeader>
        <CardContent className="border-t p-4 text-[12px] text-muted-foreground" style={{ borderColor: "var(--line)" }}>Cost cannot be reconstructed because no LLM call telemetry was stored for this run.</CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="flex flex-row items-start justify-between gap-3 p-4" style={{ background: "linear-gradient(180deg, color-mix(in oklch, var(--mint) 8%, transparent), transparent 72%)" }}>
        <div>
          <CardTitle className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Estimated Cost</CardTitle>
          <div className="mt-1 font-mono text-[31px] font-semibold leading-none" style={{ color: "var(--mint)" }}>{formatCurrency(totals.total)}</div>
          <p className="mt-2 text-[12px]" style={{ color: "var(--mute)" }}>New input, cached reads, cache writes, and output are tracked separately.</p>
        </div>
        <div className="flex flex-col items-end gap-2 text-right text-[10px] text-muted-foreground">
          <span className="rounded-full border px-2.5 py-1 font-medium uppercase tracking-[0.12em]" style={{ borderColor: "var(--line)", color: coverage >= 100 ? "var(--mint)" : coverage > 0 ? "var(--signal)" : "var(--rose)", background: coverage >= 100 ? "color-mix(in oklch, var(--mint) 10%, transparent)" : coverage > 0 ? "color-mix(in oklch, var(--signal) 10%, transparent)" : "color-mix(in oklch, var(--rose) 10%, transparent)" }}>{coverageLabel}</span>
          <div>{formatNumber(totals.calls)} call{totals.calls === 1 ? "" : "s"}</div>
          <div>{coverage}% priced</div>
          {totals.unpriced > 0 ? <div>{formatNumber(totals.unpriced)} unmatched</div> : null}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 border-t p-4" style={{ borderColor: "var(--line)" }}>
        <Bar label="Input (new)" value={totals.input} total={totals.total} color="var(--signal)" />
        <Bar label="Cached read" value={totals.cached} total={totals.total} color="var(--violet)" />
        {totals.cacheWrite > 0 ? <Bar label="Cache write" value={totals.cacheWrite} total={totals.total} color="var(--sky)" /> : null}
        <Bar label="Output" value={totals.output} total={totals.total} color="var(--mint)" />
        <AgentCostBreakdown agentRollups={agentRollups} />
      </CardContent>

      {pricingMap && pricingMap.size === 0 ? <div className="mx-4 mb-4 rounded-lg px-2.5 py-1.5 text-[10.5px]" style={{ background: "color-mix(in oklch, var(--rose) 10%, transparent)", color: "var(--rose)" }}>No pricing data loaded. Sync pricing in settings.</div> : null}
      {pricingMap && pricingMap.size > 0 && totals.unpriced > 0 ? <div className="mx-4 mb-4 rounded-lg px-2.5 py-1.5 text-[10.5px]" style={{ background: "color-mix(in oklch, var(--signal) 10%, transparent)", color: "var(--signal)" }}>Pricing missing for {formatNumber(totals.unpriced)} provider/model call{totals.unpriced === 1 ? "" : "s"}.</div> : null}
    </Card>
  );
});
