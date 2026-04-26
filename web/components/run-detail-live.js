"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { TimelinePanel }     from "@/components/timeline-panel";
import { OrchestratorGraph } from "@/components/orchestrator-graph";
import { TraceExplorer }     from "@/components/trace-explorer";
import { BrowserLiveView }   from "@/components/browser-live-view";
import { RunViewSettingsButton, useRunViewSettings } from "@/components/run-view-settings";
import { apiUrl }            from "@/lib/api";

/* ── merge helper ── */
function mergeLiveEvents(currentEvents, incomingEvents) {
  if (!Array.isArray(incomingEvents) || incomingEvents.length === 0) return currentEvents;
  const merged = Array.isArray(currentEvents) ? [...currentEvents] : [];
  const seqToIndex = new Map();
  merged.forEach((e, i) => {
    const seq = Number(e?.seq);
    if (Number.isFinite(seq) && seq > 0) seqToIndex.set(seq, i);
  });
  for (const e of incomingEvents) {
    if (!e || typeof e !== "object") continue;
    const seq = Number(e.seq);
    if (Number.isFinite(seq) && seq > 0) {
      const idx = seqToIndex.get(seq);
      if (idx !== undefined) { merged[idx] = { ...merged[idx], ...e }; }
      else { seqToIndex.set(seq, merged.length); merged.push(e); }
      continue;
    }
    merged.push(e);
  }
  merged.sort((a, b) => {
    const aSeq = Number(a?.seq), bSeq = Number(b?.seq);
    const aOk = Number.isFinite(aSeq) && aSeq > 0;
    const bOk = Number.isFinite(bSeq) && bSeq > 0;
    if (aOk && bOk) return aSeq - bSeq;
    if (aOk) return -1; if (bOk) return 1;
    return String(a?.timestamp || "").localeCompare(String(b?.timestamp || ""));
  });
  return merged;
}

/* ── event kind metadata ── */
const KIND_META = {
  pipeline_started:   { icon: "▶▶", color: "var(--signal)",  label: "Pipeline started"  },
  pipeline_finished:  { icon: "✓✓", color: "var(--mint)",    label: "Pipeline finished" },
  pipeline_failed:    { icon: "✕✕", color: "var(--rose)",    label: "Pipeline failed"   },
  agent_started:      { icon: "▶",  color: "var(--signal)",  label: "Agent started"     },
  agent_finished:     { icon: "✓",  color: "var(--mint)",    label: "Agent finished"    },
  agent_failed:       { icon: "✕",  color: "var(--rose)",    label: "Agent failed"      },
  tool_call_started:  { icon: "🔧", color: "var(--sky)",     label: "Tool call"         },
  tool_call_finished: { icon: "·",  color: "var(--mute)",    label: "Tool result"       },
  llm_response:       { icon: "◈",  color: "var(--violet)",  label: "LLM response"      },
  memory_loaded:      { icon: "○",  color: "var(--mute-2)",  label: "Memory loaded"     },
  memory_hint_used:   { icon: "○",  color: "var(--mute-2)",  label: "Memory hint"       },
  prompt_compiled:    { icon: "≡",  color: "var(--mute-2)",  label: "Prompt compiled"   },
  agent_loop_started: { icon: "↺",  color: "var(--mute)",    label: "Loop started"      },
};

function getKindMeta(kind) {
  return KIND_META[kind] || { icon: "·", color: "var(--mute-3)", label: kind };
}

function fmt(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d)) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ── single event entry ── */
function EventEntry({ event, idx }) {
  const meta    = getKindMeta(event.kind);
  const isTool  = event.kind === "tool_call_started";
  const isLlm   = event.kind === "llm_response";
  const details = event.details || {};

  return (
    <div
      className="event-entry group flex gap-2.5 rounded-[8px] px-2.5 py-2 transition-colors hover:bg-white/[0.04]"
      style={{ animationDelay: `${Math.min(idx * 12, 120)}ms` }}
    >
      {/* icon col */}
      <div
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-[10px]"
        style={{
          background: `color-mix(in oklch, ${meta.color} 12%, transparent)`,
          color: meta.color,
          border: `1px solid color-mix(in oklch, ${meta.color} 22%, transparent)`,
        }}
      >
        {meta.icon}
      </div>

      {/* content col */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-2">
          {event.actor && (
            <span className="font-mono text-[9.5px] font-medium" style={{ color: "var(--mute-2)" }}>
              {event.actor}
            </span>
          )}
          <span className="text-[11px] font-medium" style={{ color: meta.color }}>
            {meta.label}
          </span>
          {isTool && details.tool_name && (
            <span className="tool-chip">{details.tool_name}</span>
          )}
          {isLlm && details.model_name && (
            <span className="model-badge">{details.model_name.replace(/^models\//, "")}</span>
          )}
          {isLlm && (details.input_tokens || details.output_tokens) && (
            <span className="font-mono text-[9.5px]" style={{ color: "var(--mute-2)" }}>
              {details.input_tokens ?? 0}→{details.output_tokens ?? 0} tok
            </span>
          )}
          {isLlm && details.estimated_total_cost_usd && (
            <span className="font-mono text-[9.5px]" style={{ color: "var(--mute-3)" }}>
              ${Number(details.estimated_total_cost_usd).toFixed(5)}
            </span>
          )}
          {event.kind === "tool_call_finished" && details.duration_seconds && (
            <span className="font-mono text-[9.5px]" style={{ color: "var(--mute-3)" }}>
              {Number(details.duration_seconds).toFixed(2)}s
            </span>
          )}
          {event.status && event.status !== "info" && (
            <span
              className="font-mono text-[9px] uppercase tracking-wide"
              style={{
                color: event.status === "error" ? "var(--rose)"
                  : event.status === "warning" ? "var(--signal)"
                  : "var(--mute-3)",
              }}
            >
              {event.status}
            </span>
          )}
          <span className="ml-auto font-mono text-[9px] opacity-0 transition-opacity group-hover:opacity-100" style={{ color: "var(--mute-3)" }}>
            {fmt(event.timestamp)}
          </span>
        </div>
        {event.message && event.message !== event.kind && (
          <div className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--mute-2)" }}>
            {event.message}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── event stream panel ── */
function EventStream({ events, autoScroll, eventLimit }) {
  const listRef = useRef(null);
  const [localAutoScroll, setLocalAutoScroll] = useState(autoScroll);

  // Sync with settings
  useEffect(() => { setLocalAutoScroll(autoScroll); }, [autoScroll]);

  useEffect(() => {
    if (localAutoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events.length, localAutoScroll]);

  const displayed = events.slice(-Math.max(20, eventLimit || 120));

  if (!displayed.length) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3" style={{ color: "var(--mute-3)" }}>
        <svg width="32" height="32" viewBox="0 0 32 32" fill="none" style={{ opacity: 0.4 }}>
          <rect x="4" y="8" width="24" height="2.5" rx="1.25" fill="currentColor"/>
          <rect x="4" y="14.5" width="18" height="2.5" rx="1.25" fill="currentColor"/>
          <rect x="4" y="21" width="21" height="2.5" rx="1.25" fill="currentColor"/>
        </svg>
        <span className="text-[12px]">Events will appear here</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto p-2 space-y-0.5"
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          setLocalAutoScroll(atBottom);
        }}
      >
        {displayed.map((e, idx) => (
          <EventEntry key={`${e.seq}-${idx}`} event={e} idx={idx} />
        ))}
      </div>
      {!localAutoScroll && (
        <button
          type="button"
          onClick={() => {
            setLocalAutoScroll(true);
            if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
          }}
          className="mx-2 mb-2 rounded-lg py-1.5 text-center text-[11px] transition-colors"
          style={{
            background: "color-mix(in oklch, var(--signal) 12%, transparent)",
            border: "1px solid color-mix(in oklch, var(--signal) 28%, transparent)",
            color: "var(--signal)",
          }}
        >
          ↓ Jump to latest
        </button>
      )}
    </div>
  );
}

/* ── metrics strip ── */
function MetricsStrip({ events }) {
  const m = useMemo(() => {
    const toolCalls = events.filter((e) => e.kind === "tool_call_started").length;
    const llmCalls  = events.filter((e) => e.kind === "llm_response").length;
    const totalTok  = events.reduce((acc, e) => acc + (e.details?.input_tokens || 0) + (e.details?.output_tokens || 0), 0);
    const totalCost = events.reduce((acc, e) => acc + Number(e.details?.estimated_total_cost_usd || 0), 0);
    return { toolCalls, llmCalls, totalTok, totalCost };
  }, [events]);

  if (!events.length) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-2.5"
      style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.012)" }}
    >
      <Metric label="Tools"    value={m.toolCalls}                     color="var(--sky)" />
      <Metric label="LLM"      value={m.llmCalls}                      color="var(--violet)" />
      <Metric label="Tokens"   value={m.totalTok.toLocaleString()}      color="var(--signal)" />
      <Metric label="Est. cost" value={`$${m.totalCost.toFixed(5)}`}   color="var(--mint)" />
    </div>
  );
}

function Metric({ label, value, color }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="owc-stat-num text-[15px]" style={{ color }}>{value}</span>
      <span className="text-[10px] uppercase tracking-wide" style={{ color: "var(--mute-2)" }}>{label}</span>
    </div>
  );
}

/* ── tab button ── */
function TabBtn({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md px-2.5 py-1 text-[11.5px] font-medium transition-all"
      style={{
        background: active ? "color-mix(in oklch, var(--signal) 14%, transparent)" : "transparent",
        color: active ? "var(--signal)" : "var(--mute-2)",
        border: active ? "1px solid color-mix(in oklch, var(--signal) 25%, transparent)" : "1px solid transparent",
      }}
    >
      {children}
    </button>
  );
}

/* ── main export ── */
export function RunDetailLive({ runId, activeTrace = null, persistedEvents = [] }) {
  const [events, setEvents]     = useState(() => mergeLiveEvents([], activeTrace?.events || persistedEvents || []));
  const [liveStream, setLiveStream] = useState(Boolean(activeTrace));
  const [replayMs, setReplayMs] = useState(80);
  const [isReplaying, setIsReplaying] = useState(false);
  const [tab, setTab]           = useState("graph");
  const { settings, update, reset } = useRunViewSettings();

  /* SSE live stream */
  useEffect(() => {
    if (!liveStream || !runId) return;
    const source = new EventSource(apiUrl(`/ui/runs/${runId}/stream`));
    source.onmessage = (payload) => {
      try {
        const parsed = JSON.parse(payload.data || "{}");
        const incoming = Array.isArray(parsed?.events) ? parsed.events : [];
        if (!incoming.length) return;
        setEvents((cur) => mergeLiveEvents(cur, incoming));
      } catch { /* ignore */ }
    };
    return () => source.close();
  }, [liveStream, runId]);

  /* replay */
  async function replay() {
    if (!persistedEvents.length) return;
    setIsReplaying(true);
    setEvents([]);
    for (const e of persistedEvents) {
      setEvents((cur) => [...cur, e]);
      await new Promise((res) => setTimeout(res, Math.max(20, replayMs)));
    }
    setIsReplaying(false);
  }

  const rootActor = useMemo(
    () => activeTrace?.root_actor || events.find((e) => e.actor)?.actor || "orchestrator",
    [activeTrace, events]
  );

  const isLive = liveStream && !isReplaying;

  /* whether this run is actively running (use to auto-fetch browser screenshots) */
  const isActiveRun = Boolean(activeTrace) || (liveStream && events.some((e) => e.kind === "pipeline_started") && !events.some((e) => e.kind === "pipeline_finished" || e.kind === "pipeline_failed"));

  return (
    <div className="space-y-4 animate-fade-up">

      {/* ── control bar ── */}
      <div
        className="flex flex-wrap items-center gap-2 rounded-[12px] border px-3 py-2.5"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        {/* live toggle */}
        <button
          type="button"
          onClick={() => setLiveStream((v) => !v)}
          className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all"
          style={{
            background: liveStream
              ? "color-mix(in oklch, var(--rose) 12%, transparent)"
              : "color-mix(in oklch, var(--mute-3) 25%, transparent)",
            border: liveStream
              ? "1px solid color-mix(in oklch, var(--rose) 28%, transparent)"
              : "1px solid var(--line)",
            color: liveStream ? "var(--rose)" : "var(--mute)",
          }}
        >
          {liveStream ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--rose)", animation: "breathe 1.2s ease-in-out infinite" }} />
              Live
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--mute-3)" }} />
              Paused
            </>
          )}
        </button>

        {/* replay */}
        <button
          type="button"
          onClick={replay}
          disabled={isReplaying || !persistedEvents.length}
          className="rounded-lg border px-3 py-1.5 text-[12px] transition-all disabled:opacity-40"
          style={{ borderColor: "var(--line)", color: "var(--mute)", background: "transparent" }}
        >
          {isReplaying ? "Replaying…" : "↺ Replay"}
        </button>
        <div className="flex items-center gap-1.5">
          <input
            type="number" min="20" step="10" value={replayMs}
            onChange={(e) => setReplayMs(Number(e.target.value || 80))}
            className="w-16 rounded-md border px-2 py-1 text-[11px] focus:outline-none"
            style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.15)", color: "var(--ink-dim)" }}
          />
          <span className="text-[10.5px]" style={{ color: "var(--mute-3)" }}>ms</span>
        </div>

        {/* event count */}
        <span className="font-mono text-[10.5px]" style={{ color: "var(--mute-2)" }}>
          {events.length} events
        </span>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1">
            <TabBtn active={tab === "graph"}    onClick={() => setTab("graph")}>Graph</TabBtn>
            <TabBtn active={tab === "timeline"} onClick={() => setTab("timeline")}>Timeline</TabBtn>
            <TabBtn active={tab === "trace"}    onClick={() => setTab("trace")}>Trace</TabBtn>
          </div>
          {/* settings */}
          <RunViewSettingsButton settings={settings} update={update} reset={reset} />
        </div>
      </div>

      {/* ── metrics ── */}
      {events.length > 0 && (
        <div
          className="rounded-[12px] border animate-fade-up"
          style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)", animationDelay: "60ms" }}
        >
          <MetricsStrip events={events} />
        </div>
      )}

      {/* ── Browser live view (top of stack when enabled) ── */}
      {settings.showLiveView && runId && (
        <BrowserLiveView
          runId={runId}
          events={events}
          autoRefresh={isLive}
        />
      )}

      {/* ── main content grid: graph/timeline/trace + event stream ── */}
      <div className={`grid gap-4 ${settings.showEventStream ? "xl:grid-cols-[1fr_340px]" : ""}`}>
        {/* left: graph / timeline / trace */}
        <div>
          {tab === "graph" && <OrchestratorGraph events={events} rootActor={rootActor} />}
          {tab === "timeline" && <TimelinePanel events={events} onSelectEvent={() => {}} />}
          {tab === "trace" && <TraceExplorer events={events} />}
        </div>

        {/* right: live event stream */}
        {settings.showEventStream && (
          <div
            className="flex flex-col overflow-hidden rounded-[14px] border"
            style={{
              borderColor: "var(--line)",
              background: "var(--card)",
              boxShadow: "var(--shadow-card)",
              minHeight: 380,
              maxHeight: 500,
            }}
          >
            <div
              className="flex shrink-0 items-center gap-2 border-b px-3 py-2.5"
              style={{ borderColor: "var(--line)" }}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ color: "var(--mute-2)", flexShrink: 0 }}>
                <path d="M1 3h10M1 6h7M1 9h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
              </svg>
              <span className="text-[11px] font-semibold tracking-wide" style={{ color: "var(--ink-dim)" }}>
                Event Stream
              </span>
              <span className="ml-1 font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
                ({events.length})
              </span>
              {isLive && (
                <span className="live-badge ml-auto">
                  <span className="dot" />
                  LIVE
                </span>
              )}
            </div>
            <EventStream
              events={events}
              autoScroll={settings.autoScroll}
              eventLimit={settings.eventLimit}
            />
          </div>
        )}
      </div>
    </div>
  );
}
