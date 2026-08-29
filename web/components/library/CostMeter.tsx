"use client";

import React from "react";
import { cn, formatCurrency, formatNumber } from "@/lib/utils";
import { StateFrame, resolveState } from "./StateFrame";
import type { ComponentState, RunCostFields } from "./types";

export interface CostMeterProps {
  /**
   * Cost slice of a RunMetrics payload.
   * TODO(plan-T38-types): field names mirror RunMetrics JSON keys
   * (src/models/orchestrator.py) exactly — replace this local type when the
   * generated types arrive.
   */
  costs?: RunCostFields;
  tokens?: {
    total_tokens_in?: number;
    total_tokens_out?: number;
    total_llm_calls?: number;
  };
  state?: ComponentState;
  title?: string;
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  className?: string;
}

interface BreakdownRow {
  key: keyof RunCostFields;
  label: string;
}

const BREAKDOWN: readonly BreakdownRow[] = [
  { key: "estimated_input_cost_usd", label: "Input" },
  { key: "estimated_cached_input_cost_usd", label: "Cached input" },
  { key: "estimated_cache_write_cost_usd", label: "Cache write" },
  { key: "estimated_output_cost_usd", label: "Output" },
];

/** Estimated USD cost meter over RunMetrics cost fields. */
export function CostMeter({
  costs,
  tokens,
  state,
  title = "Estimated cost",
  loadingLabel,
  errorLabel,
  emptyLabel = "No cost data yet.",
  className,
}: CostMeterProps) {
  const row = costs ?? {};
  const hasAny = BREAKDOWN.some((b) => typeof row[b.key] === "number") ||
    typeof row.estimated_total_cost_usd === "number";
  const resolved = resolveState(state, hasAny);

  const declared = BREAKDOWN.reduce(
    (sum, b) => sum + (typeof row[b.key] === "number" ? (row[b.key] as number) : 0),
    0,
  );
  const total =
    typeof row.estimated_total_cost_usd === "number"
      ? row.estimated_total_cost_usd
      : declared;

  return (
    <StateFrame
      component="CostMeter"
      state={resolved}
      loadingLabel={loadingLabel}
      errorLabel={errorLabel}
      emptyLabel={emptyLabel}
      className={className}
    >
      <div className="space-y-2 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xl font-semibold tabular-nums">
            {formatCurrency(total)}
          </p>
        </div>
        <dl className="space-y-1" data-role="breakdown">
          {BREAKDOWN.map((b) => {
            const value = typeof row[b.key] === "number" ? (row[b.key] as number) : null;
            const share =
              value !== null && total > 0 ? Math.round((value / total) * 100) : 0;
            return (
              <div
                key={b.key}
                data-field={b.key}
                className="flex items-center gap-2 text-xs"
              >
                <dt className="w-24 shrink-0 text-muted-foreground">{b.label}</dt>
                <dd className="flex flex-1 items-center gap-2 tabular-nums">
                  <span className="w-20 text-right font-medium">
                    {value === null ? "—" : formatCurrency(value)}
                  </span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <span
                      data-share={share}
                      className="block h-full rounded-full bg-primary/70"
                      style={{ width: `${share}%` }}
                    />
                  </span>
                  <span className="w-9 text-right text-muted-foreground">
                    {share}%
                  </span>
                </dd>
              </div>
            );
          })}
        </dl>
        {tokens ? (
          <p className="text-xs text-muted-foreground" data-role="tokens">
            {typeof tokens.total_tokens_in === "number"
              ? `${formatNumber(tokens.total_tokens_in)} in · `
              : ""}
            {typeof tokens.total_tokens_out === "number"
              ? `${formatNumber(tokens.total_tokens_out)} out · `
              : ""}
            {typeof tokens.total_llm_calls === "number"
              ? `${formatNumber(tokens.total_llm_calls)} LLM calls`
              : ""}
          </p>
        ) : null}
      </div>
    </StateFrame>
  );
}
