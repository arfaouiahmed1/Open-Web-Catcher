"use client";

import { useMemo, useState } from "react";

import { JsonViewer } from "@/components/json-viewer";
import { safeJson } from "@/lib/utils";

function extractScreenshot(value) {
  if (!value) return "";
  if (typeof value === "string") {
    if (value.startsWith("http") || value.startsWith("data:image/")) return value;
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
    if (typeof value.screenshot_url === "string" && value.screenshot_url) return value.screenshot_url;
    if (Array.isArray(value.screenshot_urls) && value.screenshot_urls.length) return value.screenshot_urls[0];
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
  return rows.slice(0, 80);
}

export function TraceExplorer({ events = [] }) {
  const [selected, setSelected] = useState(0);
  const [compare, setCompare] = useState(null);
  const steps = useMemo(
    () => events.filter((event) => ["prompt_compiled", "tool_call_started", "tool_call_finished", "llm_response"].includes(event.kind)),
    [events]
  );
  const active = steps[selected] || null;
  const compareEvent = compare != null ? steps[compare] || null : null;

  if (!steps.length) {
    return (
      <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4 text-xs text-slate-700">
        Trace explorer is available when trace events are present.
      </div>
    );
  }

  const activeText = safeJson(active?.details || active || {});
  const compareText = safeJson(compareEvent?.details || compareEvent || {});
  const diffs = compareEvent ? lineDiff(compareText, activeText) : [];
  const screenshot = extractScreenshot(active?.details?.result_full || active?.details?.result_preview || active?.details || {});

  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.03] overflow-hidden">
      <div className="grid xl:grid-cols-[260px_1fr]">
        <div className="border-r border-white/6 max-h-[520px] overflow-auto">
          <div className="px-3 py-2 text-xs font-semibold text-white border-b border-white/6">Steps</div>
          {steps.map((step, idx) => (
            <div key={`${step.seq}-${idx}`} className={`border-b border-white/4 px-3 py-2 text-xs ${idx === selected ? "bg-signal/10" : ""}`}>
              <button type="button" className="w-full text-left" onClick={() => setSelected(idx)}>
                <div className="font-medium text-slate-200">#{step.seq} {step.kind}</div>
                <div className="text-slate-600">{step.actor || "unknown"}</div>
              </button>
              <button type="button" className="mt-1 text-[11px] text-slate-500 hover:text-white" onClick={() => setCompare(compare === idx ? null : idx)}>
                {compare === idx ? "clear compare" : "compare"}
              </button>
            </div>
          ))}
        </div>
        <div className="space-y-4 p-4">
          {screenshot && (
            <img src={screenshot} alt="Trace screenshot" className="h-48 w-full rounded border border-white/10 object-cover" />
          )}
          <JsonViewer label="Selected step details" value={active} />
          {compareEvent && (
            <div className="rounded-lg border border-white/10 bg-black/20 p-3">
              <div className="mb-2 text-xs font-semibold text-white">Step diff</div>
              <div className="max-h-52 overflow-auto space-y-1 text-xs font-mono">
                {diffs.length ? diffs.map((row) => (
                  <div key={row.line} className="rounded border border-white/6 p-2">
                    <div className="text-slate-600">line {row.line}</div>
                    <div className="text-red-300">- {row.before || "∅"}</div>
                    <div className="text-emerald-300">+ {row.after || "∅"}</div>
                  </div>
                )) : <div className="text-slate-600">No differences</div>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
