import { apiFetch } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { DataTable } from "@/components/data-table";
import { KpiCard } from "@/components/kpi-card";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  let overview = {
    summary: {},
    trend: [],
    model_breakdown: [],
    provider_breakdown: [],
    recent_runs: [],
    evaluation_summary: {},
    active_runs: [],
    top_tools: [],
  };

  try {
    overview = await apiFetch("/ui/overview");
  } catch {
    /* backend may not be ready */
  }

  const s = overview.summary || {};
  const e = overview.evaluation_summary || {};

  const runKpis = [
    { label: "Total Runs",    value: formatNumber(s.total_runs || 0),    description: "All persisted orchestrator runs" },
    { label: "Success Rate",  value: formatPercent(s.success_rate || 0), description: "Runs with final success status", accent: "text-surge" },
    { label: "Avg Latency",   value: `${(s.avg_latency_seconds || 0).toFixed(1)}s`, description: "End-to-end runtime per run" },
    { label: "Total Cost",    value: formatCurrency(s.total_cost_usd || 0), description: "First-party model spend" },
    { label: "Total Tokens",  value: formatNumber(s.total_tokens || 0),  description: "Prompt + completion tokens" },
    { label: "Tool Success",  value: formatPercent(s.tool_success_rate || 0), description: "Observed tool call success", accent: "text-surge" },
    { label: "Stream Yield",  value: formatPercent(s.stream_yield_rate || 0),description: "Runs that extracted a stream" },
    { label: "Email Yield",   value: formatPercent(s.email_yield_rate || 0), description: "Runs that drafted a takedown" },
  ];

  const evalKpis = [
    { label: "Eval Pass Rate",   value: formatPercent(e.latest_success_rate || 0),       description: "Latest benchmark pass rate", accent: "text-surge" },
    { label: "Hallucination",    value: formatPercent(e.latest_hallucination_rate || 0),  description: "Unsupported-claim rate", accent: (e.latest_hallucination_rate || 0) > 0.2 ? "text-ember" : undefined },
    { label: "Tool Accuracy",    value: formatPercent(e.latest_tool_accuracy_rate || 0),  description: "Required tool discipline" },
    { label: "Reliability",      value: formatPercent(e.latest_reliability_rate || 0),    description: "Tool stability during eval" },
  ];

  return (
    <div className="space-y-8">

      {/* header */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-spark">Overview</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">Operator Dashboard</h1>
        <p className="mt-1 text-sm text-slate-500">
          Live KPIs, model mix, provider breakdown, and evaluation health from the internal Postgres store.
        </p>
      </div>

      {/* run KPIs */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-600">Pipeline</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {runKpis.map((k) => <KpiCard key={k.label} {...k} />)}
        </div>
      </section>

      {/* eval KPIs */}
      <section>
        <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-600">Evaluation</h2>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {evalKpis.map((k) => <KpiCard key={k.label} {...k} />)}
        </div>
      </section>

      {/* tables row 1 */}
      <section className="grid gap-5 xl:grid-cols-2">
        <DataTable
          title="Recent Runs"
          description="Latest persisted orchestrator runs"
          columns={["run_id","url","final_status","stream_count","total_cost_usd","duration_seconds","created_at"]}
          rows={overview.recent_runs || []}
        />
        <DataTable
          title="Active Runs"
          description="In-memory runs still streaming"
          columns={["run_id","root_actor","event_count","completed","total_tool_calls","total_cost_usd"]}
          rows={overview.active_runs || []}
        />
      </section>

      {/* tables row 2 */}
      <section className="grid gap-5 xl:grid-cols-2">
        <DataTable
          title="Model Breakdown"
          description="Usage and cost by model"
          columns={["label","calls","tokens","cost_usd"]}
          rows={overview.model_breakdown || []}
        />
        <DataTable
          title="Provider Breakdown"
          description="Top downstream CDN / hosting providers"
          columns={["provider","analysis_count","affected_runs"]}
          rows={overview.provider_breakdown || []}
        />
      </section>

      {/* tables row 3 */}
      <section className="grid gap-5 xl:grid-cols-2">
        <DataTable
          title="Run Trend (7d)"
          description="Daily run, cost, token, and latency"
          columns={["date","runs","successes","partials","failures","tokens","cost_usd","avg_latency_seconds"]}
          rows={overview.trend || []}
        />
        <DataTable
          title="Top Tools"
          description="Most-used tools with reliability signals"
          columns={["tool_name","calls","successes","errors","success_rate","avg_duration_seconds"]}
          rows={overview.top_tools || []}
        />
      </section>

    </div>
  );
}
