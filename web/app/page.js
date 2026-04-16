import { apiFetch } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { DataTable } from "@/components/data-table";
import { KpiCard } from "@/components/kpi-card";

function TokenBurnChart({ trend = [] }) {
  const rows = (trend || []).slice(-10);
  if (!rows.length) return null;
  const values = rows.map((row) => Number(row.tokens || 0));
  const max = Math.max(...values, 1);
  const points = rows.map((row, idx) => `${(idx / Math.max(rows.length - 1, 1)) * 100},${100 - ((Number(row.tokens || 0) / max) * 100)}`).join(" ");
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-600">Token burn rate (last 10)</div>
      <div className="h-32 rounded bg-black/20 p-2">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full">
          <polyline fill="none" stroke="rgba(117,169,255,0.95)" strokeWidth="2" points={points} />
        </svg>
      </div>
      <div className="mt-2 text-xs text-slate-600">Peak {formatNumber(max)} tokens/day</div>
    </div>
  );
}

function CostBreakdown({ modelBreakdown = [] }) {
  const rows = (modelBreakdown || []).slice(0, 5);
  const total = rows.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0) || 1;
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-600">Cost breakdown</div>
      <div className="space-y-1.5">
        {rows.map((row, idx) => {
          const pct = (Number(row.cost_usd || 0) / total) * 100;
          return (
            <div key={`${row.label}-${idx}`}>
              <div className="flex items-center text-xs">
                <span className="text-slate-400">{row.label}</span>
                <span className="ml-auto text-slate-600">{pct.toFixed(1)}%</span>
              </div>
              <div className="mt-1 h-2 rounded bg-black/20">
                <div className="h-2 rounded bg-signal/60" style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

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

      <section className="grid gap-5 xl:grid-cols-2">
        <TokenBurnChart trend={overview.trend || []} />
        <CostBreakdown modelBreakdown={overview.model_breakdown || []} />
      </section>

    </div>
  );
}
