import test from "node:test";
import assert from "node:assert/strict";

import { buildStageView, getRunTerminalState, summarizeRunState } from "./run-trace.js";

const CANCELLED_EVENTS = [
  { seq: 40, actor: "landing", kind: "llm_turn_started", status: "info", details: {} },
  { seq: 41, actor: "landing", kind: "tool_call_started", status: "info", details: { tool_name: "inspect_landing" } },
  { seq: 42, actor: "control-room", kind: "cancel_requested", status: "warning", message: "Cancelled from console.", details: {} },
  { seq: 43, actor: "orchestrator", kind: "run_cancelled", status: "cancelled", message: "Run cancelled while active.", details: {} },
];

test("terminal state prefers cancellation terminals", () => {
  const terminal = getRunTerminalState(CANCELLED_EVENTS);
  assert.equal(terminal.isTerminal, true);
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.terminal?.kind, "run_cancelled");
});

test("summarizeRunState does not keep llm/tool loading after cancellation", () => {
  const state = summarizeRunState(CANCELLED_EVENTS);
  assert.equal(state.status, "cancelled");
  assert.equal(state.active?.type, "cancelled");
  assert.match(String(state.active?.message || ""), /cancel/i);
});

test("buildStageView marks previously running stage as cancelled after terminal cancellation", () => {
  const stageView = buildStageView(CANCELLED_EVENTS);
  const landing = stageView.stages.find((stage) => stage.stage === "landing");
  assert.equal(landing?.status, "cancelled");
  assert.equal(landing?.livePhase, "cancelled");
  assert.equal(landing?.liveLabel, "cancelled");
});
