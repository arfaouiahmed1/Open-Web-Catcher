"use client";

import { Wrench, Activity } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";
import { SectionPanel } from "@/components/console/common/section-panel";
import { EmptyState } from "@/components/console/common/empty-state";

export interface ToolsTabProps {
  overview: Record<string, unknown> | null;
  state?: "loading" | "error" | "success";
}

export function ToolsTab({ overview, state }: ToolsTabProps) {
  if (state === "loading" || !overview) return <MetricCard label="Tools" state="loading" />;
  const summary = ((overview as Record<string, unknown>).summary ?? {}) as Record<string, unknown>;
  const observed = Number(summary.observed_tool_calls || 0);
  if (!observed) return <EmptyState tone="default" title="No tool calls" description="No ToolCallRecord rows in this overview window. Run a pipeline to generate tool observations (single endpoint /ui/overview)." />;
  return (
    <div className="space-y-4 animate-fade-up">
      <SectionPanel title="Tool execution" description="Observed vs successful calls · single endpoint /ui/overview (COUNT over ToolCallRecord)" icon={<Wrench className="h-3.5 w-3.5" />}>
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Observed" value={String(observed)} hint="COUNT(*)" />
          <MetricCard label="Success" value={`${(Number(summary.tool_success_rate || 0) * 100).toFixed(1)}%`} hint="successful / observed" />
          <MetricCard label="Avg duration" value={`${Number(summary.avg_tool_duration_seconds || 0).toFixed(2)}s`} hint="AVG(duration)" />
        </div>
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          <Activity className="h-3 w-3 shrink-0" /> Failed {(Number(summary.tool_failure_rate || 0) * 100).toFixed(1)}% · Source: /ui/overview summary
        </div>
      </SectionPanel>
    </div>
  );
}
