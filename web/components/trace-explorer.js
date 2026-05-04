"use client";

import { useMemo, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StructuredDataCard } from "@/components/structured-data-card";
import { safeJson } from "@/lib/utils";

const MAX_DIFF_LINES = 80;

function extractScreenshot(value) {
  if (!value) return "";
  if (typeof value === "string") {
    if (value.startsWith("http") || value.startsWith("data:image/"))
      return value;
    try {
      return extractScreenshot(JSON.parse(value));
    } catch {
      return "";
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = extractScreenshot(item);
      if (nested) return nested;
    }
    return "";
  }
  if (typeof value === "object") {
    if (typeof value.screenshot_url === "string" && value.screenshot_url)
      return value.screenshot_url;
    if (Array.isArray(value.screenshot_urls) && value.screenshot_urls.length)
      return value.screenshot_urls[0];
    for (const nested of Object.values(value)) {
      const candidate = extractScreenshot(nested);
      if (candidate) return candidate;
    }
  }
  return "";
}

function lineDiff(left, right) {
  const a = String(left || "").split("\n");
  const b = String(right || "").split("\n");
  const max = Math.max(a.length, b.length);
  const rows = [];
  for (let i = 0; i < max; i += 1) {
    if ((a[i] || "") === (b[i] || "")) continue;
    rows.push({ line: i + 1, before: a[i] || "", after: b[i] || "" });
  }
  return rows.slice(0, MAX_DIFF_LINES);
}

export function TraceExplorer({ events = [] }) {
  const [selected, setSelected] = useState(0);
  const [compare, setCompare] = useState(null);
  const steps = useMemo(
    () =>
      events.filter((event) =>
        [
          "prompt_compiled",
          "tool_call_started",
          "tool_call_finished",
          "llm_response",
        ].includes(event.kind),
      ),
    [events],
  );
  const active = steps[selected] || null;
  const compareEvent = compare != null ? steps[compare] || null : null;

  if (!steps.length) {
    return (
      <Card>
        <CardContent className="p-4 text-xs text-muted-foreground/60">
          Trace explorer is available when trace events are present.
        </CardContent>
      </Card>
    );
  }

  const activeText = safeJson(active?.details || active || {});
  const compareText = safeJson(compareEvent?.details || compareEvent || {});
  const diffs = compareEvent ? lineDiff(compareText, activeText) : [];
  const screenshot = extractScreenshot(
    active?.details?.result_full ||
      active?.details?.result_preview ||
      active?.details ||
      {},
  );

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="border-b border-border px-4 py-3">
        <CardTitle className="text-sm font-medium">Trace explorer</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="grid xl:grid-cols-[260px_1fr]">
          <div className="max-h-[520px] overflow-auto border-r border-border bg-muted/20">
            <div className="border-b border-border px-3 py-2 text-xs font-semibold text-foreground">
              Steps
            </div>
            {steps.map((step, idx) => (
              <div
                key={`${step.seq}-${idx}`}
                className={`border-b border-border px-3 py-2 text-xs ${idx === selected ? "bg-primary/10" : ""}`}
              >
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={() => setSelected(idx)}
                >
                  <div className="font-medium text-foreground">
                    #{step.seq} {step.kind}
                  </div>
                  <div className="text-muted-foreground/70">{step.actor || "unknown"}</div>
                </button>
                <button
                  type="button"
                  className="mt-1 text-[11px] text-muted-foreground hover:text-foreground"
                  onClick={() => setCompare(compare === idx ? null : idx)}
                >
                  {compare === idx ? "clear compare" : "compare"}
                </button>
              </div>
            ))}
          </div>
          <div className="space-y-4 p-4">
            {screenshot && (
              <div className="overflow-hidden rounded-lg border border-border">
                <img
                  src={screenshot}
                  alt="Trace screenshot"
                  className="h-48 w-full object-cover"
                />
              </div>
            )}
            <StructuredDataCard
              title="Selected step details"
              description="Structured trace fields for the current step."
              data={active}
              limit={6}
            />
            {compareEvent && (
              <div className="rounded-lg border border-border bg-muted/50 p-3">
                <div className="mb-2 text-xs font-semibold text-foreground">
                  Step diff
                </div>
                <div className="max-h-52 overflow-auto space-y-1 text-xs font-mono">
                  {diffs.length ? (
                    diffs.map((row) => (
                      <div
                        key={row.line}
                        className="rounded border border-border p-2"
                      >
                        <div className="text-muted-foreground/70">line {row.line}</div>
                        <div className="text-rose-400">- {row.before || "∅"}</div>
                        <div className="text-emerald-400">
                          + {row.after || "∅"}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-muted-foreground/70">No differences</div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
