import { describe, expect, it } from "vitest";

import { buildAgentRunGraph } from "./agent-run-graph";

const events = [
  {
    seq: 1,
    actor: "orchestrator",
    kind: "pipeline_started",
    status: "started",
    message: "Pipeline started",
  },
  {
    seq: 2,
    actor: "classification",
    kind: "agent_started",
    status: "running",
    message: "Classification agent started for https://example.test",
    details: { context_window: 128000, context_tokens: 32000, context_usage_pct: 0.25 },
  },
  {
    seq: 3,
    actor: "classification",
    kind: "llm_response",
    status: "success",
    message: "Model response received",
    details: { input_tokens: 34000, output_tokens: 1200, context_window: 128000 },
  },
  {
    seq: 4,
    actor: "classification",
    kind: "tool_call_finished",
    status: "success",
    message: "browser probe completed",
    details: { tool_name: "browser_probe" },
  },
  {
    seq: 5,
    actor: "classification",
    kind: "agent_finished",
    status: "success",
    message: "Classification decided landing_page",
  },
  {
    seq: 6,
    actor: "landing",
    kind: "agent_started",
    status: "running",
    message: "Landing page agent started",
    details: { context_window: 200000, context_tokens: 80000 },
  },
];

describe("buildAgentRunGraph", () => {
  it("builds a live root-to-agent topology from events", () => {
    const graph = buildAgentRunGraph({ events, rootActor: "orchestrator" });

    expect(graph.agentNodes.map((node) => node.actor)).toEqual(["classification", "landing"]);
    expect(graph.nodes[0].kind).toBe("root");
    expect(graph.edges.some((edge) => edge.source === "root" && edge.target === graph.agentNodes[0].id)).toBe(true);
    expect(graph.edges.some((edge) => edge.animated)).toBe(true);
  });

  it("derives agent counts, activity, tool/LLM calls, and peak context telemetry", () => {
    const graph = buildAgentRunGraph({ events, rootActor: "orchestrator" });

    expect(graph.summary.agentCount).toBe(2);
    expect(graph.summary.activeAgentCount).toBe(1);
    expect(graph.summary.toolCallCount).toBe(1);
    expect(graph.summary.llmCallCount).toBe(1);
    expect(graph.summary.contextWindow).toBe(200000);
    expect(graph.summary.contextTokens).toBe(80000);
    expect(graph.agentNodes[0].latestActivity).toBe("Classification decided landing_page");
    expect(graph.agentNodes[0].safeLatestActivity).not.toContain("https://");
  });

  it("merges persisted rollups without duplicating their event-backed agent", () => {
    const graph = buildAgentRunGraph({
      events,
      rootActor: "orchestrator",
      agentRollups: [
        {
          agent_run_id: 7,
          actor: "classification",
          agent_type: "classification",
          status: "success",
          llm_calls: 2,
          tool_calls: 3,
          total_tokens: 35200,
          context_window: 128000,
          context_tokens: 35200,
          context_usage_pct: 0.275,
          duration_seconds: 4.2,
        },
      ],
    });

    expect(graph.agentNodes.filter((node) => node.actor === "classification")).toHaveLength(1);
    expect(graph.agentNodes[0].llmCalls).toBe(2);
    expect(graph.agentNodes[0].toolCalls).toBe(3);
    expect(graph.agentNodes[0].durationSeconds).toBe(4.2);
  });
});
