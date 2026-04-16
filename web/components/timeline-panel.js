"use client";

function toMs(value) {
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildTimeline(events) {
  const actorMap = new Map();
  const allTimes = [];
  for (const event of events) {
    const actor = event?.actor || "";
    if (!actor) continue;
    const at = toMs(event.timestamp);
    if (!at) continue;
    allTimes.push(at);
    if (!actorMap.has(actor)) {
      actorMap.set(actor, { actor, start: null, end: null, tool: [], llm: [] });
    }
    const row = actorMap.get(actor);
    if (event.kind === "agent_started") row.start = row.start == null ? at : Math.min(row.start, at);
    if (event.kind === "agent_finished" || event.kind === "agent_failed") row.end = row.end == null ? at : Math.max(row.end, at);
    if (event.kind === "tool_call_started") row.tool.push({ at, seq: event.seq });
    if (event.kind === "llm_response") row.llm.push({ at, seq: event.seq });
  }
  if (!allTimes.length) return { rows: [], min: 0, max: 1 };
  const min = Math.min(...allTimes);
  const max = Math.max(...allTimes);
  return { rows: Array.from(actorMap.values()), min, max: max === min ? min + 1 : max };
}

function pct(at, min, max) {
  return ((at - min) / (max - min)) * 100;
}

export function TimelinePanel({ events = [], onSelectEvent }) {
  const { rows, min, max } = buildTimeline(events);
  if (!rows.length) {
    return (
      <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-xs text-slate-700">
        Timeline appears when events stream in.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4">
      <div className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Execution Timeline</div>
      <div className="space-y-3">
        {rows.map((row) => {
          const start = row.start ?? min;
          const end = row.end ?? max;
          const left = pct(start, min, max);
          const width = Math.max(1, pct(end, min, max) - left);
          return (
            <div key={row.actor}>
              <div className="mb-1 text-xs text-slate-400">{row.actor}</div>
              <div className="relative h-7 rounded bg-black/30">
                <button
                  type="button"
                  onClick={() => onSelectEvent?.(row.tool[0]?.seq || row.llm[0]?.seq || null)}
                  className="absolute top-1.5 h-4 rounded bg-signal/40 hover:bg-signal/60"
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`${row.actor} window`}
                />
                {row.tool.map((tick) => (
                  <button
                    key={`tool-${row.actor}-${tick.seq}`}
                    type="button"
                    onClick={() => onSelectEvent?.(tick.seq)}
                    className="absolute top-0.5 h-6 w-[2px] bg-amber-300"
                    style={{ left: `${pct(tick.at, min, max)}%` }}
                    title={`Tool #${tick.seq}`}
                  />
                ))}
                {row.llm.map((tick) => (
                  <button
                    key={`llm-${row.actor}-${tick.seq}`}
                    type="button"
                    onClick={() => onSelectEvent?.(tick.seq)}
                    className="absolute top-1 h-5 w-[2px] bg-violet-300"
                    style={{ left: `${pct(tick.at, min, max)}%` }}
                    title={`LLM #${tick.seq}`}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
