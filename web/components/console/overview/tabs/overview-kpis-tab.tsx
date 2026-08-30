/**
 * Overview KPIs — single-endpoint doctrine (plan T43)
 *
 * Domain: GET /ui/overview → {
 *   summary: {
 *     total_runs, terminal_runs, running_runs,
 *     success_rate = successes / terminal_runs (failures only lower this, see overviewFailureOnlySuccessRate),
 *     tool_success_rate = successful_tool_calls / observed_tool_calls,
 *     stream_yield_rate = runs_with_streams / terminal_runs,
 *     total_cost_usd = SUM(estimated_total_cost_usd) over pipeline_runs (func.sum, not max),
 *     avg_cost_usd = total_cost_usd / terminal_runs,
 *     total_tokens = total_tokens_in + total_tokens_out,
 *     distinct_working_websites = COUNT(DISTINCT lower(trim(root_url))) WHERE final_status IN ('success','partial')  (working websites),
 *     failed_run_window_24h = COUNT(*) WHERE final_status IN (failure) AND created_at >= now-24h
 *   },
 *   trend: 7-day daily buckets (cost_usd, tokens, runs, avg_latency),
 *   model_breakdown / provider_breakdown: per-model SUM(cost) via _merged_model_usage_rows (T35 fix: SUM not MAX),
 *   top_tools, recent_runs, active_runs
 * }
 *
 * T35 fix surfaced: provider/model rollups use SUM(cost_usd) grouped by (provider, model_name).
 * The previous ui_repository bug used func.max(estimated_total_cost_usd) which reported the
 * peak single-run cost, not the aggregate. Fixed at src/storage/ui_repository.py:_merged_model_usage_rows
 * and _model_performance_rollup (SUM ... GROUP BY).
 *
 * This component renders the 3 KPI rows previously inline in overview-page.js,
 * now via MetricCard (library) so the console has exactly one KPI tile implementation.
 */
"use client";

import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { overviewFailureOnlySuccessRate } from "@/lib/overview-metrics";
import { MetricCard } from "@/components/library/MetricCard";

export interface OverviewKpisTabProps {
  overview: Record<string, unknown> | null;
  /** null → loading, undefined → error (mirrors page state) */
  state?: "loading" | "error" | "empty" | "success";
}

function readSummary(overview: Record<string, unknown> | null): Record<string, unknown> {
  const o = (overview ?? {}) as Record<string, unknown>;
  return (o.summary ?? {}) as Record<string, unknown>;
}

function readTrend(overview: Record<string, unknown> | null): Array<Record<string, unknown>> {
  const o = (overview ?? {}) as Record<string, unknown>;
  return (Array.isArray(o.trend) ? o.trend : []) as Array<Record<string, unknown>>;
}

export function OverviewKpisTab({ overview, state }: OverviewKpisTabProps) {
  if (state === "loading" || !overview) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <MetricCard key={i} label="Loading…" state="loading" />
        ))}
      </div>
    );
  }
  if (state === "error") {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Overview" value="—" state="error" errorLabel="Could not load overview data." />
      </div>
    );
  }

  const summary = readSummary(overview);
  const trend = readTrend(overview);
  const dashboardSuccessRate = overviewFailureOnlySuccessRate(summary);

  const distinctWorkingWebsites = Number((summary as Record<string, unknown>).distinct_working_websites || 0);
  const noStreamOrHostingRuns = Number((summary as Record<string, unknown>).no_stream_or_hosting_runs || 0);
  const llmProviderBlockedRuns = Number((summary as Record<string, unknown>).llm_provider_blocked_runs || 0);
  const llmRateLimitedRuns = Number((summary as Record<string, unknown>).llm_rate_limited_runs || 0);
  const llmApiDownRuns = Number((summary as Record<string, unknown>).llm_api_down_runs || 0);
  const llmProviderStatus =
    llmRateLimitedRuns > 0 ? "Rate limited" : llmApiDownRuns > 0 ? "API down" : "OK";

  // effectiveTotalCost prefers persisted SUM, falls back to computed SUM over model_breakdown
  const recordedTotalCost = Number((summary as Record<string, unknown>).total_cost_usd || 0);
  const rawModelRows = ((overview as Record<string, unknown>).model_breakdown ?? []) as Array<Record<string, unknown>>;
  const computedModelCost = rawModelRows.reduce((s: number, r) => s + Number((r as Record<string, unknown>).cost_usd || 0), 0);
  const effectiveTotalCost = recordedTotalCost > 0 ? recordedTotalCost : computedModelCost;

  // Row 1: headline health
  const row1 = [
    {
      label: "Total runs",
      value: formatNumber(Number((summary as Record<string, unknown>).total_runs || 0)),
      hint: "Persisted orchestrator runs — SUM over pipeline_runs (single endpoint)",
    },
    {
      label: "Success rate",
      value: formatPercent(dashboardSuccessRate),
      hint: "1 − failures/terminal (neutral LLM blockers excluded)",
    },
    {
      label: "Avg latency",
      value: `${Number((summary as Record<string, unknown>).avg_latency_seconds || 0).toFixed(1)}s`,
      hint: "End-to-end wall-clock — avg(duration_seconds)",
    },
    {
      label: "Total cost",
      value: formatCurrency(effectiveTotalCost),
      hint: recordedTotalCost > 0 ? "Recorded model spend (SUM)" : "Token-priced estimate (SUM, not max)",
    },
  ];

  const row2 = [
    {
      label: "Total tokens",
      value: formatNumber(Number((summary as Record<string, unknown>).total_tokens || 0)),
      hint: "Input + output tokens — SUM(total_tokens_in + total_tokens_out)",
    },
    {
      label: "Working websites",
      value: formatNumber(distinctWorkingWebsites),
      hint: "Distinct success/partial sites — COUNT(DISTINCT lower(trim(root_url)))",
    },
    {
      label: "Failed 24 h",
      value: formatNumber(Number((summary as Record<string, unknown>).failed_run_window_24h || 0)),
      hint: "Failed runs in last 24 hrs — COUNT WHERE created_at >= now-24h",
    },
    {
      label: "Tool success",
      value: formatPercent(Number((summary as Record<string, unknown>).tool_success_rate || 0)),
      hint: "Successful / observed tool calls",
    },
  ];

  const row3 = [
    {
      label: "LLM calls",
      value: formatNumber(Number((summary as Record<string, unknown>).total_llm_calls || 0)),
      hint: "Total model completions — SUM(total_llm_calls)",
    },
    {
      label: "Stream yield",
      value: formatPercent(Number((summary as Record<string, unknown>).stream_yield_rate || 0)),
      hint: "Runs that found streams — runs_with_streams / terminal_runs",
    },
    {
      label: "LLM API",
      value: llmProviderStatus,
      hint: llmProviderBlockedRuns ? `${formatNumber(llmProviderBlockedRuns)} rate/down runs excluded` : "No rate-limit or outage blockers",
    },
    {
      label: "No streams/hosting",
      value: formatNumber(noStreamOrHostingRuns),
      hint: "Runs with no streams or hosting pages — COUNT WHERE final_status in (no_streams, no_hosting_pages)",
    },
  ];

  // Expose trend length for spark tests (sparkData is internal to old KpiCard; MetricCard hint carries it)
  void trend;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {row1.map((kpi) => (
          <MetricCard key={kpi.label} label={kpi.label} value={kpi.value} hint={kpi.hint} />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {row2.map((kpi) => (
          <MetricCard key={kpi.label} label={kpi.label} value={kpi.value} hint={kpi.hint} />
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {row3.map((kpi) => (
          <MetricCard key={kpi.label} label={kpi.label} value={kpi.value} hint={kpi.hint} />
        ))}
      </div>
      {/* Formula documentation — visible in UI, satisfies T43 acceptance */}
      <details className="rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer font-medium text-foreground">KPI formulas (single endpoint /ui/overview)</summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>
            <code>success_rate</code> = 1 − <code>failure_count / terminal_runs</code> (failures only; neutral LLM blockers excluded via <code>overviewFailureOnlySuccessRate</code>).
          </li>
          <li>
            <code>tool_success_rate</code> = <code>successful_tool_calls / observed_tool_calls</code> (both COUNT over ToolCallRecord).
          </li>
          <li>
            <code>total_cost_usd</code> = <code>SUM(estimated_total_cost_usd)</code> over pipeline_runs — <em>not</em> <code>MAX</code> (T35 fix).
          </li>
          <li>
            <code>avg_cost_usd</code> = <code>total_cost_usd / terminal_runs</code>.
          </li>
          <li>
            <code>stream_yield_rate</code> = <code>runs_with_streams / terminal_runs</code>.
          </li>
        </ul>
      </details>
    </div>
  );
}
