"use client";

import { useEffect, useMemo, useState } from "react";

import { JsonViewer } from "@/components/json-viewer";
import { TimelinePanel } from "@/components/timeline-panel";
import { WorkflowCanvas } from "@/components/workflow-canvas";
import { TraceExplorer } from "@/components/trace-explorer";
import { apiUrl } from "@/lib/api";

function EventPane({ events }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] overflow-hidden">
      <div className="border-b border-white/6 px-4 py-3 text-xs font-semibold text-white">Event Log</div>
      <div className="max-h-[420px] overflow-auto p-3 space-y-1">
        {events.length ? events.map((event, idx) => (
          <div key={`${event.seq}-${idx}`} id={`detail-event-${event.seq}`} className="rounded border border-white/6 px-2.5 py-1.5 text-xs">
            <div className="font-medium text-slate-300">{event.kind}</div>
            <div className="text-slate-600">{event.message || "—"}</div>
          </div>
        )) : <div className="text-xs text-slate-700">No events yet</div>}
      </div>
    </div>
  );
}

export function RunDetailLive({ runId, activeTrace = null, persistedEvents = [] }) {
  const [events, setEvents] = useState(activeTrace?.events || persistedEvents || []);
  const [liveStream, setLiveStream] = useState(Boolean(activeTrace));
  const [replayMs, setReplayMs] = useState(100);
  const [isReplaying, setIsReplaying] = useState(false);
  const [tab, setTab] = useState("timeline");

  useEffect(() => {
    if (!liveStream || !runId) return;
    const source = new EventSource(apiUrl(`/ui/runs/${runId}/stream`));
    source.onmessage = (payload) => {
      try {
        const parsed = JSON.parse(payload.data || "{}");
        const incoming = Array.isArray(parsed?.events) ? parsed.events : [];
        if (!incoming.length) return;
        setEvents((current) => [...current, ...incoming]);
      } catch {
        // ignore parse errors
      }
    };
    return () => source.close();
  }, [liveStream, runId]);

  async function replay() {
    if (!persistedEvents.length) return;
    setIsReplaying(true);
    setEvents([]);
    for (const event of persistedEvents) {
      setEvents((current) => [...current, event]);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, Math.max(20, replayMs)));
    }
    setIsReplaying(false);
  }

  const rootActor = useMemo(() => activeTrace?.root_actor || events.find((event) => event.actor)?.actor || "orchestrator", [activeTrace, events]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
        <button
          type="button"
          onClick={() => setLiveStream((v) => !v)}
          className={`rounded border px-2.5 py-1 text-xs ${liveStream ? "border-signal/40 bg-signal/10 text-signal" : "border-white/10 text-slate-400"}`}
        >
          {liveStream ? "Live stream on" : "Live stream off"}
        </button>
        <button
          type="button"
          onClick={replay}
          disabled={isReplaying || !persistedEvents.length}
          className="rounded border border-white/10 px-2.5 py-1 text-xs text-slate-300 disabled:text-slate-600"
        >
          {isReplaying ? "Replaying..." : "Replay"}
        </button>
        <input
          type="number"
          min="20"
          step="10"
          value={replayMs}
          onChange={(e) => setReplayMs(Number(e.target.value || 100))}
          className="w-20 rounded border border-white/10 bg-black/20 px-2 py-1 text-xs text-slate-300"
        />
        <span className="text-xs text-slate-600">ms/event</span>
        <div className="ml-auto flex gap-1">
          {["timeline", "trace"].map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`rounded px-2 py-1 text-xs ${tab === value ? "bg-signal/15 text-signal" : "text-slate-500"}`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <WorkflowCanvas events={events} rootActor={rootActor} />
      <TimelinePanel events={events} onSelectEvent={(seq) => document.getElementById(`detail-event-${seq}`)?.scrollIntoView({ behavior: "smooth", block: "center" })} />

      <div className="grid gap-4 xl:grid-cols-2">
        <EventPane events={events} />
        <JsonViewer label="Trace payload" value={{ run_id: runId, event_count: events.length }} />
      </div>

      {tab === "trace" && <TraceExplorer events={events} />}
    </div>
  );
}
