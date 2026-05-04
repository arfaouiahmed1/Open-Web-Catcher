"use client";

import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

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
    if (event.kind === "agent_finished" || event.kind === "agent_failed")
      row.end = row.end == null ? at : Math.max(row.end, at);
    if (event.kind === "tool_call_started")
      row.tool.push({ at, seq: event.seq, name: event.details?.tool_name || null });
    if (event.kind === "llm_response")
      row.llm.push({ at, seq: event.seq, model: event.details?.model_name || null, tokens: (event.details?.input_tokens || 0) + (event.details?.output_tokens || 0) });
  }
  if (!allTimes.length) return { rows: [], min: 0, max: 1, totalMs: 0 };
  const min = Math.min(...allTimes);
  const max = Math.max(...allTimes);
  return { rows: Array.from(actorMap.values()), min, max: max === min ? min + 1 : max, totalMs: max - min };
}

function pct(at, min, max) {
  return ((at - min) / (max - min)) * 100;
}

function durLabel(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ── actor color by name ── */
function actorColor(actor) {
  if (!actor) return "var(--mute-2)";
  const a = actor.toLowerCase();
  if (a.includes("orchestrat")) return "var(--signal)";
  if (a.includes("classif"))   return "var(--sky)";
  if (a.includes("landing"))   return "var(--violet)";
  if (a.includes("hosting"))   return "var(--mint)";
  if (a.includes("embedded"))  return "oklch(0.76 0.13 64)";
  return "var(--mute-2)";
}

/* ── tooltip ── */
function Tooltip({ children, label }) {
  const [show, setShow] = useState(false);
  return (
    <span
      className="relative"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && label && (
        <span
          className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 whitespace-nowrap rounded-md px-2 py-1 text-[10px] font-mono animate-fade-up"
          style={{
            transform: "translateX(-50%)",
            background: "var(--panel)",
            border: "1px solid var(--line-hi)",
            color: "var(--ink-dim)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.6)",
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}

/* ── empty skeleton ── */
function EmptySkeleton() {
  return (
    <div className="space-y-3 p-4">
      {[80, 55, 70].map((w, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-2.5 w-20 rounded-full shimmer" style={{ background: "var(--line)" }} />
          <div className="flex-1 h-9 rounded-lg shimmer" style={{ background: "var(--line)", width: `${w}%` }} />
        </div>
      ))}
    </div>
  );
}

export function TimelinePanel({ events = [], onSelectEvent }) {
  const { rows, min, max, totalMs } = buildTimeline(events);

  if (!rows.length) {
    return (
      <Card className="overflow-hidden shadow-card">
        <CardHeader className="flex-row items-center gap-2 space-y-0 border-b border-border px-4 py-3">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ color: "var(--mute-2)" }}>
            <path d="M1 6h10M6 1v10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.5"/>
            <rect x="2" y="4" width="8" height="4" rx="1" stroke="currentColor" strokeWidth="1" opacity="0.3"/>
          </svg>
          <CardTitle className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Execution Timeline
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <EmptySkeleton />
          <div className="px-4 pb-4 text-center text-[11px] text-muted-foreground/60">
            Timeline appears when events stream in
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden animate-fade-up shadow-card">
      <CardHeader className="flex-row items-center gap-3 space-y-0 border-b border-border px-4 py-3">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style={{ color: "var(--signal)", flexShrink: 0 }}>
          <path d="M1 6h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
          <circle cx="3.5" cy="6" r="1.5" fill="currentColor"/>
          <circle cx="8.5" cy="6" r="1.5" fill="currentColor"/>
        </svg>
        <CardTitle className="text-[11px] font-semibold uppercase tracking-wide text-foreground">
          Execution Timeline
        </CardTitle>
        <span className="ml-auto font-mono text-[9.5px] text-muted-foreground">
          total {durLabel(totalMs)}
        </span>
      </CardHeader>

      <CardContent className="space-y-2 p-4">
        {rows.map((row) => {
          const start   = row.start ?? min;
          const end     = row.end   ?? max;
          const left    = pct(start, min, max);
          const width   = Math.max(1, pct(end, min, max) - left);
          const durMs   = end - start;
          const color   = actorColor(row.actor);

          return (
            <div
              key={row.actor}
              className="group -mx-2 flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors"
              style={{ cursor: "default" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.025)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              {/* label */}
              <div className="w-24 shrink-0 truncate font-mono text-[10px] text-right" style={{ color }}>
                {row.actor}
              </div>

              {/* bar track */}
              <div className="relative flex-1 overflow-visible rounded-lg h-9 bg-muted/30">
                {/* duration bar */}
                <Tooltip label={`${row.actor} · ${durLabel(durMs)}`}>
                  <button
                    type="button"
                    onClick={() => onSelectEvent?.(row.tool[0]?.seq || row.llm[0]?.seq || null)}
                    className="absolute top-1.5 h-6 rounded-md cursor-pointer transition-opacity hover:opacity-80"
                    style={{
                      left: `${left}%`,
                      width: `${width}%`,
                      background: `color-mix(in oklch, ${color} 35%, transparent)`,
                      border: `1px solid color-mix(in oklch, ${color} 45%, transparent)`,
                    }}
                    title=""
                  />
                </Tooltip>

                {/* tool ticks */}
                {row.tool.map((tick) => (
                  <Tooltip key={`tool-${row.actor}-${tick.seq}`} label={tick.name ? `🔧 ${tick.name}` : `Tool #${tick.seq}`}>
                    <button
                      type="button"
                      onClick={() => onSelectEvent?.(tick.seq)}
                      className="absolute top-1 h-7 w-[3px] rounded-full cursor-pointer transition-opacity hover:opacity-90"
                      style={{
                        left: `${pct(tick.at, min, max)}%`,
                        background: "var(--sky)",
                        boxShadow: "0 0 4px color-mix(in oklch, var(--sky) 50%, transparent)",
                      }}
                      title=""
                    />
                  </Tooltip>
                ))}

                {/* llm ticks */}
                {row.llm.map((tick) => (
                  <Tooltip
                    key={`llm-${row.actor}-${tick.seq}`}
                    label={[tick.model?.replace(/^models\//, ""), tick.tokens ? `${tick.tokens} tok` : null].filter(Boolean).join(" · ") || `LLM #${tick.seq}`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectEvent?.(tick.seq)}
                      className="absolute top-1.5 h-6 w-[3px] rounded-full cursor-pointer transition-opacity hover:opacity-90"
                      style={{
                        left: `${pct(tick.at, min, max)}%`,
                        background: "var(--violet)",
                        boxShadow: "0 0 4px color-mix(in oklch, var(--violet) 50%, transparent)",
                      }}
                      title=""
                    />
                  </Tooltip>
                ))}
              </div>

              {/* duration label */}
              <div className="w-12 shrink-0 text-right font-mono text-[9.5px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                {durLabel(durMs)}
              </div>
            </div>
          );
        })}
      </CardContent>

      <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 bg-muted/20">
        <span className="text-[9.5px] uppercase tracking-wide text-muted-foreground/60">Legend</span>
        <span className="flex items-center gap-1.5 text-[9.5px] text-sky-400">
          <span className="inline-block h-[3px] w-3 rounded-full bg-sky-400" />
          Tool call
        </span>
        <span className="flex items-center gap-1.5 text-[9.5px] text-violet-400">
          <span className="inline-block h-[3px] w-3 rounded-full bg-violet-400" />
          LLM call
        </span>
      </div>
    </Card>
  );
}
