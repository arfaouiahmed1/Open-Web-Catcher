"use client";

import { memo } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/utils";

const PROVIDER_COLORS: Record<string, string> = {
  google: "var(--sky)",
  openai: "var(--mint)",
  anthropic: "var(--signal)",
  openrouter: "var(--violet)",
  nvidia: "var(--mint)",
};

export interface ModelBadgeProps {
  provider?: string;
  model?: string;
}

export const ModelBadge = memo(function ModelBadge({ provider, model }: ModelBadgeProps): React.JSX.Element {
  const color = PROVIDER_COLORS[(provider ?? "").toLowerCase()] ?? "var(--mute)";
  const short = model?.split("/").pop() ?? model ?? "--";

  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>
        {provider ?? "--"}
      </span>
      <span className="max-w-[140px] truncate font-mono text-[11px]" style={{ color: "var(--ink-dim)" }} title={model}>
        {short}
      </span>
    </div>
  );
});

export interface RunCompareRow {
  run_id: string;
  page_type?: string;
  total_tool_calls?: number;
  total_llm_calls?: number;
  total_cost_usd?: number;
  estimated_total_cost_usd?: number;
  duration_seconds?: number;
}

export interface ComparePanelProps {
  rows?: RunCompareRow[];
}

export const ComparePanel = memo(function ComparePanel({ rows = [] }: ComparePanelProps): React.JSX.Element | null {
  if (rows.length < 2) return null;

  const maxDuration = Math.max(...rows.map((row) => Number(row.duration_seconds ?? 0)), 1);
  const sortedTools = [...rows].sort((a, b) => Number(b.total_tool_calls ?? 0) - Number(a.total_tool_calls ?? 0));
  const divergence = sortedTools[0]?.run_id !== sortedTools[rows.length - 1]?.run_id;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Compare runs</CardTitle>
        <CardDescription>Selected runs are shown side by side for quick comparison.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {rows.map((row) => (
            <div key={row.run_id} className="rounded-lg border border-border bg-background px-3 py-2.5">
              <div className="font-mono text-[12px] text-foreground">{row.run_id?.slice(0, 12)}...</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{row.page_type ?? "--"}</div>
              <div className="mt-2 space-y-1 text-sm text-muted-foreground">
                <div>tools {formatNumber(row.total_tool_calls as number)}</div>
                <div>llm {formatNumber(row.total_llm_calls as number)}</div>
                <div>cost {formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}</div>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
                <div className="h-1.5 rounded-full" style={{ width: `${(Number(row.duration_seconds ?? 0) / maxDuration) * 100}%`, background: "color-mix(in oklch, var(--signal) 60%, transparent)" }} />
              </div>
              <div className="mt-1 text-xs text-muted-foreground">{Number(row.duration_seconds ?? 0).toFixed(1)}s</div>
            </div>
          ))}
        </div>
        <div className="text-sm text-muted-foreground">{divergence ? "Divergence detected: selected runs have different tool-call intensity." : "No significant divergence in selected runs."}</div>
      </CardContent>
    </Card>
  );
});
