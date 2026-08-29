"use client";

import { formatCurrency, formatNumber } from "@/lib/utils";
import { MetricCard } from "@/components/library/MetricCard";

export interface CostsTabProps {
  overview: Record<string, unknown> | null;
  state?: "loading" | "error" | "success";
}

export function CostsTab({ overview, state }: CostsTabProps) {
  if (state === "loading" || !overview) return <MetricCard label="Costs" state="loading" />;
  if (state === "error") return <MetricCard label="Costs" value="—" state="error" errorLabel="Could not load costs." />;
  const summary = ((overview as Record<string, unknown>).summary ?? {}) as Record<string, unknown>;
  const totalCost = Number(summary.total_cost_usd || 0);
  const terminalRuns = Number(summary.terminal_runs || summary.total_runs || 1);
  const totalTokens = Number(summary.total_tokens || 0);
  const avgCost = terminalRuns ? totalCost / terminalRuns : 0;
  const costPer1k = totalTokens ? totalCost / (totalTokens / 1000) : 0;

  const kpis = [
    { label: "Total cost", value: formatCurrency(totalCost), hint: "SUM(estimated_total_cost_usd) — T35 fix (was MAX)" },
    { label: "Avg cost / run", value: formatCurrency(avgCost), hint: "total_cost_usd / terminal_runs" },
    { label: "LLM calls", value: formatNumber(Number(summary.total_llm_calls || 0)), hint: "SUM(total_llm_calls)" },
    { label: "Providers", value: formatNumber(Number(summary.unique_providers || 0)), hint: "COUNT(DISTINCT provider)" },
    { label: "Cost / 1k tok", value: totalTokens ? formatCurrency(costPer1k) : "$0.000", hint: "total_cost_usd / (total_tokens/1000)" },
    { label: "Avg LLM / run", value: formatNumber(Math.round(Number(summary.total_llm_calls || 0) / Math.max(Number(summary.total_runs || 1), 1))), hint: "total_llm_calls / total_runs" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {kpis.map((kpi) => (
        <MetricCard key={kpi.label} label={kpi.label} value={kpi.value} hint={kpi.hint} />
      ))}
    </div>
  );
}
