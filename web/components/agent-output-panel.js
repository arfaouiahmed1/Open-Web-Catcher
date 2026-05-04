"use client";

import { Layers3, Waypoints } from "lucide-react";

import { formatCurrency, formatNumber } from "@/lib/utils";
import { statusLabel, statusTone } from "@/lib/run-status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { StructuredDataCard } from "@/components/structured-data-card";

function Metric({ label, value }) {
  return (
    <div
      className="rounded-lg border border-border bg-muted/20 px-3 py-2"
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
        {label}
      </div>
      <div className="mt-1 font-mono text-[12px] text-foreground/80">
        {value}
      </div>
    </div>
  );
}

function StageCard({ row }) {
  return (
    <Card className="overflow-hidden shadow-card">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
              {row.agent_type}
            </div>
            <div className="mt-1 text-[13px] font-medium text-foreground">
              {row.actors?.length ? row.actors.join(" / ") : row.agent_type}
            </div>
          </div>
          <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric
            label="Invocations"
            value={formatNumber(row.invocations || 0)}
          />
          <Metric
            label="Parallel"
            value={`${formatNumber(row.active_parallel_agents || 0)} live / ${formatNumber(row.max_parallel_agents || 0)} peak`}
          />
          <Metric label="Tokens" value={formatNumber(row.total_tokens || 0)} />
          <Metric label="Cost" value={formatCurrency(row.cost_usd || 0)} />
        </div>

        {row.output_summary ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[12px] leading-relaxed text-foreground/80">
            {row.output_summary}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AgentCard({ row }) {
  return (
    <Card className="overflow-hidden shadow-card">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-[11px] text-muted-foreground/60">
              #{row.invocation_index || 0}
            </div>
            <div className="mt-1 text-[13px] font-medium text-foreground">
              {row.actor || row.agent_type}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {row.agent_type}
            </div>
          </div>
          <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Metric label="LLM" value={formatNumber(row.llm_calls || 0)} />
          <Metric label="Tools" value={formatNumber(row.tool_calls || 0)} />
          <Metric label="Tokens" value={formatNumber(row.total_tokens || 0)} />
          <Metric label="Cost" value={formatCurrency(row.cost_usd || 0)} />
        </div>

        {row.output_summary ? (
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-[12px] leading-relaxed text-foreground/80">
            {row.output_summary}
          </div>
        ) : null}

        {row.raw_output && Object.keys(row.raw_output).length > 0 ? (
          <div>
            <StructuredDataCard
              title={`${row.actor || row.agent_type} output summary`}
              description="Structured output fields captured for this agent run."
              data={row.raw_output}
              limit={6}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function AgentOutputPanel({
  stageRollups = [],
  agentRollups = [],
  parallelism = null,
  title = "Agent outputs",
}) {
  if (!stageRollups.length && !agentRollups.length) {
    return (
      <Card>
        <CardContent className="px-5 py-10 text-center text-sm text-muted-foreground">
          No agent output recorded yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden shadow-card">
        <CardHeader className="space-y-3 border-b border-border px-4 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <CardTitle className="text-sm font-medium">{title}</CardTitle>
              <CardDescription className="mt-0.5 text-sm">
                Stage output, per-agent tokens, and concurrent execution rollups.
              </CardDescription>
            </div>
            <div className="ml-auto flex flex-wrap gap-2">
              <Metric label="Stages" value={formatNumber(stageRollups.length)} />
              <Metric
                label="Agent runs"
                value={formatNumber(agentRollups.length)}
              />
              <Metric
                label="Live parallel"
                value={formatNumber(parallelism?.current_parallel_agents || 0)}
              />
              <Metric
                label="Peak parallel"
                value={formatNumber(parallelism?.max_parallel_agents || 0)}
              />
            </div>
          </div>
        </CardHeader>
      </Card>

      {stageRollups.length ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[12px] font-medium text-foreground">
            <Layers3 className="h-4 w-4 text-primary" />
            Stage rollups
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {stageRollups.map((row) => (
              <StageCard
                key={`${row.agent_type}-${row.started_at || row.invocations}`}
                row={row}
              />
            ))}
          </div>
        </div>
      ) : null}

      {agentRollups.length ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[12px] font-medium text-foreground">
            <Waypoints className="h-4 w-4 text-sky-400" />
            Agent runs
          </div>
          <div className="space-y-3">
            {agentRollups.map((row) => (
              <AgentCard
                key={`${row.agent_run_id}-${row.invocation_index}`}
                row={row}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
