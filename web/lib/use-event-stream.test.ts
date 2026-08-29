import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  computeBackoffMs,
  createEventStreamClient,
} from "./use-event-stream.js";

/** Minimal EventSource stand-in for the node environment. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  emit(data: string): void {
    this.onmessage?.({ data });
  }

  fail(): void {
    this.onerror?.();
  }
}

describe("computeBackoffMs", () => {
  it("doubles exponentially and caps at 30s", () => {
    expect(computeBackoffMs(0, { jitterRatio: 0 })).toBe(BACKOFF_BASE_MS);
    expect(computeBackoffMs(1, { jitterRatio: 0 })).toBe(BACKOFF_BASE_MS * 2);
    expect(computeBackoffMs(3, { jitterRatio: 0 })).toBe(BACKOFF_BASE_MS * 8);
    expect(computeBackoffMs(20, { jitterRatio: 0 })).toBe(BACKOFF_CAP_MS);
    expect(computeBackoffMs(50, { jitterRatio: 0 })).toBe(BACKOFF_CAP_MS);
  });

  it("applies bounded jitter when enabled", () => {
    const value = computeBackoffMs(2);
    expect(value).toBeGreaterThanOrEqual(BACKOFF_BASE_MS * 4 * 0.9 - 1);
    expect(value).toBeLessThanOrEqual(BACKOFF_BASE_MS * 4 * 1.1 + 1);
  });
});

describe("createEventStreamClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function lastSource(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }

  it("opens one connection and delivers messages", () => {
    const messages: string[] = [];
    const statuses: string[] = [];
    const client = createEventStreamClient({
      getUrl: () => "http://test/stream",
      onMessage: (data) => messages.push(data),
      onStatus: (status) => statuses.push(status),
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      backoffJitter: 0,
    });

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(statuses).toContain("connecting");
    lastSource().open();
    lastSource().emit('{"hello":1}');
    lastSource().emit('{"hello":2}');
    expect(messages).toEqual(['{"hello":1}', '{"hello":2}']);
    client.close();
    expect(lastSource().closed).toBe(true);
    expect(statuses[statuses.length - 1]).toBe("closed");
  });

  it("reconnects with exponential backoff after an error", () => {
    const client = createEventStreamClient({
      getUrl: () => "http://test/stream",
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      backoffJitter: 0,
    });

    // First failure → retry after base delay.
    lastSource().fail();
    vi.advanceTimersByTime(BACKOFF_BASE_MS - 1);
    expect(FakeEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(2);

    // Second failure → doubled delay.
    lastSource().fail();
    vi.advanceTimersByTime(BACKOFF_BASE_MS * 2 - 1);
    expect(FakeEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.instances).toHaveLength(3);

    client.close();
  });

  it("stops reconnecting once closed", () => {
    const client = createEventStreamClient({
      getUrl: () => "http://test/stream",
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      backoffJitter: 0,
    });
    lastSource().fail();
    client.close();
    vi.advanceTimersByTime(BACKOFF_CAP_MS * 10);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("resets the backoff attempt counter after a successful open", () => {
    const client = createEventStreamClient({
      getUrl: () => "http://test/stream",
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      backoffJitter: 0,
    });
    lastSource().fail();
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    lastSource().open(); // success resets attempt to 0
    lastSource().fail();
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    expect(FakeEventSource.instances).toHaveLength(3); // retried at base delay again
    client.close();
  });

  it("ignores delayed errors from a stale source after reconnecting", () => {
    const client = createEventStreamClient({
      getUrl: () => "http://test/stream",
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      backoffJitter: 0,
    });
    const first = lastSource();
    first.fail();
    vi.advanceTimersByTime(BACKOFF_BASE_MS);
    const current = lastSource();
    expect(current).not.toBe(first);

    // Browsers can dispatch a queued error after close(). That old event must
    // not tear down `current` or schedule a second reconnect.
    first.fail();
    vi.advanceTimersByTime(BACKOFF_CAP_MS * 2);
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(current.closed).toBe(false);
    client.close();
  });

  it("survives handler exceptions without killing the stream", () => {
    const client = createEventStreamClient({
      getUrl: () => "http://test/stream",
      onMessage: () => {
        throw new Error("boom");
      },
      EventSourceImpl: FakeEventSource as unknown as typeof EventSource,
      backoffJitter: 0,
    });
    expect(() => lastSource().emit("x")).not.toThrow();
    client.close();
  });
});
