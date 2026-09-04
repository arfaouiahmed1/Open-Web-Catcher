"use client";

/**
 * Generic SSE subscriber (plan tasks 40 + 42, Wave 5 live-view/de-polling lane).
 *
 * Replaces every `setInterval` poller in the operator console with a single
 * EventSource connection per view. The transport lives in
 * {@link createEventStreamClient} — a React-free controller that is fully
 * unit-testable with a fake EventSource — while {@link useEventStream} is the
 * thin React wrapper components consume.
 *
 * Reconnect policy: exponential backoff starting at 500 ms, doubling per
 * consecutive failure, capped at 30 s. Cleanup on unmount closes the source
 * and clears any scheduled reconnect.
 */

import { useEffect, useRef, useState } from "react";

import { eventSourceUrl } from "@/lib/api";

export const BACKOFF_BASE_MS = 500;
export const BACKOFF_CAP_MS = 30_000;

export interface ComputeBackoffOptions {
  baseMs?: number;
  capMs?: number;
  jitterRatio?: number;
}

/** Pure backoff computation: exponential with cap, plus jitter so many
 * clients don't reconnect in lockstep. Exported for tests. */
export function computeBackoffMs(
  attempt: number,
  { baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS, jitterRatio = 0.2 }: ComputeBackoffOptions = {},
): number {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  const raw = Math.min(capMs, baseMs * 2 ** safeAttempt);
  const boundedBase = Math.min(raw, capMs);
  if (!(jitterRatio > 0)) return Math.round(boundedBase);
  const spread = boundedBase * jitterRatio;
  return Math.round(boundedBase - spread / 2 + Math.random() * spread);
}

export type EventStreamStatus = "connecting" | "open" | "reconnecting" | "closed" | "idle";

export interface CreateEventStreamClientOptions {
  getUrl: () => string;
  onMessage?: (data: string, rawEvent: MessageEvent) => void;
  onStatus?: (status: EventStreamStatus, info: Record<string, unknown>) => void;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  backoffJitter?: number;
  EventSourceImpl?: typeof EventSource;
}

export interface EventStreamClient {
  close: () => void;
  getAttempt: () => number;
}

/**
 * React-free SSE lifecycle controller. Owns one EventSource at a time and
 * reconnects with exponential backoff until {@link close} is called.
 */
export function createEventStreamClient({
  getUrl,
  onMessage,
  onStatus,
  backoffBaseMs,
  backoffCapMs,
  backoffJitter,
  EventSourceImpl,
}: CreateEventStreamClientOptions = {} as CreateEventStreamClientOptions): EventStreamClient {
  if (typeof getUrl !== "function") {
    throw new Error("createEventStreamClient requires a getUrl() factory");
  }
  // Node/test environments may not define EventSource globally; resolve lazily.
  const ES: typeof EventSource =
    (EventSourceImpl as unknown as typeof EventSource) ??
    (globalThis as unknown as { EventSource?: typeof EventSource }).EventSource!;

  let source: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let abortController: AbortController | null =
    typeof AbortController !== "undefined" ? new AbortController() : null;

  function emitStatus(status: EventStreamStatus, info: Record<string, unknown> = {}): void {
    if (typeof onStatus === "function") onStatus(status, { attempt, ...info });
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function connect(): void {
    if (closed || abortController?.signal.aborted) return;
    clearReconnectTimer();
    emitStatus(attempt === 0 ? "connecting" : "reconnecting");
    let nextSource: EventSource;
    try {
      nextSource = new ES(getUrl());
    } catch (error) {
      scheduleReconnect(error);
      return;
    }
    source = nextSource;
    nextSource.onopen = () => {
      if (closed || source !== nextSource) return;
      attempt = 0;
      emitStatus("open");
    };
    nextSource.onmessage = (event: MessageEvent) => {
      if (closed || source !== nextSource) return;
      if (typeof onMessage === "function") {
        try {
          onMessage((event?.data as string) ?? "", event);
        } catch {
          // A bad handler must never kill the stream loop.
        }
      }
    };
    nextSource.onerror = () => {
      // An old EventSource can deliver a delayed error after a reconnect. It
      // must never close or schedule a retry for the current connection.
      if (closed || source !== nextSource) return;
      teardownSource(nextSource);
      scheduleReconnect();
    };
  }

  function teardownSource(target: EventSource | null = source): void {
    if (!target) return;
    try {
      target.close();
    } catch {
      // ignore
    }
    if (source === target) source = null;
  }

  function scheduleReconnect(cause?: unknown): void {
    if (closed || abortController?.signal.aborted || reconnectTimer !== null) return;
    const delay = computeBackoffMs(attempt, {
      ...(backoffBaseMs != null ? { baseMs: backoffBaseMs } : {}),
      ...(backoffCapMs != null ? { capMs: backoffCapMs } : {}),
      ...(backoffJitter != null ? { jitterRatio: backoffJitter } : {}),
    });
    attempt += 1;
    emitStatus("reconnecting", { delayMs: delay, cause: String(cause ?? "") });
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      if (closed) {
        clearReconnectTimer();
        try {
          abortController?.abort();
        } catch {
          // ignore
        }
        teardownSource();
        return;
      }
      closed = true;
      clearReconnectTimer();
      teardownSource();
      try {
        abortController?.abort();
      } catch {
        // ignore
      }
      abortController = null;
      emitStatus("closed");
    },
    getAttempt() {
      return attempt;
    },
  };
}

function useStableRef<T>(value: T): React.MutableRefObject<T> {
  const ref = useRef<T>(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

export interface UseEventStreamOptions {
  onMessage?: (data: string, rawEvent: MessageEvent) => void;
  onStatus?: (status: EventStreamStatus, info: Record<string, unknown>) => void;
  enabled?: boolean;
}

/**
 * Subscribe to an SSE endpoint for the lifetime of the component (or while
 * `path` is non-null and `enabled`). Handlers are kept in refs so passing
 * inline closures never tears down the connection.
 */
export function useEventStream(
  path: string | null,
  { onMessage, onStatus, enabled = true }: UseEventStreamOptions = {},
): { status: EventStreamStatus; connected: boolean; reconnects: number } {
  const [status, setStatus] = useState<EventStreamStatus>("idle");
  const [reconnects, setReconnects] = useState<number>(0);
  const handlersRef = useStableRef({ onMessage, onStatus });
  const shouldRun = Boolean(path) && enabled !== false;
  const clientRef = useRef<EventStreamClient | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!shouldRun) {
      if (clientRef.current) {
        clientRef.current.close();
        clientRef.current = null;
      }
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // ignore
        }
        abortRef.current = null;
      }
      setStatus((prev) => (prev === "idle" ? prev : "idle"));
      return undefined;
    }
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    abortRef.current = controller;
    const client = createEventStreamClient({
      getUrl: () => eventSourceUrl(path as string),
      onMessage: (data, rawEvent) => handlersRef.current.onMessage?.(data, rawEvent),
      onStatus: (next, info) => {
        setStatus(next);
        if (next === "reconnecting" && (info as Record<string, unknown>)?.delayMs != null) {
          setReconnects((count) => count + 1);
        }
        handlersRef.current.onStatus?.(next, info as Record<string, unknown>);
      },
    });
    clientRef.current = client;
    return () => {
      if (abortRef.current) {
        try {
          abortRef.current.abort();
        } catch {
          // ignore
        }
        abortRef.current = null;
      }
      client.close();
      if (clientRef.current === client) clientRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, shouldRun]);

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
      if (clientRef.current) {
        clientRef.current.close();
        clientRef.current = null;
      }
    };
  }, []);

  return { status, connected: status === "open", reconnects };
}
