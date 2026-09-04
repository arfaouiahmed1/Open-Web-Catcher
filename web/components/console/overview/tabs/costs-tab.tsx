"use client";

import { CircleDollarSign } from "lucide-react";
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
    { label: "Total cost", value: formatCurrency(totalCost), hint: "Estimated aggregate model spend" },
    { label: "Avg cost / run", value: formatCurrency(avgCost), hint: "Average spend per pipeline run" },
    { label: "LLM calls", value: formatNumber(Number(summary.total_llm_calls || 0)), hint: "Total model completions" },
    { label: "Providers", value: formatNumber(Number(summary.unique_providers || 0)), hint: "Distinct providers observed" },
    { label: "Cost / 1k tok", value: totalTokens ? formatCurrency(costPer1k) : "$0.000", hint: "Average spend per 1,000 tokens" },
    { label: "Avg LLM / run", value: formatNumber(Math.round(Number(summary.total_llm_calls || 0) / Math.max(Number(summary.total_runs || 1), 1))), hint: "Average model calls per run" },
  ];
  return (
    <div className="space-y-4 animate-fade-up">
      <SectionPanel title="Costs" description="Model spend rolled up across all pipeline runs" icon={<CircleDollarSign className="h-3.5 w-3.5" />}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kpis.map((kpi) => (
            <MetricCard key={kpi.label} label={kpi.label} value={kpi.value} hint={kpi.hint} />
          ))}
        </div>
      </SectionPanel>
    </div>
  );
}
