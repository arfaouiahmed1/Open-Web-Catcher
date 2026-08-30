import { describe, expect, it } from "vitest";

import {
  applyRunStreamPayload,
  EMPTY_RUN_STREAM_STATE,
  isRunStreamTerminal,
} from "./use-run-stream.js";

const BASE = EMPTY_RUN_STREAM_STATE;

describe("applyRunStreamPayload", () => {
  it("accumulates events across payloads", () => {
    let state = applyRunStreamPayload(BASE, {
      events: [
        { seq: 1, kind: "pipeline_started" },
        { seq: 2, kind: "queue_enqueued" },
      ],
      metrics: { elapsed_seconds: 1 },
    });
    state = applyRunStreamPayload(state, {
      events: [
        { seq: 3, kind: "hosting_item_started" },
        { seq: 4, kind: "hosting_item_finished" },
        { seq: 5, kind: "plan_step_update" },
      ],
    });
    expect(state.events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(state.metrics).toEqual({ elapsed_seconds: 1 });
    expect(state.lastSeq).toBe(5);
  });

  it("de-duplicates replayed events after a reconnect (server replays from seq 0)", () => {
    let state = applyRunStreamPayload(BASE, {
      events: [
        { seq: 1, kind: "pipeline_started" },
        { seq: 2, kind: "agent_started" },
      ],
    });
    // Reconnect: server resends seq 1..2 plus a genuinely new 3.
    state = applyRunStreamPayload(state, {
      events: [
        { seq: 1, kind: "pipeline_started" },
        { seq: 2, kind: "agent_started" },
        { seq: 3, kind: "pool_drained" },
      ],
    });
    expect(state.events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(state.lastSeq).toBe(3);
  });

  it("ignores malformed and empty payloads", () => {
    expect(applyRunStreamPayload(BASE, null)).toBe(BASE);
    const next = applyRunStreamPayload(BASE, { events: [] });
    expect(next.events).toEqual([]);
    expect(next.lastSeq).toBe(0);
  });

  it("tracks lifecycle flags, job status, plan carrier and cancel reason", () => {
    const state = applyRunStreamPayload(BASE, {
      events: [],
      completed: true,
      cancel_requested: true,
      cancel_reason: "user asked",
      job_status: "completed",
      display_status: "success",
      plan: { steps: [{ name: "classification", status: "done" }] },
      metrics: null,
    });
    expect(state.completed).toBe(true);
    expect(state.cancelRequested).toBe(true);
    expect(state.cancelReason).toBe("user asked");
    expect(state.jobStatus).toBe("completed");
    expect(state.displayStatus).toBe("success");
    expect(state.plan?.steps).toHaveLength(1);
  });

  it("keeps prior metrics when a payload omits them", () => {
    const withMetrics = applyRunStreamPayload(BASE, {
      metrics: { total_cost_usd: 0.5 },
    });
    const without = applyRunStreamPayload(withMetrics, { events: [] });
    expect(without.metrics).toEqual({ total_cost_usd: 0.5 });
  });

  it("never mutates the previous state object", () => {
    const first = applyRunStreamPayload(BASE, { events: [{ seq: 1, kind: "run_started" }] });
    const second = applyRunStreamPayload(first, { events: [{ seq: 2, kind: "agent_started" }] });
    expect(first.events).toHaveLength(1);
    expect(second.events).not.toBe(first.events);
  });
});

describe("isRunStreamTerminal", () => {
  it("detects terminal states from completion, error and display status", () => {
    expect(isRunStreamTerminal({ ...BASE, completed: true })).toBe(true);
    expect(isRunStreamTerminal({ ...BASE, error: "run_not_found" })).toBe(true);
    expect(isRunStreamTerminal({ ...BASE, displayStatus: "failed" })).toBe(true);
    expect(isRunStreamTerminal({ ...BASE, displayStatus: "running" })).toBe(false);
    expect(isRunStreamTerminal(null)).toBe(false);
  });
});
