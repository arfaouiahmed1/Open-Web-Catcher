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

/** Pure backoff computation: exponential with cap, plus jitter so many
 * clients don't reconnect in lockstep. Exported for tests. */
export function computeBackoffMs(attempt, { baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS, jitterRatio = 0.2 } = {}) {
  const safeAttempt = Math.max(0, Number(attempt) || 0);
  const raw = Math.min(capMs, baseMs * 2 ** safeAttempt);
  const boundedBase = Math.min(raw, capMs);
  if (!(jitterRatio > 0)) return Math.round(boundedBase);
  const spread = boundedBase * jitterRatio;
  return Math.round(boundedBase - spread / 2 + Math.random() * spread);
}

/**
 * React-free SSE lifecycle controller. Owns one EventSource at a time and
 * reconnects with exponential backoff until {@link close} is called.
 *
 * @param {object} options
 * @param {() => string} options.getUrl Builds the (already token-annotated)
 *   SSE URL fresh on every (re)connect attempt.
 * @param {(data: string, rawEvent: unknown) => void} [options.onMessage]
 *   Called for every `message` event with its parsed-ready data string.
 * @param {(status: "connecting"|"open"|"reconnecting"|"closed", info: object) => void} [options.onStatus]
 * @param {number} [options.backoffBaseMs] Reconnect backoff base (default 500).
 * @param {number} [options.backoffCapMs] Reconnect backoff cap (default 30_000).
 * @param {number} [options.backoffJitter] Jitter ratio (default 0.2; 0 disables).
 * @param {class} [options.EventSourceImpl] Injectable EventSource for tests.
 * @returns {{ close: () => void, getAttempt: () => number }}
 */
export function createEventStreamClient({
  getUrl,
  onMessage,
  onStatus,
  backoffBaseMs,
  backoffCapMs,
  backoffJitter,
  EventSourceImpl,
} = {}) {
  if (typeof getUrl !== "function") {
    throw new Error("createEventStreamClient requires a getUrl() factory");
  }
  // Node/test environments may not define EventSource globally; resolve lazily.
  const ES = EventSourceImpl || globalThis.EventSource;

  let source = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;

  function emitStatus(status, info = {}) {
    if (typeof onStatus === "function") onStatus(status, { attempt, ...info });
  }

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function connect() {
    if (closed) return;
    clearReconnectTimer();
    emitStatus(attempt === 0 ? "connecting" : "reconnecting");
    let nextSource;
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
    nextSource.onmessage = (event) => {
      if (closed || source !== nextSource) return;
      if (typeof onMessage === "function") {
        try {
          onMessage(event?.data ?? "", event);
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

  function teardownSource(target = source) {
    if (!target) return;
    try {
      target.close();
    } catch {}
    if (source === target) source = null;
  }

  function scheduleReconnect(cause) {
    if (closed || reconnectTimer !== null) return;
    const delay = computeBackoffMs(attempt, {
      ...(backoffBaseMs != null ? { baseMs: backoffBaseMs } : {}),
      ...(backoffCapMs != null ? { capMs: backoffCapMs } : {}),
      ...(backoffJitter != null ? { jitterRatio: backoffJitter } : {}),
    });
    attempt += 1;
    emitStatus("reconnecting", { delayMs: delay, cause: String(cause || "") });
    reconnectTimer = setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      closed = true;
      clearReconnectTimer();
      teardownSource();
      emitStatus("closed");
    },
    getAttempt() {
      return attempt;
    },
  };
}

function useStableRef(value) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Subscribe to an SSE endpoint for the lifetime of the component (or while
 * `path` is non-null and `enabled`). Handlers are kept in refs so passing
 * inline closures never tears down the connection.
 *
 * @param {string|null} path API path such as "/ui/events/stream"; null disables.
 * @param {object} options { onMessage, onStatus, enabled }
 * @returns {{ status: string, connected: boolean, reconnects: number }}
 */
export function useEventStream(path, { onMessage, onStatus, enabled = true } = {}) {
  const [status, setStatus] = useState("idle");
  const [reconnects, setReconnects] = useState(0);
  const handlersRef = useStableRef({ onMessage, onStatus });
  const shouldRun = Boolean(path) && enabled !== false;

  useEffect(() => {
    if (!shouldRun) return undefined;
    const client = createEventStreamClient({
      getUrl: () => eventSourceUrl(path),
      onMessage: (data, rawEvent) => handlersRef.current.onMessage?.(data, rawEvent),
      onStatus: (next, info) => {
        setStatus(next);
        if (next === "reconnecting" && info?.delayMs != null) {
          setReconnects((count) => count + 1);
        }
        handlersRef.current.onStatus?.(next, info);
      },
    });
    return () => client.close();
  }, [path, shouldRun]); // eslint-disable-line react-hooks/exhaustive-deps

  return { status, connected: status === "open", reconnects };
}
