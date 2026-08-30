/**
 * @vitest-environment node
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { CostMeterTab } from "./cost-meter-tab";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("CostMeterTab", () => {
  it("renders CostMeter from SSE metrics live", () => {
    const markup = html(
      <CostMeterTab
        metrics={{
          estimated_input_cost_usd: 0.01,
          estimated_cached_input_cost_usd: 0.02,
          estimated_cache_write_cost_usd: 0,
          estimated_output_cost_usd: 0.04,
          estimated_total_cost_usd: 0.07,
          total_tokens_in: 1200,
          total_tokens_out: 340,
          total_llm_calls: 5,
        }}
      />,
    );
    expect(markup).toContain('data-component="CostMeter"');
    expect(markup).toContain("$0.07");
    expect(markup).toContain('data-field="estimated_input_cost_usd"');
    expect(markup).toContain("1,200 in");
    expect(markup).toContain('data-component="MetricCard"');
  });

  it("accepts explicit costs and totalCostUsd fallback", () => {
    const markup = html(<CostMeterTab costs={{ estimated_input_cost_usd: 0.5 }} totalCostUsd={1.0} />);
    expect(markup).toContain("$1.00");
  });

  it("shows empty hint when no metrics", () => {
    const markup = html(<CostMeterTab metrics={null} />);
    expect(markup).toContain("No cost data yet");
  });
});
