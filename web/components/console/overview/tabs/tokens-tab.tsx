"use client";

import { formatNumber, formatPercent } from "@/lib/utils";
import { MetricCard } from "@/components/library/MetricCard";

export interface TokensTabProps {
  overview: Record<string, unknown> | null;
  state?: "loading" | "error" | "success";
}

export function TokensTab({ overview, state }: TokensTabProps) {
  if (state === "loading" || !overview) return <MetricCard label="Tokens" state="loading" />;
  if (state === "error") return <MetricCard label="Tokens" value="—" state="error" />;
  const summary = ((overview as Record<string, unknown>).summary ?? {}) as Record<string, unknown>;
  const cached = Number(summary.total_cached_input_tokens || 0);
  const fresh = Number(summary.total_new_input_tokens || 0);
  const out = Number(summary.total_tokens_out || 0);
  const hitRate = cached + fresh > 0 ? cached / (cached + fresh) : 0;

  const kpis = [
    { label: "Total tokens", value: formatNumber(Number(summary.total_tokens || 0)), hint: "SUM(tokens_in + tokens_out)" },
    { label: "New input", value: formatNumber(fresh), hint: "Non-cached input — SUM(new_input_tokens)" },
    { label: "Cached input", value: formatNumber(cached), hint: "Prompt cache hits — SUM(cached_input_tokens)" },
    { label: "Output", value: formatNumber(out), hint: "Generated — SUM(tokens_out)" },
    { label: "Cache hit %", value: formatPercent(hitRate), hint: "cached / (cached+new)" },
    { label: "Avg tok / run", value: formatNumber(Math.round(Number(summary.total_tokens || 0) / Math.max(Number(summary.total_runs || 1), 1))), hint: "total_tokens / total_runs" },
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {kpis.map((k) => (
        <MetricCard key={k.label} label={k.label} value={k.value} hint={k.hint} />
      ))}
    </div>
  );
}
