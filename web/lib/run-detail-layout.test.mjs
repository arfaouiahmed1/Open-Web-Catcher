import assert from "node:assert/strict";
import test from "node:test";

import { buildRunDetailTabState } from "./run-detail-layout.js";

test("uses Traces tab and keeps screenshots under Summary", () => {
  const tabs = buildRunDetailTabState({
    decisionCount: 3,
    outputCount: 2,
    toolCallCount: 4,
    eventCount: 9,
  }).primaryTabs;
  assert.ok(tabs.some((tab) => tab.value === "traces" && tab.label === "Traces"));
  assert.ok(!tabs.some((tab) => tab.value === "decisions"));
  assert.ok(!tabs.some((tab) => tab.value === "screenshots"));
});
