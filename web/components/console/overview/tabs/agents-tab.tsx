"use client";

import { MetricCard } from "@/components/library/MetricCard";

export interface AgentsTabProps {
  overview: Record<string, unknown> | null;
  state?: "loading" | "error" | "success";
  /** Optional extra rows when caller fetches agent_runs separately */
  agentRows?: Array<Record<string, unknown>>;
}

export function AgentsTab({ overview, state, agentRows }: AgentsTabProps) {
  if (state === "loading" || !overview) return <MetricCard label="Agents" state="loading" />;
  const summary = ((overview as Record<string, unknown>).summary ?? {}) as Record<string, unknown>;
  const activeAgents = Number(summary.active_agents || 0);
  const activeWorkflows = Number(summary.active_workflows || 0);
  return (
    <div className="rounded-lg border p-4 text-sm space-y-2">
      <p className="font-medium">Agents — {activeAgents} active · {activeWorkflows} active workflows</p>
      {agentRows?.length ? (
        <ul className="list-disc pl-4 text-muted-foreground">
          {agentRows.slice(0, 8).map((r, i) => (
            <li key={i}>{String(r.actor || r.agent_type || "?")} — {String(r.status || "?")}</li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">Agent heartbeats roll up in /ui/overview (active_agents, active_workflows). Detailed rows load on demand.</p>
      )}
      <p className="text-xs text-muted-foreground">Source: /ui/overview summary; detailed agent_runs via /ui/database/agent_runs when tab is active (visibility-based refresh, no setInterval).</p>
    </div>
  );
}
