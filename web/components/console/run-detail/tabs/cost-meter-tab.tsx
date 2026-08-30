"use client";

import React, { useMemo } from "react";
import { CostMeter } from "@/components/library/CostMeter";
import { MetricCard } from "@/components/library/MetricCard";
import type { RunCostFields } from "@/components/library/types";

export interface CostMeterTabProps {
  metrics?: Record<string, unknown> | null;
  costs?: RunCostFields | null;
  totalCostUsd?: number;
  title?: string;
}

function extractCosts(metrics: Record<string, unknown> | null | undefined, explicit: RunCostFields | null | undefined): RunCostFields | undefined {
  if (explicit && typeof explicit === "object" && Object.keys(explicit).length) return explicit;
  if (!metrics || typeof metrics !== "object") return undefined;
  const m = metrics as Record<string, unknown>;
  // Support both flat metrics and nested cost slice
  const candidate = (m.costs as Record<string, unknown>) || m;
  const fields: (keyof RunCostFields)[] = [
    "estimated_input_cost_usd",
    "estimated_cached_input_cost_usd",
    "estimated_cache_write_cost_usd",
    "estimated_output_cost_usd",
    "estimated_total_cost_usd",
  ];
  const out: RunCostFields = {};
  let has = false;
  for (const f of fields) {
    const v = candidate[f];
    if (typeof v === "number") {
      (out as Record<string, unknown>)[f] = v;
      has = true;
    }
  }
  if (typeof m.estimated_total_cost_usd === "number" && out.estimated_total_cost_usd == null) {
    out.estimated_total_cost_usd = m.estimated_total_cost_usd as number;
    has = true;
  }
  return has ? out : undefined;
}

function extractTokens(metrics: Record<string, unknown> | null | undefined) {
  if (!metrics || typeof metrics !== "object") return undefined;
  const m = metrics as Record<string, unknown>;
  const t = (m.tokens as Record<string, unknown>) || m;
  const total_in = typeof t.total_tokens_in === "number" ? (t.total_tokens_in as number) : typeof m.total_tokens_in === "number" ? (m.total_tokens_in as number) : undefined;
  const total_out = typeof t.total_tokens_out === "number" ? (t.total_tokens_out as number) : typeof m.total_tokens_out === "number" ? (m.total_tokens_out as number) : undefined;
  const calls = typeof t.total_llm_calls === "number" ? (t.total_llm_calls as number) : typeof m.total_llm_calls === "number" ? (m.total_llm_calls as number) : undefined;
  if (total_in == null && total_out == null && calls == null) return undefined;
  return { total_tokens_in: total_in, total_tokens_out: total_out, total_llm_calls: calls };
}

export function CostMeterTab({ metrics, costs, totalCostUsd, title = "Cost & tokens" }: CostMeterTabProps) {
  const normalizedCosts = useMemo(() => {
    const c = extractCosts(metrics as Record<string, unknown>, costs as RunCostFields);
    if (c && typeof totalCostUsd === "number" && c.estimated_total_cost_usd == null) {
      return { ...c, estimated_total_cost_usd: totalCostUsd };
    }
    if (!c && typeof totalCostUsd === "number") return { estimated_total_cost_usd: totalCostUsd };
    return c;
  }, [metrics, costs, totalCostUsd]);
  const tokens = useMemo(() => extractTokens(metrics as Record<string, unknown>), [metrics]);

  const hasCost = !!normalizedCosts && Object.values(normalizedCosts).some((v) => typeof v === "number");
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-card" data-testid="cost-meter-tab">
      <div className="border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">Live cost accounting from SSE metrics — no polling. Mirrors backend CostAccounting.</p>
      </div>
      <div className="space-y-3 p-3">
        <CostMeter costs={normalizedCosts} tokens={tokens} emptyLabel="No cost data yet — waiting for first LLM call." title="Estimated cost" />
        {tokens ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {typeof tokens.total_tokens_in === "number" ? <MetricCard label="Tokens in" value={tokens.total_tokens_in} /> : null}
            {typeof tokens.total_tokens_out === "number" ? <MetricCard label="Tokens out" value={tokens.total_tokens_out} /> : null}
            {typeof tokens.total_llm_calls === "number" ? <MetricCard label="LLM calls" value={tokens.total_llm_calls} /> : null}
          </div>
        ) : null}
        {!hasCost && !tokens ? (
          <div className="text-xs text-muted-foreground" data-role="cost-empty">
            Cost ledger will populate as the run emits llm_response and pricing-missing warnings.
          </div>
        ) : null}
      </div>
    </div>
  );
}
