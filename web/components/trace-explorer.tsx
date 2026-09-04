"use client";

import { useMemo, useState, memo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StructuredDataCard } from "@/components/structured-data-card";
import { safeJson } from "@/lib/utils";

const MAX_DIFF_LINES = 80;

export interface TraceEvent {
  seq?: number;
  kind: string;
  actor?: string;
  status?: string;
  message?: string;
  timestamp?: string;
  details?: Record<string, unknown> | string;
}

function extractScreenshot(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") {
    if (value.startsWith("http") || value.startsWith("data:image/")) return value;
    try {
      return extractScreenshot(JSON.parse(value) as unknown);
    } catch {
      return "";
    }
  }
  if (Array.isArray(value)) {
    for (const item of value as unknown[]) {
      const nested = extractScreenshot(item);
      if (nested) return nested;
    }
    return "";
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.screenshot_url === "string" && obj.screenshot_url) return obj.screenshot_url as string;
    if (Array.isArray(obj.screenshot_urls) && (obj.screenshot_urls as unknown[]).length) return (obj.screenshot_urls as string[])[0];
    for (const nested of Object.values(obj)) {
      const candidate = extractScreenshot(nested);
      if (candidate) return candidate;
    }
  }
  return "";
}

function lineDiff(left: string, right: string): Array<{ line: number; before: string; after: string }> {
  const a = String(left ?? "").split("\n");
  const b = String(right ?? "").split("\n");
  const max = Math.max(a.length, b.length);
  const rows: Array<{ line: number; before: string; after: string }> = [];
  for (let i = 0; i < max; i += 1) {
    if ((a[i] ?? "") === (b[i] ?? "")) continue;
    rows.push({ line: i + 1, before: a[i] ?? "", after: b[i] ?? "" });
  }
  return rows.slice(0, MAX_DIFF_LINES);
}

export interface TraceExplorerProps {
  events?: TraceEvent[];
}

export const TraceExplorer = memo(function TraceExplorer({ events = [] }: TraceExplorerProps): React.JSX.Element {
  const [selected, setSelected] = useState(0);
  const [compare, setCompare] = useState<number | null>(null);
  const steps = useMemo(
    () => events.filter((event) => ["prompt_compiled", "tool_call_started", "tool_call_finished", "llm_response"].includes(event.kind)),
    [events],
  );
  const active = steps[selected] ?? null;
  const compareEvent = compare != null ? (steps[compare] ?? null) : null;

  if (!steps.length) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground/75">Trace explorer is available when trace events are present.</CardContent>
      </Card>
    );
  }

  const activeText = safeJson((active?.details as unknown) ?? active ?? {});
  const compareText = safeJson((compareEvent?.details as unknown) ?? compareEvent ?? {});
  const diffs = compareEvent ? lineDiff(compareText, activeText) : [];
  const screenshot = extractScreenshot((active?.details as Record<string, unknown>)?.result_full ?? (active?.details as Record<string, unknown>)?.result_preview ?? active?.details ?? {});

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="border-b border-border px-4 py-3">
        <CardTitle className="text-sm font-medium">Trace explorer</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid xl:grid-cols-[260px_1fr]">
          <div className="max-h-[520px] overflow-auto border-r border-border bg-muted/20">
            <div className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">Steps</div>
            {steps.map((step, idx) => (
              <div key={`${step.seq}-${idx}`} className={`border-b border-border px-3 py-2 text-xs ${idx === selected ? "bg-primary/10" : ""}`}>
                <button type="button" className="w-full text-left" onClick={() => setSelected(idx)}>
                  <div className="font-medium text-foreground">#{step.seq} {step.kind}</div>
                  <div className="text-muted-foreground/70">{step.actor ?? "unknown"}</div>
                </button>
                <button type="button" className="mt-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={() => setCompare(compare === idx ? null : idx)}>
                  {compare === idx ? "clear compare" : "compare"}
                </button>
              </div>
            ))}
          </div>
          <div className="space-y-4 p-4">
            {screenshot ? (
              <div className="overflow-hidden rounded-lg border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary backend-hosted screenshot URL */}
                <img src={screenshot} alt="Trace screenshot" className="h-48 w-full object-cover" loading="lazy" decoding="async" />
              </div>
            ) : null}
            <StructuredDataCard title="Selected step details" description="Structured trace fields for the current step." data={active} limit={6} />
            {compareEvent ? (
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <div className="mb-2 text-xs font-semibold text-foreground">Step diff</div>
                <div className="max-h-52 overflow-auto space-y-1 text-xs font-mono">
                  {diffs.length ? diffs.map((row) => <div key={row.line} className="rounded border border-border p-2"><div className="text-muted-foreground/70">line {row.line}</div><div className="text-[var(--rose-text)]">- {row.before || "∅"}</div><div className="text-[var(--mint-text)]">+ {row.after || "∅"}</div></div>) : <div className="text-muted-foreground/70">No differences</div>}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
});
