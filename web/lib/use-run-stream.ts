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

export interface RunStreamEvent {
  seq: number;
  kind: string;
  [key: string]: unknown;
}

export type RunStreamMetrics = Record<string, unknown> | null;
export interface RunStreamPlan {
  steps?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface RunStreamState {
  events: RunStreamEvent[];
  metrics: RunStreamMetrics;
  plan: RunStreamPlan | null;
  completed: boolean;
  cancelRequested: boolean;
  cancelReason: string;
  jobStatus: string;
  displayStatus: string;
  error: string;
  lastSeq: number;
}

export interface RunStreamPayload {
  events?: RunStreamEvent[];
  metrics?: RunStreamMetrics;
  plan?: RunStreamPlan | null;
  completed?: boolean;
  cancel_requested?: boolean;
  cancel_reason?: string;
  job_status?: string;
  job?: { status?: string } | null;
  display_status?: string;
  error?: string;
}

export const EMPTY_RUN_STREAM_STATE: Readonly<RunStreamState> = Object.freeze({
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
 */
export function applyRunStreamPayload(
  state: RunStreamState,
  payload: RunStreamPayload | null | undefined,
): RunStreamState {
  if (!payload || typeof payload !== "object") return state;

  const incoming = Array.isArray(payload.events) ? payload.events : [];
  // De-duplicate by seq: reconnects replay from 0, so keep only events with a
  // seq strictly greater than everything already folded in (events arrive in
  // ascending seq order per payload).
  let lastSeq = state.lastSeq;
  const fresh = incoming.filter((event) => {
    const seq = Number((event as RunStreamEvent)?.seq || 0);
    if (!seq || seq <= lastSeq) return false;
    lastSeq = seq;
    return true;
  });

  return {
    ...state,
    events: fresh.length ? [...state.events, ...fresh] : state.events,
    metrics:
      payload.metrics && typeof payload.metrics === "object"
        ? (payload.metrics as RunStreamMetrics)
        : state.metrics,
    plan: payload.plan && typeof payload.plan === "object" ? (payload.plan as RunStreamPlan) : state.plan,
    completed: Boolean(payload.completed) || state.completed,
    cancelRequested: Boolean(payload.cancel_requested),
    cancelReason: String(payload.cancel_reason ?? ""),
    jobStatus: String(payload.job_status ?? payload.job?.status ?? state.jobStatus),
    displayStatus: String(payload.display_status ?? state.displayStatus),
    error: String(payload.error ?? ""),
    lastSeq,
  };
}

/** True when the folded stream state indicates the run reached a terminal
 * state and no further updates will arrive. Exported for tests. */
export function isRunStreamTerminal(state: RunStreamState | null | undefined): boolean {
  if (!state) return false;
  if (state.error === "run_not_found" || state.error === "stream_failed") return true;
  if (state.completed) return true;
  return ["success", "partial", "failed", "cancelled"].includes(
    String(state.displayStatus ?? "").toLowerCase(),
  );
}

const TERMINAL_JOB_STATUSES = new Set<string>([
  "completed",
  "failed",
  "cancelled",
  "done",
  "error",
]);

export interface UseRunStreamOptions {
  enabled?: boolean;
  onPayload?: (payload: Record<string, unknown>) => void;
}

/**
 * Subscribe to `/ui/runs/{runId}/stream`.
 */
export function useRunStream(
  runId: string | undefined,
  { enabled = true, onPayload }: UseRunStreamOptions = {},
): RunStreamState & {
  status: string;
  connected: boolean;
  reconnects: number;
  reset: () => void;
  isTerminal: boolean;
  terminalJobStatus: boolean;
} {
  const [state, setState] = useState<RunStreamState>({ ...EMPTY_RUN_STREAM_STATE });
  const onPayloadRef = useRef<UseRunStreamOptions["onPayload"]>(onPayload);
  useEffect(() => {
    onPayloadRef.current = onPayload;
  });

  const reset = useCallback(() => setState({ ...EMPTY_RUN_STREAM_STATE }), []);

  useEffect(() => {
    setState({ ...EMPTY_RUN_STREAM_STATE });
  }, [runId]);

  const handleMessage = useCallback((data: string) => {
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    onPayloadRef.current?.(payload as Record<string, unknown>);
    setState((prev) => applyRunStreamPayload(prev, payload as RunStreamPayload));
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

  return {
    ...contextValue,
    reset,
    isTerminal: isRunStreamTerminal(state),
    terminalJobStatus: TERMINAL_JOB_STATUSES.has(String(state.jobStatus).toLowerCase()),
  };
}
