import { describe, expect, it } from "vitest";

import {
  buildContextWindowGroups,
  buildStageView,
  summarizeRunState,
} from "@/lib/run-trace";

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

  it("surfaces failure details from terminal error events", () => {
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
        kind: "llm_error",
        timestamp: "2026-05-03T18:00:10Z",
        message: "Model call failed: RuntimeError",
        details: {
          error_preview: "provider timeout while waiting for response",
        },
      },
    ];

    const state = summarizeRunState(events);
    expect(state.status).toBe("failed");
    expect(state.failure?.message).toContain("provider timeout");
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

describe("buildContextWindowGroups", () => {
  it("splits live context by stage instead of summing the workflow", () => {
    const events = [
      {
        seq: 10,
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
        seq: 20,
        actor: "hosting",
        kind: "llm_response",
        timestamp: "2026-05-03T18:02:10Z",
        details: {
          provider: "openrouter",
          model_name: "model-a",
          input_tokens: 27026,
          output_tokens: 240,
          context_window: 131072,
        },
      },
    ];

    const groups = buildContextWindowGroups({ events, active: true });
    expect(groups).toHaveLength(2);
    expect(groups[0].stage).toBe("classification");
    expect(groups[1].stage).toBe("hosting");
    expect(groups[0].llmCalls[0].input_tokens).toBe(42017);
    expect(groups[1].llmCalls[0].input_tokens).toBe(27026);
  });
});
