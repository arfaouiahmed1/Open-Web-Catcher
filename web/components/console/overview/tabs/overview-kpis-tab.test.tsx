import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { OverviewKpisTab } from "./overview-kpis-tab";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const FIXTURE_OVERVIEW = {
  summary: {
    total_runs: 42,
    terminal_runs: 40,
    running_runs: 2,
    success_rate: 0.8,
    status_breakdown: { success: 32, failed: 8 },
    llm_provider_blocked_runs: 0,
    total_tokens: 123456,
    total_llm_calls: 99,
    total_cost_usd: 12.34,
    avg_latency_seconds: 18.5,
    tool_success_rate: 0.92,
    stream_yield_rate: 0.65,
    distinct_working_websites: 7,
    failed_run_window_24h: 3,
    no_stream_or_hosting_runs: 1,
  },
  trend: [
    { cost_usd: 1, tokens: 1000, runs: 5, avg_latency_seconds: 10 },
    { cost_usd: 2, tokens: 2000, runs: 6, avg_latency_seconds: 12 },
  ],
  model_breakdown: [{ provider: "openai", model_name: "gpt-4", cost_usd: 5, tokens: 1000 }],
  provider_breakdown: [],
  top_tools: [],
  recent_runs: [],
  active_runs: [],
};

describe("OverviewKpisTab", () => {
  it("renders 12 KPIs from single /ui/overview payload via MetricCard", () => {
    const markup = html(<OverviewKpisTab overview={FIXTURE_OVERVIEW as unknown as Record<string, unknown>} />);
    // Row1
    expect(markup).toContain("Total runs");
    expect(markup).toContain("42");
    expect(markup).toContain("Success rate");
    expect(markup).toContain("Avg latency");
    expect(markup).toContain("Total cost");
    // Row2
    expect(markup).toContain("Total tokens");
    expect(markup).toContain("Working websites");
    expect(markup).toContain("Failed 24 h");
    expect(markup).toContain("Tool success");
    // Row3
    expect(markup).toContain("LLM calls");
    expect(markup).toContain("Stream yield");
    expect(markup).toContain("LLM API");
    expect(markup).toContain("No streams/hosting");
    // Operator-friendly subtitles (Phase 4 acceptance)
    expect(markup).toContain("Total pipeline runs executed");
    expect(markup).toContain("Runs yielding target streams or pages");
    expect(markup).toContain("Average end-to-end processing time");
    expect(markup).toContain("Estimated aggregate model spend");
    expect(markup).toContain("Combined prompt and generation tokens");
    expect(markup).toContain("Distinct working stream sites");
    expect(markup).toContain("Failures recorded in the last 24 hours");
    expect(markup).toContain("Successful MCP tool calls");
    expect(markup).toContain("Total model completions");
    expect(markup).toContain("Runs with captured playable streams");
    expect(markup).toContain("Provider rate limit &amp; availability status");
    expect(markup).toContain("Runs completed with no stream targets");
  });

  it("renders no formula, SQL, or aggregation internals", () => {
    const markup = html(<OverviewKpisTab overview={FIXTURE_OVERVIEW as unknown as Record<string, unknown>} />);
    expect(markup).not.toContain("KPI formulas");
    expect(markup).not.toContain("SUM(");
    expect(markup).not.toContain("COUNT(");
    expect(markup).not.toContain("AVG(");
    expect(markup).not.toContain("GROUP BY");
    expect(markup).not.toContain("T35");
    expect(markup).not.toContain("<details");
  });

  it("shows loading state when overview is null", () => {
    const markup = html(<OverviewKpisTab overview={null} state="loading" />);
    expect(markup).toContain('data-state="loading"');
  });

  it("labels the token-priced fallback in plain language when recorded cost is zero", () => {
    const noCost = {
      ...FIXTURE_OVERVIEW,
      summary: { ...FIXTURE_OVERVIEW.summary, total_cost_usd: 0 },
    };
    const markup = html(<OverviewKpisTab overview={noCost as unknown as Record<string, unknown>} />);
    expect(markup).toContain("Estimated from token usage");
    expect(markup).not.toContain("SUM");
  });
});
