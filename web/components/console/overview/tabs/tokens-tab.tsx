"use client";

import { Coins, Zap } from "lucide-react";
import { formatNumber, formatPercent } from "@/lib/utils";
import { MetricCard } from "@/components/library/MetricCard";
import { SectionPanel } from "@/components/console/common/section-panel";

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
    <div className="space-y-4 animate-fade-up">
      <SectionPanel title="Tokens" description="Token accounting from pipeline_runs · cache hit = cached / (cached+new)" icon={<Coins className="h-3.5 w-3.5" />}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {kpis.map((k) => (
            <MetricCard key={k.label} label={k.label} value={k.value} hint={k.hint} />
          ))}
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <Zap className="h-3 w-3 text-amber-500" /> Cache hit rate reflects prompt caching (Google implicit + explicit). Cached tokens billed at reduced rate.
        </div>
      </SectionPanel>
    </div>
  );
}
