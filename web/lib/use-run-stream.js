"use client";

/**
 * useRunStream — SSE-first subscription to `/ui/runs/{id}/stream`
 * (plan task 40, Wave 5 live-view lane).
 *
 * Consumes the backend's existing event vocabulary (see
 * `src/models/common.py::EventKind`), including the streaming-pool kinds
 * `queue_enqueued`, `hosting_item_started`, `hosting_item_finished`,
 * `pool_drained`, and the plan carrier events `run_plan_created` /
 * `plan_step_update` delivered since plan T27.
 *
 * The server replays from seq 0 after every (re)connect, so the hook tracks
 * the highest seq it has emitted and de-duplicates replayed events via
 * {@link applyRunStreamPayload} (pure, unit-tested).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useEventStream } from "@/lib/use-event-stream";

/** @typedef {{ seq: number, kind: string, [key: string]: unknown }} RunStreamEvent */
/** @typedef {Record<string, unknown>} RunStreamMetrics */
/** @typedef {{ steps?: Array<Record<string, unknown>>, [key: string]: unknown }} RunStreamPlan */
/**
 * @typedef {object} RunStreamState
 * @property {RunStreamEvent[]} events
 * @property {RunStreamMetrics|null} metrics
 * @property {RunStreamPlan|null} plan
 * @property {boolean} completed
 * @property {boolean} cancelRequested
 * @property {string} cancelReason
 * @property {string} jobStatus
 * @property {string} displayStatus
 * @property {string} error
 * @property {number} lastSeq
 */
/**
 * @typedef {object} RunStreamPayload
 * @property {RunStreamEvent[]} [events]
 * @property {RunStreamMetrics|null} [metrics]
 * @property {RunStreamPlan|null} [plan]
 * @property {boolean} [completed]
 * @property {boolean} [cancel_requested]
 * @property {string} [cancel_reason]
 * @property {string} [job_status]
 * @property {{ status?: string }|null} [job]
 * @property {string} [display_status]
 * @property {string} [error]
 */

/** @type {RunStreamState} */
export const EMPTY_RUN_STREAM_STATE = Object.freeze({
  events: [],
  metrics: null,
  plan: null,
  completed: false,
  cancelRequested: false,
  cancelReason: "",
  jobStatus: "",
  displayStatus: "",
  error: "",
  lastSeq: 0,
});

/**
 * Fold one SSE payload into the accumulated stream state.
 * Pure; exported for tests and for consumers that need custom folds.
 *
 * @param {RunStreamState} state previous state
 * @param {RunStreamPayload|null|undefined} payload decoded `/ui/runs/{id}/stream` message
 * @returns {RunStreamState} next state
 */
export function applyRunStreamPayload(state, payload) {
  if (!payload || typeof payload !== "object") return state;

  const incoming = Array.isArray(payload.events) ? payload.events : [];
  // De-duplicate by seq: reconnects replay from 0, so keep only events with a
  // seq strictly greater than everything already folded in (events arrive in
  // ascending seq order per payload).
  let lastSeq = state.lastSeq;
  const fresh = incoming.filter((event) => {
    const seq = Number(event?.seq || 0);
    if (!seq || seq <= lastSeq) return false;
    lastSeq = seq;
    return true;
  });

  return {
    ...state,
    events: fresh.length ? [...state.events, ...fresh] : state.events,
    metrics:
      payload.metrics && typeof payload.metrics === "object"
        ? payload.metrics
        : state.metrics,
    plan: payload.plan && typeof payload.plan === "object" ? payload.plan : state.plan,
    completed: Boolean(payload.completed) || state.completed,
    cancelRequested: Boolean(payload.cancel_requested),
    cancelReason: String(payload.cancel_reason || ""),
    jobStatus: String(payload.job_status || payload.job?.status || state.jobStatus),
    displayStatus: String(payload.display_status || state.displayStatus),
    error: String(payload.error || ""),
    lastSeq,
  };
}

/** True when the folded stream state indicates the run reached a terminal
 * state and no further updates will arrive. Exported for tests. */
export function isRunStreamTerminal(state) {
  if (!state) return false;
  if (state.error === "run_not_found" || state.error === "stream_failed") return true;
  if (state.completed) return true;
  return ["success", "partial", "failed", "cancelled"].includes(
    String(state.displayStatus || "").toLowerCase(),
  );
}

const TERMINAL_JOB_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "done",
  "error",
]);

/**
 * Subscribe to `/ui/runs/{runId}/stream`.
 *
 * @param {string|undefined} runId run identifier; falsy disables subscription
 * @param {object} [options]
 * @param {boolean} [options.enabled=true] set false to pause the connection
 * @param {(payload: object) => void} [options.onPayload] raw-message observer
 *   (e.g. for toast feeds); kept in a ref so inline closures are safe.
 * @returns {{ events: object[], metrics: object|null, plan: object|null,
 *   completed: boolean, cancelRequested: boolean, jobStatus: string,
 *   displayStatus: string, connected: boolean, status: string,
 *   reconnects: number, lastSeq: number, reset: () => void }}
 */
export function useRunStream(runId, { enabled = true, onPayload } = {}) {
  const [state, setState] = useState(EMPTY_RUN_STREAM_STATE);
  const onPayloadRef = useRef(onPayload);
  useEffect(() => {
    onPayloadRef.current = onPayload;
  });

  const reset = useCallback(() => setState(EMPTY_RUN_STREAM_STATE), []);

  useEffect(() => {
    setState(EMPTY_RUN_STREAM_STATE);
  }, [runId]);

  const handleMessage = useCallback((data) => {
    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    onPayloadRef.current?.(payload);
    setState((prev) => applyRunStreamPayload(prev, payload));
  }, []);

  const { status, connected, reconnects } = useEventStream(
    runId ? `/ui/runs/${runId}/stream` : null,
    { enabled, onMessage: handleMessage },
  );

  const merged = useMemo(() => ({ ...state, status, connected, reconnects }), [
    state,
    status,
    connected,
    reconnects,
  ]);

  // Context-style memo value for consumers that thread this through providers.
  const contextValue = merged;

  return { ...contextValue, reset, isTerminal: isRunStreamTerminal(state), terminalJobStatus: TERMINAL_JOB_STATUSES.has(String(state.jobStatus).toLowerCase()) };
}
