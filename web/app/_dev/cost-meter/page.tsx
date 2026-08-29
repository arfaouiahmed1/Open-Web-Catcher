"use client";

import React from "react";
import { CostMeter } from "@/components/library";
import type { RunCostFields } from "@/components/library";

// Field names mirror RunMetrics (src/models/orchestrator.py) JSON keys.
const COSTS: RunCostFields = {
  estimated_input_cost_usd: 0.0132,
  estimated_cached_input_cost_usd: 0.0009,
  estimated_cache_write_cost_usd: 0.0031,
  estimated_output_cost_usd: 0.0428,
  estimated_total_cost_usd: 0.06,
};

export default function CostMeterStory() {
  return (
    <>
      <CostMeter state="loading" loadingLabel="Loading costs…" />
      <CostMeter state="error" errorLabel="Cost aggregation failed." />
      <CostMeter costs={{}} />
      <CostMeter
        costs={COSTS}
        tokens={{
          total_tokens_in: 48210,
          total_tokens_out: 6120,
          total_llm_calls: 23,
        }}
      />
      {/* No declared total: meter sums the breakdown rows. */}
      <CostMeter
        costs={{ estimated_input_cost_usd: 0.01, estimated_output_cost_usd: 0.03 }}
      />
    </>
  );
}
