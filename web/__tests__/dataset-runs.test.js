import { describe, expect, it } from "vitest";

import {
  datasetRunStatus,
  effectiveRunCost,
  runTokenTotal,
  statusToneForDataset,
  summarizeModelUsage,
} from "@/lib/dataset-runs";

describe("dataset run helpers", () => {
  it("uses persisted total cost before estimating", () => {
    expect(
      effectiveRunCost(
        {
          total_cost_usd: 0.42,
          model_usage: [
            {
              provider: "openai",
              model_name: "gpt-4.1",
              input_tokens: 1000,
              output_tokens: 1000,
            },
          ],
        },
        new Map(),
      ),
    ).toMatchObject({ total: 0.42, source: "logged" });
  });

  it("estimates uncaptured costs from provider pricing without provider-specific constants", () => {
    const pricing = new Map([
      [
        "openai|gpt-4.1-mini",
        {
          provider: "openai",
          model: "gpt-4.1-mini",
          input_per_million: 0.4,
          output_per_million: 1.6,
          cached_input_per_million: 0.1,
          cache_write_per_million: 0.2,
        },
      ],
    ]);

    const result = effectiveRunCost(
      {
        model_usage: [
          {
            provider: "openai",
            model_name: "gpt-4.1-mini",
            input_tokens: 3000,
            cached_input_tokens: 1000,
            new_input_tokens: 2000,
            output_tokens: 1000,
          },
        ],
      },
      pricing,
    );

    expect(result.source).toBe("priced");
    expect(result.total).toBeCloseTo(0.0025, 8);
  });

  it("summarizes status, tokens, and model labels consistently", () => {
    const row = {
      final_status: "success",
      run: { total_tokens_in: 12, total_tokens_out: 8 },
      model_usage: [
        { provider: "anthropic", model_name: "claude-sonnet-4.5" },
        { provider: "anthropic", model_name: "claude-sonnet-4.5" },
      ],
    };

    expect(datasetRunStatus(row)).toBe("success");
    expect(statusToneForDataset("failed")).toBe("danger");
    expect(runTokenTotal(row)).toBe(20);
    expect(summarizeModelUsage(row.model_usage)).toEqual([
      "anthropic / claude-sonnet-4.5",
    ]);
  });
});
