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
    active_runs: []
  };

  try {
    overview = await apiFetch("/ui/overview");
  } catch (error) {
    console.error(error);
  }

  const summary = overview.summary || {};
  const evaluationSummary = overview.evaluation_summary || {};
  const kpis = [
    {
      label: "Total Runs",
      value: formatNumber(summary.total_runs || 0),
      description: "Persisted workflow runs across the full Postgres corpus.",
      accent: "from-signal/20 to-transparent"
    },
    {
      label: "Success Rate",
      value: formatPercent(summary.success_rate || 0),
      description: "Completed workflow runs with final success status.",
      accent: "from-surge/20 to-transparent"
    },
    {
      label: "Total Tokens",
      value: formatNumber(summary.total_tokens || 0),
      description: "Combined prompt and completion tokens from all persisted runs.",
      accent: "from-spark/20 to-transparent"
    },
    {
      label: "Total Cost",
      value: formatCurrency(summary.total_cost_usd || 0),
      description: "First-party model cost accounting.",
      accent: "from-white/10 to-transparent"
    },
    {
      label: "Tool Success",
      value: formatPercent(summary.tool_success_rate || 0),
      description: "Observed success rate across persisted tool call records.",
      accent: "from-emerald-500/20 to-transparent"
    },
    {
      label: "Avg Latency",
      value: `${formatNumber(summary.avg_latency_seconds || 0)}s`,
      description: "Average end-to-end runtime per workflow run.",
      accent: "from-cyan-500/20 to-transparent"
    },
    {
      label: "Stream Yield",
      value: formatPercent(summary.stream_yield_rate || 0),
      description: "Runs that produced at least one captured stream.",
      accent: "from-orange-500/20 to-transparent"
    },
    {
      label: "Email Yield",
      value: formatPercent(summary.email_yield_rate || 0),
      description: "Runs that produced at least one takedown draft.",
      accent: "from-pink-500/20 to-transparent"
    }
  ];
  const evaluationKpis = [
    {
      label: "Eval Success",
      value: formatPercent(evaluationSummary.latest_success_rate || 0),
      description: "Latest persisted benchmark pass rate.",
      accent: "from-emerald-500/20 to-transparent"
    },
    {
      label: "Hallucination",
      value: formatPercent(evaluationSummary.latest_hallucination_rate || 0),
      description: "Unsupported-claim rate from the latest suite.",
      accent: "from-amber-500/20 to-transparent"
    },
    {
      label: "Tool Accuracy",
      value: formatPercent(evaluationSummary.latest_tool_accuracy_rate || 0),
      description: "Required versus forbidden tool discipline.",
      accent: "from-spark/20 to-transparent"
    },
    {
      label: "Reliability",
      value: formatPercent(evaluationSummary.latest_reliability_rate || 0),
      description: "Observed tool stability during evaluation.",
      accent: "from-signal/20 to-transparent"
    }
  ];

  return (
    <div className="space-y-8">
      <section>
        <div className="max-w-4xl">
          <div className="text-xs uppercase tracking-[0.4em] text-spark">Overview</div>
          <h1 className="mt-3 text-4xl font-semibold">The operator cockpit</h1>
          <p className="mt-4 text-base leading-7 text-slate-300">
            High-signal KPIs, live activity, model mix, provider mix, and evaluation health, all powered from the internal Postgres observability store.
          </p>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {kpis.map((item) => (
          <KpiCard key={item.label} {...item} />
        ))}
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {evaluationKpis.map((item) => (
          <KpiCard key={item.label} {...item} />
        ))}
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <DataTable
          title="Recent Runs"
          description="Latest persisted orchestrator runs."
          columns={["run_id", "url", "final_status", "stream_count", "estimated_total_cost_usd", "duration_seconds", "created_at"]}
          rows={overview.recent_runs || []}
        />
        <DataTable
          title="Model Breakdown"
          description="Model usage and cost by provider/model."
          columns={["label", "calls", "tokens", "cost_usd"]}
          rows={overview.model_breakdown || []}
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <DataTable
          title="Run Trend"
          description="Daily run, cost, token, and latency trend for the recent seven-day window."
          columns={["date", "runs", "successes", "partials", "failures", "tokens", "cost_usd", "avg_latency_seconds"]}
          rows={overview.trend || []}
        />
        <DataTable
          title="Provider Breakdown"
          description="Top downstream providers observed across persisted analyses."
          columns={["provider", "analysis_count", "affected_runs"]}
          rows={overview.provider_breakdown || []}
        />
        <DataTable
          title="Active Runs"
          description="In-memory activity still streaming from the backend."
          columns={["run_id", "root_actor", "event_count", "completed", "total_tool_calls", "estimated_total_cost_usd"]}
          rows={overview.active_runs || []}
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <DataTable
          title="Top Tools"
          description="Most frequently executed persisted tool calls with reliability signals."
          columns={["tool_name", "calls", "successes", "errors", "success_rate", "avg_duration_seconds"]}
          rows={overview.top_tools || []}
        />
        <DataTable
          title="Yield Metrics"
          description="DB-backed productivity indicators computed from normalized workflow rows."
          columns={["metric", "value"]}
          rows={[
            { metric: "Total LLM Calls", value: formatNumber(summary.total_llm_calls || 0) },
            { metric: "Total Tool Calls", value: formatNumber(summary.total_tool_calls || 0) },
            { metric: "Observed Tool Calls", value: formatNumber(summary.observed_tool_calls || 0) },
            { metric: "Avg Cost / Run", value: formatCurrency(summary.avg_cost_usd || 0) },
            { metric: "Avg Streams / Run", value: formatNumber(summary.avg_streams_per_run || 0) },
            { metric: "Avg Emails / Run", value: formatNumber(summary.avg_emails_per_run || 0) },
            { metric: "Total Provider Analyses", value: formatNumber(summary.total_provider_analyses || 0) },
            { metric: "Active In-Memory Runs", value: formatNumber(summary.active_runs || 0) }
          ]}
        />
      </section>
    </div>
  );
}
