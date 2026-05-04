"use client";

import { formatNumber } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

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
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="flex-row items-center justify-between space-y-0 border-b border-border px-4 py-3">
        <div>
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <CardDescription className="text-xs">
            Normalized runtime events and agent lifecycle logs.
          </CardDescription>
        </div>
        <span className="font-mono text-[11px] text-muted-foreground">
          {formatNumber(events.length)} events
        </span>
      </CardHeader>

      {!rows.length ? (
        <CardContent className="px-4 py-10 text-center text-sm text-muted-foreground">
          No runtime events recorded yet.
        </CardContent>
      ) : (
        <CardContent className="max-h-[560px] overflow-auto p-0">
          {rows.map((event, index) => (
            <div
              key={`${event.seq || index}-${event.kind || "event"}`}
              className="grid gap-2 border-b px-4 py-3 md:grid-cols-[72px_140px_1fr]"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="font-mono text-[10px] text-muted-foreground/60">
                #{event.seq || index + 1}
              </div>
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: tone(event.status) }}>
                  {event.kind || "event"}
                </div>
                <div className="mt-0.5 text-[10.5px] text-muted-foreground">
                  {event.actor || "system"}
                </div>
              </div>
              <div>
                <div className="text-[12px] text-foreground/80">
                  {event.message || "No message"}
                </div>
                <div className="mt-1 text-[10.5px] text-muted-foreground/60">
                  {event.timestamp ? new Date(event.timestamp).toLocaleString() : "No timestamp"}
                </div>
              </div>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
