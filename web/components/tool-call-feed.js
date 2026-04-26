"use client";

import { useMemo, useState } from "react";
import { Camera, ChevronDown, ExternalLink, Wrench } from "lucide-react";

import { formatNumber, safeJson } from "@/lib/utils";
import { STAGE_LABELS } from "@/lib/run-trace";

function toneForStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "error" || normalized === "failed") {
    return {
      text: "var(--rose)",
      border: "color-mix(in oklch, var(--rose) 24%, transparent)",
      bg: "color-mix(in oklch, var(--rose) 8%, transparent)",
    };
  }
  if (normalized === "running") {
    return {
      text: "var(--signal)",
      border: "color-mix(in oklch, var(--signal) 24%, transparent)",
      bg: "color-mix(in oklch, var(--signal) 9%, transparent)",
    };
  }
  return {
    text: "var(--mint)",
    border: "color-mix(in oklch, var(--mint) 24%, transparent)",
    bg: "color-mix(in oklch, var(--mint) 8%, transparent)",
  };
}

function JsonBlock({ label, value }) {
  const text = useMemo(() => safeJson(value), [value]);
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
        {label}
      </div>
      <pre
        className="max-h-52 overflow-auto rounded-[10px] border p-2 text-[11px] whitespace-pre-wrap break-words"
        style={{
          borderColor: "var(--line)",
          background: "rgba(0,0,0,0.18)",
          color: "var(--ink-dim)",
        }}
      >
        {text}
      </pre>
    </div>
  );
}

function ToolCallRow({ call }) {
  const [expanded, setExpanded] = useState(false);
  const [activeScreenshot, setActiveScreenshot] = useState(call.screenshots?.[0] || "");
  const tone = toneForStatus(call.status);
  const stageLabel = STAGE_LABELS[call.stage] || call.actor || "Agent";
  const hasDetails = Boolean((call.args && Object.keys(call.args).length) || call.result || (call.screenshots || []).length);

  return (
    <div
      className="rounded-[12px] border"
      style={{
        borderColor: tone.border,
        background: tone.bg,
      }}
    >
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((value) => !value)}
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
        disabled={!hasDetails}
      >
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
          style={{
            background: "color-mix(in oklch, var(--card) 72%, transparent)",
            color: tone.text,
          }}
        >
          <Wrench className="h-4 w-4" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: tone.text }}>
              {stageLabel}
            </span>
            <span
              className="rounded-full px-2 py-0.5 font-mono text-[10px]"
              style={{
                background: "rgba(0,0,0,0.18)",
                color: "var(--ink-dim)",
              }}
            >
              {call.toolName}
            </span>
            {call.startSeq ? (
              <span className="font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
                #{call.startSeq}
              </span>
            ) : null}
            <span className="ml-auto font-mono text-[10px]" style={{ color: tone.text }}>
              {String(call.status || "success")}
            </span>
          </div>

          {call.target ? (
            <div className="mt-1 truncate font-mono text-[11px]" style={{ color: "var(--mute-2)" }} title={call.target}>
              {call.target}
            </div>
          ) : null}

          <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
            {call.durationSeconds ? <span>{Number(call.durationSeconds).toFixed(2)}s</span> : null}
            {(call.screenshots || []).length ? <span>{formatNumber(call.screenshots.length)} shot{call.screenshots.length === 1 ? "" : "s"}</span> : null}
          </div>
        </div>

        {hasDetails ? (
          <ChevronDown
            className="mt-0.5 h-4 w-4 shrink-0 transition-transform"
            style={{
              color: "var(--mute-3)",
              transform: expanded ? "rotate(180deg)" : "rotate(0deg)",
            }}
          />
        ) : null}
      </button>

      {expanded ? (
        <div className="space-y-3 border-t px-3 pb-3 pt-3" style={{ borderColor: "var(--line)" }}>
          {activeScreenshot ? (
            <div className="overflow-hidden rounded-[12px] border" style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.24)" }}>
              <img src={activeScreenshot} alt={`${call.toolName} screenshot`} className="max-h-64 w-full object-cover" />
              <div className="flex items-center gap-2 border-t px-2.5 py-1.5" style={{ borderColor: "var(--line)" }}>
                <span className="truncate font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>{activeScreenshot}</span>
                <a href={activeScreenshot} target="_blank" rel="noreferrer" className="ml-auto shrink-0" style={{ color: "var(--mute)" }}>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
            </div>
          ) : null}

          {(call.screenshots || []).length > 1 ? (
            <div className="flex flex-wrap gap-2">
              {call.screenshots.map((url, index) => (
                <button
                  key={`${url}-${index}`}
                  type="button"
                  onClick={() => setActiveScreenshot((current) => (current === url ? "" : url))}
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium"
                  style={{
                    borderColor: "var(--line)",
                    background: activeScreenshot === url ? "color-mix(in oklch, var(--signal) 16%, transparent)" : "rgba(0,0,0,0.18)",
                    color: activeScreenshot === url ? "var(--signal)" : "var(--mute-2)",
                  }}
                >
                  <Camera className="h-3 w-3" />
                  {index + 1}
                </button>
              ))}
            </div>
          ) : null}

          {call.args && Object.keys(call.args).length ? <JsonBlock label="Inputs" value={call.args} /> : null}
          {call.result ? <JsonBlock label="Result" value={call.result} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function ToolCallFeed({ toolCalls = [], title = "Tool Calls", emptyLabel = "Tool calls will appear here.", maxHeight = 540 }) {
  return (
    <div
      className="overflow-hidden rounded-[14px] border"
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
        <Wrench className="h-4 w-4" style={{ color: "var(--signal)" }} />
        <span className="text-[12px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--signal)" }}>
          {title}
        </span>
        <span className="ml-auto font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
          {formatNumber(toolCalls.length)}
        </span>
      </div>

      <div className="space-y-2 overflow-y-auto p-3" style={{ maxHeight }}>
        {toolCalls.length ? (
          toolCalls.map((call) => <ToolCallRow key={call.key} call={call} />)
        ) : (
          <div className="flex h-36 items-center justify-center text-[12px]" style={{ color: "var(--mute-3)" }}>
            {emptyLabel}
          </div>
        )}
      </div>
    </div>
  );
}
