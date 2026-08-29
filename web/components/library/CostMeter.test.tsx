import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CostMeter } from "./CostMeter";
import type { RunCostFields } from "./types";

// Field names mirror RunMetrics (src/models/orchestrator.py).
const COSTS: RunCostFields = {
  estimated_input_cost_usd: 0.01,
  estimated_cached_input_cost_usd: 0.02,
  estimated_cache_write_cost_usd: 0.03,
  estimated_output_cost_usd: 0.04,
  estimated_total_cost_usd: 0.1,
};

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("CostMeter", () => {
  it("renders total plus per-field breakdown shares", () => {
    const markup = html(<CostMeter costs={COSTS} />);
    expect(markup).toContain('data-state="success"');
    expect(markup).toContain("$0.10"); // declared total wins over row sum
    for (const field of [
      "estimated_input_cost_usd",
      "estimated_cached_input_cost_usd",
      "estimated_cache_write_cost_usd",
      "estimated_output_cost_usd",
    ]) {
      expect(markup).toContain(`data-field="${field}"`);
    }
    expect(markup).toContain('data-share="10"'); // 0.01 / 0.10
    expect(markup).toContain('data-share="40"'); // 0.04 / 0.10
  });

  it("sums breakdown rows when no total is declared", () => {
    const markup = html(
      <CostMeter
        costs={{ estimated_input_cost_usd: 0.25, estimated_output_cost_usd: 0.75 }}
      />,
    );
    expect(markup).toContain("$1.00");
    expect(markup).toContain('data-share="25"');
    expect(markup).toContain('data-share="75"');
  });

  it("renders token counts when provided", () => {
    const markup = html(
      <CostMeter
        costs={COSTS}
        tokens={{ total_tokens_in: 1200, total_tokens_out: 340, total_llm_calls: 5 }}
      />,
    );
    expect(markup).toContain('data-role="tokens"');
    expect(markup).toContain("1,200 in");
    expect(markup).toContain("340 out");
    expect(markup).toContain("5 LLM calls");
  });

  it("supports loading / error / empty states", () => {
    expect(html(<CostMeter state="loading" />)).toContain('data-state="loading"');
    expect(html(<CostMeter state="error" errorLabel="costs down" />)).toContain(
      "costs down",
    );
    expect(html(<CostMeter costs={{}} />)).toContain('data-state="empty"');
  });
});
