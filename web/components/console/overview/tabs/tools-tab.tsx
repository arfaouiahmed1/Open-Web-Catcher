"use client";

import { MetricCard } from "@/components/library/MetricCard";

export interface ToolsTabProps {
  overview: Record<string, unknown> | null;
  state?: "loading" | "error" | "success";
}

export function ToolsTab({ overview, state }: ToolsTabProps) {
  if (state === "loading" || !overview) return <MetricCard label="Tools" state="loading" />;
  const summary = ((overview as Record<string, unknown>).summary ?? {}) as Record<string, unknown>;
  const observed = Number(summary.observed_tool_calls || 0);
  if (!observed) return <MetricCard label="Tools" value="—" state="empty" emptyLabel="No tool calls in this window." />;
  return (
    <div className="rounded-lg border p-4 text-sm">
      <p className="font-medium">Tools — observed {observed} calls</p>
      <p className="text-muted-foreground">Success {(Number(summary.tool_success_rate || 0) * 100).toFixed(1)}% · Failed {(Number(summary.tool_failure_rate || 0) * 100).toFixed(1)}% · Avg {Number(summary.avg_tool_duration_seconds || 0).toFixed(2)}s</p>
      <p className="mt-2 text-xs text-muted-foreground">Source: /ui/overview summary (COUNT over ToolCallRecord, single endpoint).</p>
    </div>
  );
}
