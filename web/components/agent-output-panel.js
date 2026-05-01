"use client";

import { Layers3, Waypoints } from "lucide-react";

import { formatCurrency, formatNumber } from "@/lib/utils";
import { statusLabel, statusTone } from "@/lib/run-status";
import { Badge } from "@/components/ui/badge";
import { StructuredDataCard } from "@/components/structured-data-card";

function Metric({ label, value }) {
  return (
    <div
      className="rounded-[10px] border px-3 py-2"
      style={{
        borderColor: "var(--line)",
        background: "rgba(255,255,255,0.02)",
      }}
    >
      <div
        className="text-[10px] font-semibold uppercase tracking-[0.12em]"
        style={{ color: "var(--mute-3)" }}
      >
        {label}
      </div>
      <div
        className="mt-1 font-mono text-[12px]"
        style={{ color: "var(--ink-dim)" }}
      >
        {value}
      </div>
    </div>
  );
}

function StageCard({ row }) {
  return (
    <div
      className="rounded-[14px] border p-4"
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: "var(--signal)" }}
          >
            {row.agent_type}
          </div>
          <div className="mt-1 text-[13px] font-medium text-[var(--ink)]">
            {row.actors?.length ? row.actors.join(" / ") : row.agent_type}
          </div>
        </div>
        <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
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
        <div
          className="mt-3 rounded-[10px] border px-3 py-2.5 text-[12px] leading-relaxed"
          style={{
            borderColor: "var(--line)",
            background: "rgba(0,0,0,0.12)",
            color: "var(--ink-dim)",
          }}
        >
          {row.output_summary}
        </div>
      ) : null}
    </div>
  );
}

function AgentCard({ row }) {
  return (
    <div
      className="rounded-[14px] border p-4"
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div
            className="font-mono text-[11px]"
            style={{ color: "var(--mute-2)" }}
          >
            #{row.invocation_index || 0}
          </div>
          <div className="mt-1 text-[13px] font-medium text-[var(--ink)]">
            {row.actor || row.agent_type}
          </div>
          <div className="mt-0.5 text-[11px]" style={{ color: "var(--mute)" }}>
            {row.agent_type}
          </div>
        </div>
        <Badge tone={statusTone(row.status)}>{statusLabel(row.status)}</Badge>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="LLM" value={formatNumber(row.llm_calls || 0)} />
        <Metric label="Tools" value={formatNumber(row.tool_calls || 0)} />
        <Metric label="Tokens" value={formatNumber(row.total_tokens || 0)} />
        <Metric label="Cost" value={formatCurrency(row.cost_usd || 0)} />
      </div>

      {row.output_summary ? (
        <div
          className="mt-3 rounded-[10px] border px-3 py-2.5 text-[12px] leading-relaxed"
          style={{
            borderColor: "var(--line)",
            background: "rgba(0,0,0,0.12)",
            color: "var(--ink-dim)",
          }}
        >
          {row.output_summary}
        </div>
      ) : null}

      {row.raw_output && Object.keys(row.raw_output).length > 0 ? (
        <div className="mt-3">
          <StructuredDataCard
            title={`${row.actor || row.agent_type} output summary`}
            description="Structured output fields captured for this agent run."
            data={row.raw_output}
            limit={6}
          />
        </div>
      ) : null}
    </div>
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
      <div
        className="rounded-[14px] border px-5 py-10 text-center"
        style={{
          borderColor: "var(--line)",
          background: "var(--card)",
          color: "var(--mute)",
        }}
      >
        No agent output recorded yet.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div
        className="rounded-[14px] border p-4"
        style={{
          borderColor: "var(--line)",
          background: "var(--card)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <div className="text-[13.5px] font-medium text-[var(--ink)]">
              {title}
            </div>
            <div
              className="mt-0.5 text-[12px]"
              style={{ color: "var(--mute)" }}
            >
              Stage output, per-agent tokens, and concurrent execution rollups.
            </div>
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
      </div>

      {stageRollups.length ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--ink)]">
            <Layers3 className="h-4 w-4 text-[var(--signal)]" />
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
          <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--ink)]">
            <Waypoints className="h-4 w-4 text-[var(--sky)]" />
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
