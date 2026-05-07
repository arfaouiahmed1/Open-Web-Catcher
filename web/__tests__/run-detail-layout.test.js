import { describe, expect, it } from "vitest";

import { buildRunDetailTabState } from "@/lib/run-detail-layout";

describe("buildRunDetailTabState", () => {
  it("keeps orchestrator decisions in the ops tab", () => {
    const tabs = buildRunDetailTabState({
      decisionCount: 2,
      toolCallCount: 4,
      eventCount: 8,
      runState: { status: "running", failure: null },
    });

    expect(tabs.primaryTabs.map((entry) => entry.value)).toEqual([
      "summary",
      "tools",
      "events",
      "ops",
    ]);
    expect(tabs.primaryTabs.find((entry) => entry.value === "ops")?.count).toBe(2);
    expect(tabs.opsTabs.map((entry) => entry.value)).toEqual([
      "decisions",
    ]);
  });

  it("marks the events tab as dangerous when a failure is present", () => {
    const tabs = buildRunDetailTabState({
      eventCount: 5,
      runState: { status: "failed", failure: { kind: "tool_error" } },
    });

    expect(tabs.primaryTabs.find((entry) => entry.value === "events")?.tone).toBe("danger");
  });
});
