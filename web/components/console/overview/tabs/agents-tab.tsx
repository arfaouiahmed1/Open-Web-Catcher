"use client";

import { Users } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";
import { SectionPanel } from "@/components/console/common/section-panel";
import { EmptyState } from "@/components/console/common/empty-state";

export interface AgentsTabProps {
  overview: Record<string, unknown> | null;
  state?: "loading" | "error" | "success";
  agentRows?: Array<Record<string, unknown>>;
}

export function AgentsTab({ overview, state, agentRows }: AgentsTabProps) {
  if (state === "loading" || !overview) return <MetricCard label="Agents" state="loading" />;
  const summary = ((overview as Record<string, unknown>).summary ?? {}) as Record<string, unknown>;
  const activeAgents = Number(summary.active_agents || 0);
  const activeWorkflows = Number(summary.active_workflows || 0);
  return (
    <div className="space-y-4 animate-fade-up">
      <SectionPanel title="Agents" description="Live agent and workflow activity" icon={<Users className="h-3.5 w-3.5" />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <MetricCard label="Active agents" value={String(activeAgents)} hint="Agents running right now" />
          <MetricCard label="Active workflows" value={String(activeWorkflows)} hint="Workflows running right now" />
        </div>
      </SectionPanel>
      <SectionPanel title="Agent rows (on-demand)" description="Detailed rows load when tab is active — up to 8 shown with memoization">
        {agentRows?.length ? (
          <ul className="divide-y divide-border/60 rounded-lg border">
            {agentRows.slice(0, 8).map((r, i) => (
              <li key={i} className="flex items-center justify-between gap-2 px-3 py-2.5 text-sm hover:bg-muted/20">
                <span className="truncate font-mono text-xs">{String(r.actor || r.agent_type || "?")}</span>
                <span className="rounded-full border bg-muted px-2 py-0.5 text-xs">{String(r.status || "?")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState tone="default" title="No detailed rows" description="Agent activity appears here while runs are in flight." />
        )}
      </SectionPanel>
    </div>
  );
}
