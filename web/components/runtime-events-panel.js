"use client";

import { formatNumber } from "@/lib/utils";

function tone(status) {
  const normalized = String(status || "").trim().toLowerCase();
  if (normalized === "success") return "var(--mint)";
  if (normalized === "error") return "var(--rose)";
  if (normalized === "warning") return "var(--signal)";
  return "var(--sky)";
}

export function RuntimeEventsPanel({ events = [], title = "Runtime log" }) {
  const rows = [...events].slice(-60).reverse();
  return (
    <div
      className="rounded-[14px] border overflow-hidden"
      style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      <div className="flex items-center justify-between border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
        <div>
          <div className="text-[13.5px] font-medium text-[var(--ink)]">{title}</div>
          <div className="mt-0.5 text-[12px]" style={{ color: "var(--mute)" }}>
            Normalized runtime events and agent lifecycle logs.
          </div>
        </div>
        <span className="font-mono text-[11px]" style={{ color: "var(--mute)" }}>
          {formatNumber(events.length)} events
        </span>
      </div>

      {!rows.length ? (
        <div className="px-4 py-10 text-center text-[12px]" style={{ color: "var(--mute)" }}>
          No runtime events recorded yet.
        </div>
      ) : (
        <div className="max-h-[560px] overflow-auto">
          {rows.map((event, index) => (
            <div
              key={`${event.seq || index}-${event.kind || "event"}`}
              className="grid gap-2 border-b px-4 py-3 md:grid-cols-[72px_140px_1fr]"
              style={{ borderColor: "var(--line)" }}
            >
              <div className="font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
                #{event.seq || index + 1}
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: tone(event.status) }}>
                  {event.kind || "event"}
                </div>
                <div className="mt-0.5 text-[10.5px]" style={{ color: "var(--mute-2)" }}>
                  {event.actor || "system"}
                </div>
              </div>
              <div>
                <div className="text-[12px]" style={{ color: "var(--ink-dim)" }}>
                  {event.message || "No message"}
                </div>
                <div className="mt-1 text-[10.5px]" style={{ color: "var(--mute-3)" }}>
                  {event.timestamp ? new Date(event.timestamp).toLocaleString() : "No timestamp"}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
