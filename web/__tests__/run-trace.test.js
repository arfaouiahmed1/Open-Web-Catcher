import { describe, expect, it } from "vitest";

import {
  buildContextWindowGroups,
  buildPersistedLlmEvents,
  buildStageView,
  collectScreenshotUrls,
  summarizeRunState,
} from "@/lib/run-trace";
import { buildLlmRows } from "@/lib/llm-output-rows";

describe("summarizeRunState", () => {
  it("reports an in-flight model call", () => {
    const events = [
      {
        seq: 1,
        actor: "classification",
        kind: "agent_started",
        timestamp: "2026-05-03T18:00:00Z",
      },
      {
        seq: 2,
        actor: "classification",
        kind: "llm_turn_started",
        timestamp: "2026-05-03T18:00:01Z",
        details: {
          provider: "openrouter",
          model_name: "z-ai/glm-4.5-air:free",
        },
      },
    ];

    const state = summarizeRunState(events);
    expect(state.status).toBe("running");
    expect(state.active?.type).toBe("llm");
    expect(state.active?.stage).toBe("classification");
  });

  it("surfaces provider failure details from terminal error events", () => {
    const events = [
      {
        seq: 1,
        actor: "hosting",
        kind: "agent_started",
        timestamp: "2026-05-03T18:00:00Z",
      },
      {
        seq: 2,
        actor: "hosting",
        kind: "llm_rate_limited",
        timestamp: "2026-05-03T18:00:10Z",
        message: "Model call hit provider rate limits",
        details: {
          error_preview: "provider rate limit while waiting for response",
        },
      },
    ];

    const state = summarizeRunState(events);
    expect(state.status).toBe("failed");
    expect(state.failure?.kind).toBe("llm_rate_limited");
    expect(state.failure?.message).toContain("rate limit");
    expect(state.active?.type).toBe("failed");
  });
});

describe("buildStageView", () => {
  it("marks the stage live phase as tool when a tool call is pending", () => {
    const events = [
      {
        seq: 1,
        actor: "hosting",
        kind: "agent_started",
        timestamp: "2026-05-03T18:00:00Z",
      },
      {
        seq: 2,
        actor: "hosting",
        kind: "tool_call_started",
        timestamp: "2026-05-03T18:00:01Z",
        details: {
          tool_call_id: "tool-1",
          tool_name: "navigate",
          tool_args: { url: "https://example.test/watch" },
        },
      },
    ];

    const hosting = buildStageView(events).stages.find(
      (stage) => stage.stage === "hosting",
    );
    expect(hosting?.livePhase).toBe("tool");
    expect(hosting?.liveLabel).toBe("tool running");
  });
});

describe("collectScreenshotUrls", () => {
  it("keeps image evidence and rejects generic page URLs", () => {
    const urls = Array.from(
      collectScreenshotUrls({
        screenshot_url: "https://ppv.to/",
        nested: {
          screenshot_urls: [
            "https://img.example.com/trace/frame-1.png",
            "data:image/png;base64,abc123",
          ],
        },
      }),
    );

    expect(urls).toEqual([
      "https://img.example.com/trace/frame-1.png",
      "data:image/png;base64,abc123",
    ]);
  });
});

describe("buildContextWindowGroups", () => {
  it("splits live context per agent invocation", () => {
    const events = [
      {
        seq: 1,
        actor: "classification",
        kind: "agent_started",
        timestamp: "2026-05-03T18:00:00Z",
      },
      {
        seq: 2,
        actor: "classification",
        kind: "llm_response",
        timestamp: "2026-05-03T18:00:10Z",
        details: {
          provider: "openrouter",
          model_name: "model-a",
          input_tokens: 42017,
          output_tokens: 719,
          context_window: 131072,
        },
      },
      {
        seq: 3,
        actor: "classification",
        kind: "agent_finished",
        timestamp: "2026-05-03T18:00:20Z",
        status: "success",
      },
      {
        seq: 4,
        actor: "classification",
        kind: "agent_started",
        timestamp: "2026-05-03T18:01:00Z",
      },
      {
        seq: 5,
        actor: "classification",
        kind: "llm_response",
        timestamp: "2026-05-03T18:01:10Z",
        details: {
          provider: "openrouter",
          model_name: "model-b",
          input_tokens: 27026,
          output_tokens: 240,
          context_window: 131072,
        },
      },
      {
        seq: 6,
        actor: "classification",
        kind: "agent_finished",
        timestamp: "2026-05-03T18:01:20Z",
        status: "success",
      },
      {
        seq: 7,
        actor: "hosting",
        kind: "agent_started",
        timestamp: "2026-05-03T18:02:00Z",
      },
      {
        seq: 8,
        actor: "hosting",
        kind: "llm_response",
        timestamp: "2026-05-03T18:02:10Z",
        details: {
          provider: "openrouter",
          model_name: "model-c",
          input_tokens: 12000,
          output_tokens: 100,
          context_window: 131072,
        },
      },
      {
        seq: 9,
        actor: "hosting",
        kind: "agent_finished",
        timestamp: "2026-05-03T18:02:20Z",
        status: "success",
      },
    ];

    const groups = buildContextWindowGroups({ events, active: true });
    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.key)).toEqual([
      "agent-classification-1",
      "agent-classification-2",
      "agent-hosting-1",
    ]);
    expect(groups[0].invocationIndex).toBe(1);
    expect(groups[1].invocationIndex).toBe(2);
    expect(groups[0].llmCalls[0].input_tokens).toBe(42017);
    expect(groups[1].llmCalls[0].input_tokens).toBe(27026);
    expect(groups[2].actor).toBe("hosting");
  });
});

describe("buildLlmRows", () => {
  it("converts persisted llm rows into output-panel events with agent context", () => {
    const events = buildPersistedLlmEvents({
      agentRuns: [
        {
          id: 42,
          actor: "classification",
          agent_type: "classification",
          invocation_index: 1,
        },
      ],
      llmCalls: [
        {
          agent_run_id: 42,
          seq: 1,
          provider: "openrouter",
          model_name: "model-a",
          input_tokens: 1200,
          output_tokens: 96,
          context_window: 131072,
          estimated_total_cost_usd: 0.0042,
          cost_source: "provider_pricing_catalog",
          content_preview: "Directory hub.",
          created_at: "2026-05-03T18:00:02Z",
        },
      ],
    });

    const rows = buildLlmRows(events);

    expect(events[0].actor).toBe("classification");
    expect(rows).toHaveLength(1);
    expect(rows[0].inputTokens).toBe(1200);
    expect(rows[0].contextWindow).toBe(131072);
    expect(rows[0].summary).toContain("Directory hub");
  });

  it("normalizes provider failures for the output panel", () => {
    const rows = buildLlmRows([
      {
        seq: 1,
        actor: "classification",
        kind: "llm_response",
        timestamp: "2026-05-03T18:00:01Z",
        details: {
          provider: "openrouter",
          model_name: "model-a",
          input_tokens: 42017,
          output_tokens: 719,
          context_window: 131072,
          estimated_total_cost_usd: 0.12,
          cost_source: "provider_pricing_catalog",
          provider_cache_active: true,
          usage_metadata: {
            cached_input_tokens: 1200,
            new_input_tokens: 40817,
            cache_hit: true,
          },
          response_metadata: {
            response_class: "success",
          },
          content_preview: "{\"page_type\":\"hosting_page\"}",
        },
      },
      {
        seq: 2,
        actor: "hosting",
        kind: "llm_timeout",
        timestamp: "2026-05-03T18:00:10Z",
        message: "Model call timed out",
        details: {
          provider: "openrouter",
          model_name: "model-b",
          cost_source: "provider_pricing_catalog",
          provider_cache_active: true,
          response_class: "timeout",
          error_preview: "provider timeout while waiting for response",
          response_metadata: {
            response_class: "timeout",
          },
        },
      },
    ]);

    const failure = rows.find((row) => row.kind === "llm_timeout");
    expect(rows).toHaveLength(2);
    expect(failure?.kindTone).toBe("danger");
    expect(failure?.kindLabel).toBe("timeout");
    expect(failure?.errorPreview).toContain("provider timeout");
    expect(failure?.costSource).toBe("provider_pricing_catalog");
    expect(failure?.providerCacheActive).toBe(true);
    expect(failure?.responseClass).toBe("timeout");
  });
});
