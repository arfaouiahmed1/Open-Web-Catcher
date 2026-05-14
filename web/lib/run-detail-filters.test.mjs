import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRunDetailFilterOptions,
  filterDecisionItems,
  filterRuntimeEvents,
  filterToolCalls,
} from "./run-detail-filters.js";

const events = [
  {
    seq: 1,
    actor: "classification",
    kind: "agent_started",
    status: "info",
    message: "Classification started",
    details: {},
  },
  {
    seq: 2,
    actor: "landing",
    kind: "orchestrator_decision",
    status: "info",
    message: "Routing to landing",
    details: { reason: "stream page" },
  },
];

const toolCalls = [
  {
    key: "tool-1",
    toolName: "inspect_landing",
    target: "https://streamed.pk/",
    actor: "landing",
    stage: "landing",
    status: "success",
    args: { url: "https://streamed.pk/" },
    result: { ok: true },
  },
  {
    key: "tool-2",
    toolName: "inspect",
    target: "https://streamed.pk/",
    actor: "classification",
    stage: "classification",
    status: "running",
    args: { url: "https://streamed.pk/" },
    result: "",
  },
];

const decisions = [
  {
    id: 1,
    title: "Route to landing",
    summary: "User requested landing analysis",
    actor: "landing",
    category: "routing",
    status: "approved",
    details: { source: "agent_auto" },
  },
  {
    id: 2,
    title: "Manual review",
    summary: "Operator override",
    actor: "classification",
    category: "ops",
    status: "open",
    details: {},
  },
];

test("buildRunDetailFilterOptions returns actor and stage choices from run surfaces", () => {
  const options = buildRunDetailFilterOptions({ events, toolCalls, decisions });
  assert.deepEqual(options.actors, ["classification", "landing"]);
  assert.deepEqual(
    options.stages.map((entry) => entry.value),
    ["classification", "landing"],
  );
});

test("filterToolCalls keeps actor and stage filters sticky across tabs", () => {
  const filtered = filterToolCalls(toolCalls, { actor: "landing", stage: "landing" }, { search: "", status: "" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].toolName, "inspect_landing");
});

test("filterRuntimeEvents matches search against payload and message content", () => {
  const filtered = filterRuntimeEvents(events, { actor: "", stage: "" }, { search: "stream page", kind: "" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].actor, "landing");
});

test("filterDecisionItems separates auto and manual decision sources", () => {
  const manualOnly = filterDecisionItems(decisions, { actor: "", stage: "" }, { search: "", source: "manual", category: "", status: "" });
  const autoOnly = filterDecisionItems(decisions, { actor: "", stage: "" }, { search: "", source: "agent_auto", category: "", status: "" });
  assert.deepEqual(manualOnly.map((item) => item.id), [2]);
  assert.deepEqual(autoOnly.map((item) => item.id), [1]);
});
