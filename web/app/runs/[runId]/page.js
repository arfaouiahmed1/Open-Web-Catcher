import { notFound } from "next/navigation";

import { apiFetch } from "@/lib/api";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({ params }) {
  let payload = null;
  try {
    payload = await apiFetch(`/ui/runs/${params.runId}`);
  } catch (error) {
    notFound();
  }

  if (payload?.active_trace) {
    const trace = payload.active_trace;
    const metrics = trace.metrics || {};
    return (
      <div className="space-y-6">
        <section className="max-w-4xl">
          <div className="text-xs uppercase tracking-[0.4em] text-signal">Run Detail</div>
          <h1 className="mt-3 text-4xl font-semibold">Live run still in memory</h1>
          <p className="mt-4 text-base leading-7 text-slate-300">
            This run has not been persisted yet, so the detail view is streaming straight from the in-memory observability registry.
          </p>
        </section>

        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard label="Events" value={formatNumber((trace.events || []).length)} />
          <MetricCard label="LLM Calls" value={formatNumber(metrics.total_llm_calls || 0)} />
          <MetricCard label="Tool Calls" value={formatNumber(metrics.total_tool_calls || 0)} />
          <MetricCard label="Cost" value={formatCurrency(metrics.estimated_total_cost_usd || 0)} />
        </div>

        <JsonViewer label="Active Trace" value={trace} />
      </div>
    );
  }

  const run = payload?.run || {};
  const snapshot = payload?.snapshot || {};
  const agentRuns = payload?.agent_runs || [];
  const llmCalls = payload?.llm_calls || [];
  const toolCalls = payload?.tool_calls || [];
  const events = payload?.events || [];

  return (
    <div className="space-y-6">
      <section className="max-w-4xl">
        <div className="text-xs uppercase tracking-[0.4em] text-signal">Run Detail</div>
        <h1 className="mt-3 text-4xl font-semibold">{run.run_id}</h1>
        <p className="mt-4 text-base leading-7 text-slate-300">
          Deep inspection for a single orchestrator run, including structured snapshot data, normalized tool and model activity, and the event timeline.
        </p>
      </section>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Run Summary</CardTitle>
            <CardDescription>{run.url}</CardDescription>
          </div>
          <Badge tone={run.final_status === "success" ? "success" : run.final_status === "partial" ? "warning" : "danger"}>
            {run.final_status || "unknown"}
          </Badge>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
          <MetricCard label="Streams" value={formatNumber(run.stream_count || 0)} />
          <MetricCard label="Screenshots" value={formatNumber(run.screenshot_count || 0)} />
          <MetricCard label="Emails" value={formatNumber(run.email_count || 0)} />
          <MetricCard label="LLM Calls" value={formatNumber(run.total_llm_calls || 0)} />
          <MetricCard label="Tool Calls" value={formatNumber(run.total_tool_calls || 0)} />
          <MetricCard label="Total Cost" value={formatCurrency(run.estimated_total_cost_usd || 0)} />
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <DataTable
          title="Agent Runs"
          description="Per-agent normalized execution records."
          columns={["actor", "agent_type", "status", "tool_calls_made", "llm_calls_made", "duration_seconds"]}
          rows={agentRuns}
        />
        <DataTable
          title="Tool Calls"
          description="Tool usage and reliability trail."
          columns={["seq", "tool_name", "status", "duration_seconds", "target_summary"]}
          rows={toolCalls}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <DataTable
          title="LLM Calls"
          description="Prompt, token, and cost telemetry."
          columns={["seq", "provider", "model_name", "input_tokens", "output_tokens", "estimated_total_cost_usd"]}
          rows={llmCalls}
        />
        <DataTable
          title="Events"
          description="Structured event feed persisted for the run."
          columns={["seq", "actor", "kind", "status", "message"]}
          rows={events}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <JsonViewer label="Snapshot" value={snapshot} />
        <JsonViewer label="Run Payload" value={payload} />
      </div>
    </div>
  );
}

function MetricCard({ label, value }) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
      <div className="text-xs uppercase tracking-[0.3em] text-slate-500">{label}</div>
      <div className="mt-3 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}
