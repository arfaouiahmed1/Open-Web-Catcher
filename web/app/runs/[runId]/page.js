import { notFound } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { KpiCard } from "@/components/kpi-card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

function statusTone(s) {
  if (s === "success") return "success";
  if (s === "partial") return "warning";
  return "danger";
}

export default async function RunDetailPage({ params }) {
  let payload = null;
  try {
    payload = await apiFetch(`/ui/runs/${params.runId}`);
  } catch {
    notFound();
  }

  /* ── active (in-memory) run ──────────────────────────────────────────── */
  if (payload?.active_trace) {
    const trace   = payload.active_trace;
    const metrics = trace.metrics || {};
    return (
      <div className="space-y-6">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-signal">Run Detail</p>
          <h1 className="mt-1 text-2xl font-semibold text-white">Live run in memory</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            This run hasn't been persisted yet — data is streaming from the in-memory observability store.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Events"     value={formatNumber((trace.events || []).length)} />
          <KpiCard label="LLM Calls"  value={formatNumber(metrics.total_llm_calls || 0)} />
          <KpiCard label="Tool Calls" value={formatNumber(metrics.total_tool_calls || 0)} />
          <KpiCard label="Cost"       value={formatCurrency(metrics.estimated_total_cost_usd || 0)} />
        </div>
        <JsonViewer label="Active Trace" value={trace} />
      </div>
    );
  }

  /* ── persisted run ───────────────────────────────────────────────────── */
  const run       = payload?.run || {};
  const snapshot  = payload?.snapshot || {};
  const agentRuns = payload?.agent_runs || [];
  const llmCalls  = payload?.llm_calls || [];
  const toolCalls = payload?.tool_calls || [];
  const events    = payload?.events || [];

  const kpis = [
    { label: "Streams",     value: formatNumber(run.stream_count || 0) },
    { label: "Screenshots", value: formatNumber(run.screenshot_count || 0) },
    { label: "Emails",      value: formatNumber(run.email_count || 0) },
    { label: "LLM Calls",   value: formatNumber(run.total_llm_calls || 0) },
    { label: "Tool Calls",  value: formatNumber(run.total_tool_calls || 0) },
    { label: "Total Cost",  value: formatCurrency(run.estimated_total_cost_usd || 0) },
  ];

  return (
    <div className="space-y-6">

      {/* header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-signal">Run Detail</p>
          <h1 className="mt-1 font-mono text-lg font-semibold text-white">{run.run_id}</h1>
          <p className="mt-0.5 max-w-xl truncate text-sm text-slate-500" title={run.url}>{run.url}</p>
        </div>
        <Badge tone={statusTone(run.final_status)} className="mt-1">
          {run.final_status || "unknown"}
        </Badge>
      </div>

      {/* kpis */}
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => <KpiCard key={k.label} {...k} />)}
      </div>

      {/* agent + tool calls */}
      <div className="grid gap-5 xl:grid-cols-2">
        <DataTable
          title="Agent Runs"
          description="Per-agent normalized execution records"
          columns={["actor","agent_type","status","tool_calls_made","llm_calls_made","duration_seconds"]}
          rows={agentRuns}
        />
        <DataTable
          title="Tool Calls"
          description="Tool usage and reliability trail"
          columns={["seq","tool_name","status","duration_seconds","target_summary"]}
          rows={toolCalls}
        />
      </div>

      {/* llm + events */}
      <div className="grid gap-5 xl:grid-cols-2">
        <DataTable
          title="LLM Calls"
          description="Prompt, token, and cost telemetry"
          columns={["seq","provider","model_name","input_tokens","output_tokens","estimated_total_cost_usd"]}
          rows={llmCalls}
        />
        <DataTable
          title="Event Timeline"
          description="Structured event feed for this run"
          columns={["seq","actor","kind","status","message"]}
          rows={events}
        />
      </div>

      {/* raw data */}
      <div className="grid gap-5 xl:grid-cols-2">
        <JsonViewer label="Snapshot" value={snapshot} />
        <JsonViewer label="Run Payload" value={run} />
      </div>

    </div>
  );
}
