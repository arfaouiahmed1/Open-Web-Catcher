import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { OverviewVisuals } from "./overview-visuals";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const FIXTURE_OVERVIEW = {
  summary: {
    total_runs: 10,
    terminal_runs: 9,
    status_breakdown: { success: 5, partial: 1, no_streams: 2, failed: 1 },
    total_cost_usd: 4.5,
    total_tokens: 50000,
  },
  trend: [
    { date: "2026-08-29", runs: 2, successes: 1, partials: 0, failures: 1, running: 0, tokens: 10000, cost_usd: 1.0, avg_latency_seconds: 12 },
    { date: "2026-08-30", runs: 3, successes: 2, partials: 0, failures: 0, running: 1, tokens: 15000, cost_usd: 1.5, avg_latency_seconds: 22 },
    { date: "2026-08-31", runs: 5, successes: 2, partials: 1, failures: 1, running: 1, tokens: 25000, cost_usd: 2.0, avg_latency_seconds: 35 },
  ],
  model_breakdown: [
    { label: "google::gemini-2.0", provider: "google", model_name: "gemini-2.0", calls: 6, tokens: 30000, cost_usd: 3.0 },
    { label: "openai::gpt-4", provider: "openai", model_name: "gpt-4", calls: 3, tokens: 20000, cost_usd: 1.5 },
  ],
  provider_breakdown: [],
  top_tools: [
    { tool_name: "navigate", calls: 20, successes: 19, errors: 1, success_rate: 0.95, avg_duration_seconds: 2.1 },
    { tool_name: "inspect", calls: 12, successes: 9, errors: 3, success_rate: 0.75, avg_duration_seconds: 1.2 },
  ],
  recent_runs: [],
  active_runs: [],
};

describe("OverviewVisuals", () => {
  it("renders the five dashboard charts from exact /ui/overview fields", () => {
    const markup = html(
      <OverviewVisuals overview={FIXTURE_OVERVIEW as unknown as Record<string, unknown>} state="success" />,
    );
    expect(markup).toContain("token trend");
    expect(markup).toContain("Run outcomes");
    expect(markup).toContain("Daily latency");
    expect(markup).toContain("Spend by provider");
    expect(markup).toContain("Tool reliability");
    // Outcome donut groups exact status_breakdown counts
    expect(markup).toContain("Success");
    expect(markup).toContain("No target");
    expect(markup).toContain("9");
    // Provider/model distribution uses exact model_breakdown rows
    expect(markup).toContain("google");
    expect(markup).toContain("openai");
    expect(markup).toContain("gemini-2.0");
    // Tool reliability uses exact top_tools rows
    expect(markup).toContain("navigate");
    expect(markup).toContain("inspect");
  });

  it("renders no formula, SQL, or aggregation internals", () => {
    const markup = html(
      <OverviewVisuals overview={FIXTURE_OVERVIEW as unknown as Record<string, unknown>} state="success" />,
    );
    expect(markup).not.toContain("SUM(");
    expect(markup).not.toContain("COUNT(");
    expect(markup).not.toContain("AVG(");
    expect(markup).not.toContain("GROUP BY");
  });

  it("shows loading skeletons when overview is null", () => {
    const markup = html(<OverviewVisuals overview={null} state="loading" />);
    expect(markup).not.toContain("Run outcomes");
  });

  it("shows an error panel on error state", () => {
    const markup = html(<OverviewVisuals overview={{}} state="error" />);
    expect(markup).toContain("Could not load dashboard charts.");
  });

  it("shows an empty state when there is no data", () => {
    const markup = html(
      <OverviewVisuals overview={{ summary: { total_runs: 0 }, trend: [], model_breakdown: [], top_tools: [] }} state="success" />,
    );
    expect(markup).toContain("No dashboard data yet");
  });
});
