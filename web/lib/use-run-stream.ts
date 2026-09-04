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
const TERMINAL_DISPLAY_STATUSES: Record<string, true> = {
  success: true,
  failed: true,
  cancelled: true,
  timeout: true,
  site_dead: true,
  page_inaccessible: true,
  no_streams: true,
  no_hosting_pages: true,
  partial: true,
};

export function isRunStreamTerminal(state: RunStreamState | null | undefined): boolean {
  if (!state) return false;
  if (state.error === "run_not_found" || state.error === "stream_failed") return true;
  if (state.completed) return true;
  const display = String(state.displayStatus ?? "").toLowerCase();
  if (TERMINAL_DISPLAY_STATUSES[display] === true) return true;
  const job = String(state.jobStatus ?? "").toLowerCase();
  if (TERMINAL_DISPLAY_STATUSES[job] === true) return true;
  return false;
}

const TERMINAL_JOB_STATUSES: Record<string, true> = {
  completed: true,
  failed: true,
  cancelled: true,
  done: true,
  error: true,
  succeeded: true,
  success: true,
  timeout: true,
  site_dead: true,
  page_inaccessible: true,
  no_streams: true,
  no_hosting_pages: true,
  dead_letter: true,
};

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

  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // ignore
        }
        abortRef.current = null;
      }
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, []);

  const isTerminal = isRunStreamTerminal(state);
  const lowerJob = String(state.jobStatus ?? "").toLowerCase();
  const terminalJobStatus = TERMINAL_JOB_STATUSES[lowerJob] === true;
  const shouldStream = enabled && !isTerminal && !terminalJobStatus && Boolean(runId);

  useEffect(() => {
    if (shouldStream) {
      abortRef.current = typeof AbortController !== "undefined" ? new AbortController() : null;
    } else {
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // ignore
        }
        abortRef.current = null;
      }
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }
    return () => {
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // ignore
        }
        abortRef.current = null;
      }
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    };
  }, [shouldStream]);

  const handleMessage = useCallback((data: string) => {
    let payload: unknown;
    try {
      payload = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    onPayloadRef.current?.(payload as Record<string, unknown>);
    setState((prev) => {
      const next = applyRunStreamPayload(prev, payload as RunStreamPayload);
      const nextIsTerminal = isRunStreamTerminal(next);
      const nextLowerJob = String(next.jobStatus ?? "").toLowerCase();
      const nextJobTerminal = TERMINAL_JOB_STATUSES[nextLowerJob] === true;
      if (nextIsTerminal || nextJobTerminal) {
        if (abortRef.current) {
          try {
            abortRef.current.abort();
          } catch {
            // ignore
          }
          abortRef.current = null;
        }
        if (timeoutRef.current !== null) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (isTerminal || terminalJobStatus) {
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // ignore
        }
        abortRef.current = null;
      }
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }
  }, [isTerminal, terminalJobStatus]);

  const { status, connected, reconnects } = useEventStream(
    runId ? `/ui/runs/${runId}/stream` : null,
    { enabled: shouldStream, onMessage: handleMessage },
  );

  const merged = useMemo(() => ({ ...state, status, connected, reconnects }), [
    state,
    status,
    connected,
    reconnects,
  ]);

  return {
    ...merged,
    reset,
    isTerminal,
    terminalJobStatus,
  };
}
