"use client";

import { CircleDollarSign, TrendingUp, Layers } from "lucide-react";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { MetricCard } from "@/components/library/MetricCard";
import { SectionPanel } from "@/components/console/common/section-panel";

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
    <div className="space-y-4 animate-fade-up">
      <SectionPanel title="Costs" description="Single-endpoint cost rollups (SUM, not MAX — T35 fix)" icon={<CircleDollarSign className="h-3.5 w-3.5" />}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kpis.map((kpi) => (
            <MetricCard key={kpi.label} label={kpi.label} value={kpi.value} hint={kpi.hint} />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <TrendingUp className="h-3 w-3" /> Total cost is SUM across pipeline_runs; per-model breakdowns use SUM GROUP BY (provider, model_name).
          <span className="ml-auto hidden sm:inline-flex items-center gap-1"><Layers className="h-3 w-3" /> T35: MAX→SUM</span>
        </div>
      </SectionPanel>
    </div>
  );
}
