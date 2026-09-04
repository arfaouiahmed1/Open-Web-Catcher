/**
 * Overview KPIs — operator headline metrics from GET /ui/overview.
 *
 * Reads the pre-rolled `summary` block (run health, latency, spend, tokens,
 * websites, tool reliability, stream yield, provider status) plus the 7-day
 * `trend` buckets and per-model `model_breakdown` rows for the spend fallback.
 *
 * All tile subtitles use plain operator language; formula and query details
 * stay in backend code and docs, never in this UI.
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

  // effectiveTotalCost prefers the recorded spend total, falling back to the per-model total
  const recordedTotalCost = Number((summary as Record<string, unknown>).total_cost_usd || 0);
  const rawModelRows = ((overview as Record<string, unknown>).model_breakdown ?? []) as Array<Record<string, unknown>>;
  const computedModelCost = rawModelRows.reduce((s: number, r) => s + Number((r as Record<string, unknown>).cost_usd || 0), 0);
  const effectiveTotalCost = recordedTotalCost > 0 ? recordedTotalCost : computedModelCost;

  // Row 1: headline health
  const row1 = [
    {
      label: "Total runs",
      value: formatNumber(Number((summary as Record<string, unknown>).total_runs || 0)),
      hint: "Total pipeline runs executed",
    },
    {
      label: "Success rate",
      value: formatPercent(dashboardSuccessRate),
      hint: "Runs yielding target streams or pages",
    },
    {
      label: "Avg latency",
      value: `${Number((summary as Record<string, unknown>).avg_latency_seconds || 0).toFixed(1)}s`,
      hint: "Average end-to-end processing time",
    },
    {
      label: "Total cost",
      value: formatCurrency(effectiveTotalCost),
      hint: recordedTotalCost > 0 ? "Estimated aggregate model spend" : "Estimated from token usage",
    },
  ];

  const row2 = [
    {
      label: "Total tokens",
      value: formatNumber(Number((summary as Record<string, unknown>).total_tokens || 0)),
      hint: "Combined prompt and generation tokens",
    },
    {
      label: "Working websites",
      value: formatNumber(distinctWorkingWebsites),
      hint: "Distinct working stream sites",
    },
    {
      label: "Failed 24 h",
      value: formatNumber(Number((summary as Record<string, unknown>).failed_run_window_24h || 0)),
      hint: "Failures recorded in the last 24 hours",
    },
    {
      label: "Tool success",
      value: formatPercent(Number((summary as Record<string, unknown>).tool_success_rate || 0)),
      hint: "Successful MCP tool calls",
    },
  ];

  const row3 = [
    {
      label: "LLM calls",
      value: formatNumber(Number((summary as Record<string, unknown>).total_llm_calls || 0)),
      hint: "Total model completions",
    },
    {
      label: "Stream yield",
      value: formatPercent(Number((summary as Record<string, unknown>).stream_yield_rate || 0)),
      hint: "Runs with captured playable streams",
    },
    {
      label: "LLM API",
      value: llmProviderStatus,
      hint: llmProviderBlockedRuns ? `${formatNumber(llmProviderBlockedRuns)} runs held by provider limits` : "Provider rate limit & availability status",
    },
    {
      label: "No streams/hosting",
      value: formatNumber(noStreamOrHostingRuns),
      hint: "Runs completed with no stream targets",
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
    </div>
  );
}
