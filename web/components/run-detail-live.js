"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Loader2,
  PauseCircle,
  PlayCircle,
  Square,
  TimerReset,
} from "lucide-react";

import { apiUrl } from "@/lib/api";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { extractToolCalls } from "@/lib/run-trace";
import { BrowserLiveView } from "@/components/browser-live-view";
import { OrchestratorGraph } from "@/components/orchestrator-graph";
import { RuntimeEventsPanel } from "@/components/runtime-events-panel";
import { TimelinePanel } from "@/components/timeline-panel";
import { ToolCallFeed } from "@/components/tool-call-feed";

function _eventKey(e) {
  // Stable dedup key: seq is canonical, fallback to composite
  const seq = e?.seq;
  if (seq != null) return String(seq);
  return `${e?.timestamp ?? ""}-${e?.actor ?? ""}-${e?.kind ?? ""}-${e?.status ?? ""}`;
}

function _seedMap(events) {
  const map = new Map();
  for (const e of events) map.set(_eventKey(e), e);
  return map;
}

function Metric({ label, value, accent, detail }) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className="font-mono text-[16px] font-semibold"
        style={{ color: accent }}
      >
        {value}
      </span>
      <span
        className="text-[10px] uppercase tracking-[0.12em]"
        style={{ color: "var(--mute-2)" }}
      >
        {label}
      </span>
      {detail ? (
        <span
          className="font-mono text-[10px]"
          style={{ color: "var(--mute-3)" }}
        >
          {detail}
        </span>
      ) : null}
    </div>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border px-3 py-1 text-[11px] font-medium transition-colors"
      style={{
        borderColor: active
          ? "color-mix(in oklch, var(--signal) 36%, transparent)"
          : "var(--line)",
        background: active
          ? "color-mix(in oklch, var(--signal) 14%, transparent)"
          : "transparent",
        color: active ? "var(--signal)" : "var(--mute-2)",
      }}
    >
      {children}
    </button>
  );
}

export function RunDetailLive({
  runId,
  activeTrace = null,
  persistedEvents = [],
  metrics = null,
  onMetricsChange = null,
}) {
  // Map-based event store: O(1) dedup, no full-array copy on every SSE frame.
  const eventMapRef = useRef(null);
  const [eventVersion, setEventVersion] = useState(0);
  const [traceMetrics, setTraceMetrics] = useState(
    activeTrace?.metrics || metrics || null,
  );
  const [liveStream, setLiveStream] = useState(Boolean(activeTrace));
  const [replayMs, setReplayMs] = useState(80);
  const [isReplaying, setIsReplaying] = useState(false);
  const [tab, setTab] = useState("graph");
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState("");

  // Seed the map from initial props
  if (eventMapRef.current === null) {
    eventMapRef.current = _seedMap(
      activeTrace?.events || persistedEvents || [],
    );
  }

  // Re-seed when trace/persisted events change (e.g. navigation)
  useEffect(() => {
    const source = activeTrace?.events || persistedEvents || [];
    const newMap = _seedMap(source);
    eventMapRef.current = newMap;
    setEventVersion((v) => v + 1);
  }, [activeTrace, persistedEvents]);

  useEffect(() => {
    setTraceMetrics(activeTrace?.metrics || metrics || null);
  }, [activeTrace, metrics]);

  useEffect(() => {
    if (!liveStream || !runId) return undefined;

    const source = new EventSource(apiUrl(`/ui/runs/${runId}/stream`));
    source.onmessage = (payload) => {
      try {
        const parsed = JSON.parse(payload.data || "{}");
        const incoming = Array.isArray(parsed?.events) ? parsed.events : [];
        if (incoming.length) {
          let changed = false;
          const map = eventMapRef.current;
          for (const e of incoming) {
            const key = _eventKey(e);
            if (!map.has(key)) {
              map.set(key, e);
              changed = true;
            }
          }
          if (changed) setEventVersion((v) => v + 1);
        }
        if (parsed?.metrics && typeof parsed.metrics === "object") {
          setTraceMetrics(parsed.metrics);
          if (onMetricsChange) onMetricsChange(parsed.metrics);
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => source.close();
  }, [liveStream, runId]);

  async function replay() {
    if (!persistedEvents.length) return;
    setIsReplaying(true);
    eventMapRef.current = new Map();
    setEventVersion((v) => v + 1);
    for (const event of persistedEvents) {
      const key = _eventKey(event);
      eventMapRef.current.set(key, event);
      setEventVersion((v) => v + 1);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(20, replayMs)),
      );
    }
    setIsReplaying(false);
  }

  async function cancelRun() {
    if (!runId || isCancelling) return;
    setIsCancelling(true);
    setCancelError("");
    try {
      const response = await fetch(apiUrl(`/ui/runs/${runId}/cancel`), {
        method: "POST",
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Cancel failed (${response.status})`);
      }
    } catch (error) {
      setCancelError(
        error instanceof Error
          ? error.message
          : String(error || "Cancel failed"),
      );
    } finally {
      setIsCancelling(false);
    }
  }

  // Sorted array derived only when eventVersion bumps — no O(n) clone on every SSE frame
  const events = useMemo(
    () =>
      [...(eventMapRef.current?.values() ?? [])].sort(
        (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventVersion],
  );

  const effectiveMetrics = traceMetrics || null;
  const totalTokens =
    Number(effectiveMetrics?.total_tokens_in || 0) +
    Number(effectiveMetrics?.total_tokens_out || 0);
  const cachedInputTokens = Number(
    effectiveMetrics?.total_cached_input_tokens || 0,
  );
  const totalInputTokens = Number(effectiveMetrics?.total_tokens_in || 0);
  const toolCallRows = useMemo(() => extractToolCalls(events), [events]);
  const toolCalls = Math.max(
    toolCallRows.length,
    Number(effectiveMetrics?.total_tool_calls || 0),
  );
  const llmCalls = Number(effectiveMetrics?.total_llm_calls || 0);
  const rootActor =
    activeTrace?.root_actor ||
    events.find((event) => event?.actor)?.actor ||
    "orchestrator";
  const isLive = liveStream && !isReplaying;

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap items-center gap-2 rounded-[12px] border px-3 py-2.5"
        style={{
          borderColor: "var(--line)",
          background: "var(--card)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        <button
          type="button"
          onClick={() => setLiveStream((value) => !value)}
          className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium"
          style={{
            borderColor: liveStream
              ? "color-mix(in oklch, var(--rose) 35%, transparent)"
              : "var(--line)",
            background: liveStream
              ? "color-mix(in oklch, var(--rose) 12%, transparent)"
              : "transparent",
            color: liveStream ? "var(--rose)" : "var(--mute-2)",
          }}
        >
          {liveStream ? (
            <PauseCircle className="h-4 w-4" />
          ) : (
            <PlayCircle className="h-4 w-4" />
          )}
          {liveStream ? "Streaming" : "Paused"}
        </button>

        <button
          type="button"
          onClick={replay}
          disabled={isReplaying || !persistedEvents.length}
          className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium disabled:opacity-45"
          style={{ borderColor: "var(--line)", color: "var(--mute-2)" }}
        >
          {isReplaying ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <TimerReset className="h-4 w-4" />
          )}
          {isReplaying ? "Replaying" : "Replay"}
        </button>

        <div className="flex items-center gap-1.5">
          <span className="text-[10px]" style={{ color: "var(--mute-3)" }}>
            Speed
          </span>
          <input
            type="number"
            min="20"
            step="10"
            value={replayMs}
            onChange={(event) => setReplayMs(Number(event.target.value || 80))}
            className="w-16 rounded-lg border px-2 py-1 text-[11px] text-right"
            style={{
              borderColor: "var(--line)",
              background: "var(--card)",
              color: "var(--ink-dim)",
            }}
          />
          <span
            className="font-mono text-[10px]"
            style={{ color: "var(--mute-3)" }}
          >
            ms
          </span>
        </div>

        {runId ? (
          <button
            type="button"
            onClick={cancelRun}
            disabled={isCancelling}
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] font-medium disabled:opacity-45"
            style={{
              borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
              background: "color-mix(in oklch, var(--rose) 8%, transparent)",
              color: "var(--rose)",
            }}
          >
            {isCancelling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            Stop run
          </button>
        ) : null}

        <span
          className="ml-auto font-mono text-[10px]"
          style={{ color: "var(--mute-3)" }}
        >
          {formatNumber(toolCalls)} tool calls
        </span>

        <div className="flex items-center gap-2">
          <TabButton active={tab === "graph"} onClick={() => setTab("graph")}>
            Graph
          </TabButton>
          <TabButton active={tab === "tools"} onClick={() => setTab("tools")}>
            Tool calls
            {toolCallRows.length > 0 && (
              <span
                className="ml-1 rounded-full px-1.5 py-0.5 font-mono text-[9px]"
                style={{
                  background:
                    "color-mix(in oklch, var(--sky) 15%, transparent)",
                  color: "var(--sky)",
                }}
              >
                {toolCallRows.length}
              </span>
            )}
          </TabButton>
          <TabButton active={tab === "events"} onClick={() => setTab("events")}>
            Events
            {events.length > 0 && (
              <span
                className="ml-1 rounded-full px-1.5 py-0.5 font-mono text-[9px]"
                style={{
                  background:
                    "color-mix(in oklch, var(--violet) 15%, transparent)",
                  color: "var(--violet)",
                }}
              >
                {events.length}
              </span>
            )}
          </TabButton>
        </div>
      </div>

      {cancelError ? (
        <div
          className="rounded-[12px] border px-3 py-2 text-[12px]"
          style={{
            borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
            background: "color-mix(in oklch, var(--rose) 8%, transparent)",
            color: "var(--rose)",
          }}
        >
          {cancelError}
        </div>
      ) : null}

      {effectiveMetrics ? (
        <div
          className="rounded-[12px] border px-4 py-3"
          style={{
            borderColor: "var(--line)",
            background: "var(--card)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Metric
              label="Tools"
              value={formatNumber(toolCalls)}
              accent="var(--sky)"
            />
            <Metric
              label="LLM"
              value={formatNumber(llmCalls)}
              accent="var(--violet)"
            />
            <Metric
              label="Tokens"
              value={formatNumber(totalTokens)}
              accent="var(--signal)"
              detail={formatNumber(totalInputTokens)}
            />
            <Metric
              label="Cached / input"
              value={formatNumber(cachedInputTokens)}
              accent="var(--violet)"
              detail={`${formatNumber(totalInputTokens || 0)} in`}
            />
            <Metric
              label="Cost"
              value={formatCurrency(
                effectiveMetrics.total_cost_usd ??
                  effectiveMetrics.estimated_total_cost_usd ??
                  0,
              )}
              accent="var(--mint)"
            />
          </div>
        </div>
      ) : null}

      {runId ? (
        <BrowserLiveView runId={runId} events={events} autoRefresh={isLive} />
      ) : null}

      {tab === "events" ? (
        <RuntimeEventsPanel events={events} title="Event Stream" />
      ) : tab === "tools" ? (
        <ToolCallFeed toolCalls={toolCallRows} title="Tool Calls" />
      ) : (
        <div className="space-y-4">
          {events.length > 2 && <TimelinePanel events={events} />}
          <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
            <OrchestratorGraph events={events} rootActor={rootActor} />
            <ToolCallFeed
              toolCalls={toolCallRows}
              title="Tool Calls"
              maxHeight={480}
            />
          </div>
        </div>
      )}
    </div>
  );
}
