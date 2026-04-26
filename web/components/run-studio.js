"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Bot,
  Brain,
  Camera,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock,
  Cpu,
  DollarSign,
  ExternalLink,
  Loader2,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Square,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";

import { apiUrl } from "@/lib/api";
import { cn, formatCurrency, formatNumber, safeJson } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { WorkflowCanvas } from "@/components/workflow-canvas";
import { TimelinePanel } from "@/components/timeline-panel";

/* ─── constants ─────────────────────────────────────────────────────────── */

const AGENTS = [
  { value: "classification", label: "Classification", description: "Detect page type" },
  { value: "landing",        label: "Landing",        description: "Find hosting URLs" },
  { value: "hosting",        label: "Hosting",        description: "Extract streams" },
  { value: "embedded",       label: "Embedded",       description: "Handle iframes" },
];

const AGENT_PROMPT_FILES = {
  classification: "classification_v1.md",
  landing: "landing_page_v1.md",
  hosting: "hosting_page_v1.md",
  embedded: "embedded_page_v1.md",
};

const EVENT_META = {
  agent_started:       { color: "text-signal",    label: "Agent started" },
  agent_finished:      { color: "text-surge",     label: "Agent finished" },
  agent_failed:        { color: "text-ember",     label: "Agent failed" },
  agent_loop_started:  { color: "text-signal",    label: "Loop" },
  agent_loop_finished: { color: "text-surge",     label: "Loop done" },
  tool_session_connecting: { color: "text-sky-400", label: "Tool session" },
  tool_session_ready:      { color: "text-surge",   label: "Tools ready" },
  tool_session_closed:     { color: "text-slate-400", label: "Tools closed" },
  tool_session_failed:     { color: "text-ember",   label: "Tools failed" },
  tool_call_started:   { color: "text-spark",     label: "Tool call" },
  tool_call_finished:  { color: "text-surge",     label: "Tool done" },
  llm_turn_started:    { color: "text-violet-300",label: "LLM call" },
  llm_response:        { color: "text-violet-400",label: "LLM" },
  llm_timeout:         { color: "text-ember",     label: "LLM timeout" },
  llm_rate_limited:    { color: "text-amber-400", label: "LLM quota" },
  llm_error:           { color: "text-ember",     label: "LLM error" },
  prompt_compiled:     { color: "text-slate-400", label: "Prompt" },
  budget_exhausted:    { color: "text-amber-400", label: "Budget" },
  pipeline_started:    { color: "text-signal",    label: "Pipeline" },
  pipeline_failed:     { color: "text-ember",     label: "Pipeline failed" },
  run_cancelled:       { color: "text-amber-400", label: "Cancelled" },
};

const MAX_TEXT_SEGMENTS = 80;
const MAX_TEXT_PREVIEW_CHARS = 2400;
const MAX_JSON_PREVIEW_CHARS = 20000;
const MAX_PAYLOAD_TABLE_ROWS = 500;

function truncateText(value, maxChars = MAX_TEXT_PREVIEW_CHARS) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n…truncated for performance…`;
}

function eventFallbackKey(event) {
  return [
    String(event?.timestamp || ""),
    String(event?.actor || ""),
    String(event?.kind || ""),
    String(event?.status || ""),
    String(event?.message || ""),
  ].join("|");
}

function mergeEvents(currentEvents, incomingEvents) {
  if (!Array.isArray(incomingEvents) || incomingEvents.length === 0) {
    return currentEvents;
  }

  const merged = Array.isArray(currentEvents) ? [...currentEvents] : [];
  const seqToIndex = new Map();
  const fallbackKeys = new Set();

  merged.forEach((event, index) => {
    const seq = Number(event?.seq);
    if (Number.isFinite(seq) && seq > 0) {
      seqToIndex.set(seq, index);
      return;
    }
    fallbackKeys.add(eventFallbackKey(event));
  });

  for (const event of incomingEvents) {
    if (!event || typeof event !== "object") continue;

    const seq = Number(event.seq);
    if (Number.isFinite(seq) && seq > 0) {
      const existingIndex = seqToIndex.get(seq);
      if (existingIndex !== undefined) {
        merged[existingIndex] = { ...merged[existingIndex], ...event };
      } else {
        seqToIndex.set(seq, merged.length);
        merged.push(event);
      }
      continue;
    }

    const fallback = eventFallbackKey(event);
    if (!fallbackKeys.has(fallback)) {
      fallbackKeys.add(fallback);
      merged.push(event);
    }
  }

  merged.sort((a, b) => {
    const aSeq = Number(a?.seq);
    const bSeq = Number(b?.seq);
    const aHasSeq = Number.isFinite(aSeq) && aSeq > 0;
    const bHasSeq = Number.isFinite(bSeq) && bSeq > 0;

    if (aHasSeq && bHasSeq) return aSeq - bSeq;
    if (aHasSeq) return -1;
    if (bHasSeq) return 1;

    return String(a?.timestamp || "").localeCompare(String(b?.timestamp || ""));
  });

  return merged;
}

function tryParseJsonString(value) {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text) return value;

  const looksJson =
    (text.startsWith("{") && text.endsWith("}")) ||
    (text.startsWith("[") && text.endsWith("]"));
  if (!looksJson) return value;

  try {
    return JSON.parse(text);
  } catch {
    // Some payloads are escaped JSON strings (e.g. from nested MCP wrappers).
    try {
      const unescaped = text.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      return JSON.parse(unescaped);
    } catch {
      return value;
    }
  }
}

function decodeUriStringSafe(value) {
  const text = String(value ?? "");
  if (!text || text.startsWith("data:")) return text;
  if (!/%[0-9a-fA-F]{2}/.test(text) && !text.includes("+")) return text;

  const candidates = text.includes("+") ? [text.replace(/\+/g, "%20"), text] : [text];
  for (const candidate of candidates) {
    for (const decoder of [decodeURI, decodeURIComponent]) {
      try {
        const decoded = decoder(candidate);
        if (decoded) return decoded;
      } catch {
        // keep trying
      }
    }
  }
  return text;
}

function decodeUriDeep(value, seen = new WeakSet()) {
  if (typeof value === "string") return decodeUriStringSafe(value);
  if (value == null || typeof value !== "object") return value;
  if (seen.has(value)) return value;

  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => decodeUriDeep(item, seen));
  }

  const decoded = {};
  for (const [key, nested] of Object.entries(value)) {
    decoded[key] = decodeUriDeep(nested, seen);
  }
  return decoded;
}

function normalizePayloadValue(value, depth = 0) {
  if (depth > 8) return value;

  const parsed = tryParseJsonString(value);
  if (parsed !== value) {
    return normalizePayloadValue(parsed, depth + 1);
  }

  if (Array.isArray(parsed)) {
    const textBlocks =
      parsed.length > 0 &&
      parsed.every((item) => item && typeof item === "object" && typeof item.text === "string");

    if (textBlocks) {
      const joinedText = parsed.map((item) => String(item.text || "").trim()).filter(Boolean).join("\n");
      if (joinedText) {
        const normalizedJoined = normalizePayloadValue(joinedText, depth + 1);
        if (normalizedJoined !== joinedText) {
          return normalizedJoined;
        }
      }
    }

    if (parsed.length === 1) {
      const single = normalizePayloadValue(parsed[0], depth + 1);
      if (single !== parsed[0]) {
        return single;
      }
    }

    return parsed;
  }

  if (parsed && typeof parsed === "object") {
    const wrapperKeys = new Set(["type", "text", "id", "index", "role", "name", "mime_type", "annotations"]);
    const keys = Object.keys(parsed);
    const wrapperLike = keys.length > 0 && keys.every((key) => wrapperKeys.has(key));

    if (wrapperLike && typeof parsed.text === "string") {
      const normalizedText = normalizePayloadValue(parsed.text, depth + 1);
      if (normalizedText !== parsed.text) {
        return normalizedText;
      }
    }

    if (Array.isArray(parsed.content)) {
      const normalizedContent = normalizePayloadValue(parsed.content, depth + 1);
      if (normalizedContent !== parsed.content) {
        return normalizedContent;
      }
    }
  }

  return decodeUriDeep(parsed);
}

function inferValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function toDisplayValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return decodeUriStringSafe(value);
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return safeJson(value);
}

function collectPayloadRows(value, path, rows, seen, maxRows = MAX_PAYLOAD_TABLE_ROWS) {
  if (rows.length >= maxRows) return;

  if (value === undefined) {
    rows.push({ path, type: "undefined", value: "undefined" });
    return;
  }

  if (value === null || typeof value !== "object") {
    rows.push({
      path,
      type: inferValueType(value),
      value: toDisplayValue(value),
    });
    return;
  }

  if (seen.has(value)) {
    rows.push({ path, type: "circular", value: "[Circular]" });
    return;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      rows.push({ path, type: "array", value: "[]" });
    } else {
      value.forEach((entry, idx) => {
        collectPayloadRows(entry, `${path}[${idx}]`, rows, seen, maxRows);
      });
    }
    seen.delete(value);
    return;
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    rows.push({ path, type: "object", value: "{}" });
    seen.delete(value);
    return;
  }

  for (const [key, nested] of entries) {
    if (rows.length >= maxRows) break;
    const childPath = path === "$" ? key : `${path}.${key}`;
    collectPayloadRows(nested, childPath, rows, seen, maxRows);
  }

  seen.delete(value);
}

function ToolPayloadTable({ value }) {
  const normalized = useMemo(() => normalizePayloadValue(value), [value]);

  const rows = useMemo(() => {
    if (normalized == null || normalized === "") return [];
    const nextRows = [];
    collectPayloadRows(normalized, "$", nextRows, new WeakSet());
    if (nextRows.length >= MAX_PAYLOAD_TABLE_ROWS) {
      nextRows.push({
        path: "…",
        type: "notice",
        value: `Truncated to ${MAX_PAYLOAD_TABLE_ROWS} rows for performance.`,
      });
    }
    return nextRows;
  }, [normalized]);

  if (normalized == null || normalized === "") {
    return <div className="rounded bg-black/30 p-2 text-xs text-slate-600">No data</div>;
  }

  return (
    <div className="max-h-[420px] overflow-auto rounded border border-white/10 bg-black/20">
      <table className="min-w-full text-left text-xs text-slate-300">
        <thead>
          <tr className="border-b border-white/10 bg-white/[0.02]">
            <th className="min-w-[200px] px-2 py-1.5 font-medium uppercase tracking-wide text-slate-500">Path</th>
            <th className="w-24 px-2 py-1.5 font-medium uppercase tracking-wide text-slate-500">Type</th>
            <th className="px-2 py-1.5 font-medium uppercase tracking-wide text-slate-500">Value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={`${row.path}-${idx}`} className="border-b border-white/6 last:border-b-0">
              <td className="px-2 py-1.5 align-top font-mono text-slate-400">{row.path}</td>
              <td className="px-2 py-1.5 align-top text-slate-500">{row.type}</td>
              <td className="px-2 py-1.5 align-top">
                <pre dir="auto" className="whitespace-pre-wrap break-words font-mono text-[11px] text-slate-200">{row.value}</pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PayloadView({ title, value }) {
  const [viewMode, setViewMode] = useState("table");
  const normalized = useMemo(() => normalizePayloadValue(value), [value]);
  const jsonText = useMemo(() => {
    const text = typeof normalized === "string" ? normalized : safeJson(normalized);
    return truncateText(text, MAX_JSON_PREVIEW_CHARS);
  }, [normalized]);

  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <div className="text-[10px] font-medium uppercase tracking-wider text-slate-600">{title}</div>
        <div className="ml-auto flex items-center rounded border border-white/10 bg-black/20 p-0.5">
          <button
            onClick={() => setViewMode("table")}
            className={cn(
              "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
              viewMode === "table"
                ? "bg-signal/20 text-signal"
                : "text-slate-500 hover:text-slate-300"
            )}
          >
            Table
          </button>
          <button
            onClick={() => setViewMode("json")}
            className={cn(
              "rounded px-2 py-0.5 text-[10px] font-medium transition-colors",
              viewMode === "json"
                ? "bg-signal/20 text-signal"
                : "text-slate-500 hover:text-slate-300"
            )}
          >
            JSON
          </button>
        </div>
      </div>

      {viewMode === "table" ? (
        <ToolPayloadTable value={normalized} />
      ) : (
        <pre dir="auto" className="max-h-[420px] overflow-auto rounded border border-white/10 bg-black/20 p-2 text-xs text-slate-200 whitespace-pre-wrap break-words">
          {jsonText}
        </pre>
      )}
    </div>
  );
}

/* ─── agent selector ────────────────────────────────────────────────────── */

function AgentSelector({ value, onChange, counts = {} }) {
  return (
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
      {AGENTS.map((a) => {
        const active = value === a.value;
        return (
          <button
            key={a.value}
            onClick={() => onChange(a.value)}
            className={cn(
              "relative flex flex-col items-start rounded-[14px] border p-[14px] text-left transition-colors",
              active
                ? "border-[color-mix(in_oklch,var(--signal)_55%,transparent)] bg-[color-mix(in_oklch,var(--signal)_9%,transparent)]"
                : "border-[var(--line)] bg-[var(--card)] hover:border-[var(--line-hi)] hover:bg-[var(--card-hi)]"
            )}
          >
            <div
              className={cn(
                "mb-3 flex h-11 w-11 items-center justify-center rounded-xl text-[var(--signal)]",
                active && "relative"
              )}
              style={{ background: "color-mix(in oklch, var(--signal) 14%, transparent)" }}
            >
              {active && (
                <span
                  className="absolute inset-[-4px] rounded-[16px] border animate-pulse-ring"
                  style={{ borderColor: "color-mix(in oklch, var(--signal) 50%, transparent)" }}
                />
              )}
              <Bot className="h-5 w-5" />
            </div>
            <div className="text-[14px] font-medium text-[var(--ink)]">{a.label}</div>
            <div className="mt-0.5 text-[12px] text-[var(--mute)]">{a.description}</div>
            <div className="mt-3 flex w-full items-center gap-1.5 border-t border-[var(--line)] pt-2.5 font-mono text-[10.5px] text-[var(--mute-2)]">
              <span>{counts[a.value] || 0} tools</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ─── metrics pill ──────────────────────────────────────────────────────── */

function Pill({ icon: Icon, label, value, danger }) {
  return (
    <div
      className={cn("flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]")}
      style={danger
        ? { borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)", background: "color-mix(in oklch, var(--rose) 10%, transparent)", color: "var(--rose)" }
        : { borderColor: "var(--line)", background: "var(--card)", color: "var(--mute)" }
      }
    >
      {Icon && <Icon className="h-3 w-3 shrink-0" style={{ color: "var(--mute-2)" }} />}
      <span style={{ color: danger ? undefined : "var(--mute-2)" }}>{label}</span>
      <span className="ml-0.5 font-mono font-semibold" style={{ color: danger ? undefined : "var(--ink-dim)" }}>{value}</span>
    </div>
  );
}

/* ─── reasoning feed blocks ─────────────────────────────────────────────── */

function collectTextSegments(value, out, seen = new WeakSet()) {
  if (out.length >= MAX_TEXT_SEGMENTS) return;
  if (value == null) return;

  if (typeof value === "string") {
    const decoded = decodeUriStringSafe(value);
    if (decoded.trim()) out.push(decoded);
    return;
  }

  if (typeof value !== "object") {
    out.push(String(value));
    return;
  }

  if (seen.has(value)) return;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (out.length >= MAX_TEXT_SEGMENTS) break;
      collectTextSegments(item, out, seen);
    }
    return;
  }

  if (typeof value.text === "string" && value.text.trim()) {
    out.push(value.text);
  }

  if (typeof value.content === "string" && value.content.trim()) {
    out.push(value.content);
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === "signature") continue;
    if (out.length >= MAX_TEXT_SEGMENTS) break;
    collectTextSegments(nested, out, seen);
  }
}

function ThinkingBlock({ event }) {
  const rawPreview = event.details?.content_full ?? event.details?.content ?? event.details?.content_preview ?? event.message;
  const preview = useMemo(() => {
    const textParts = [];
    collectTextSegments(rawPreview, textParts);
    if (textParts.length) return truncateText(textParts.join("\n\n"));
    if (rawPreview && typeof rawPreview === "object") return truncateText(safeJson(rawPreview), MAX_JSON_PREVIEW_CHARS);
    if (typeof rawPreview === "string") return truncateText(rawPreview);
    return truncateText(String(rawPreview || ""));
  }, [rawPreview]);
  const toolCount = event.details?.tool_calls || 0;
  const tokens = (event.details?.input_tokens || 0) + (event.details?.output_tokens || 0);
  const actor = event.actor ? event.actor.replace(/_/g, " ") : "agent";

  return (
    <div
      className="rounded-[10px] border p-3"
      style={{
        borderColor: "color-mix(in oklch, var(--violet) 28%, transparent)",
        background: "color-mix(in oklch, var(--violet) 9%, transparent)",
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <Brain className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--violet)" }} />
        <span className="text-[10.5px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--violet)" }}>
          {actor}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {toolCount > 0 && (
            <span
              className="rounded px-1.5 py-0.5 text-[11px]"
              style={{ background: "color-mix(in oklch, var(--violet) 20%, transparent)", color: "var(--violet)" }}
            >
              {toolCount} tool{toolCount !== 1 ? "s" : ""}
            </span>
          )}
          <span className="font-mono text-[11px]" style={{ color: "var(--mute-2)" }}>{formatNumber(tokens)} tok</span>
        </div>
      </div>
      {preview ? (
        <p dir="auto" className="text-[13.5px] leading-relaxed whitespace-pre-wrap" style={{ color: "var(--ink-dim)" }}>{preview}</p>
      ) : (
        <p className="text-[11px] italic" style={{ color: "var(--mute-3)" }}>No content preview available</p>
      )}
    </div>
  );
}

function isScreenshotValue(v) {
  return typeof v === "string" && v.trim().length > 0 && (v.startsWith("http") || v.startsWith("data:image/"));
}

function collectScreenshotUrls(value, out) {
  if (value == null) return;

  if (typeof value === "string") {
    try {
      collectScreenshotUrls(JSON.parse(value), out);
      return;
    } catch { /* fall through */ }

    try {
      const unescaped = value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      collectScreenshotUrls(JSON.parse(unescaped), out);
      return;
    } catch { /* fall through */ }

    const pattern = /(?:\\?"screenshot_url\\?"\s*:\s*\\?")(https?:\/\/[^"\\]+|data:image\/[^"\\]+)(?:\\?")/g;
    for (const match of value.matchAll(pattern)) {
      const url = String(match[1] || "").trim();
      if (isScreenshotValue(url)) out.add(url);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectScreenshotUrls(item, out);
    return;
  }

  if (typeof value === "object") {
    const screenshotUrl = value.screenshot_url;
    if (isScreenshotValue(screenshotUrl)) out.add(screenshotUrl.trim());
    const screenshotUrls = value.screenshot_urls;
    if (Array.isArray(screenshotUrls)) {
      for (const item of screenshotUrls) {
        if (isScreenshotValue(item)) out.add(item.trim());
      }
    }
    for (const nested of Object.values(value)) {
      collectScreenshotUrls(nested, out);
    }
  }
}

function ToolBlock({ event }) {
  const [expanded, setExpanded] = useState(false);
  const [loadedScreenshot, setLoadedScreenshot] = useState("");
  const toolName = event.details?.tool_name || "tool";
  const args = event.details?.tool_args ?? event.details?.args;
  const resultPreview = event.details?.result_full ?? event.details?.result_preview;
  const isStart = event.kind === "tool_call_started";
  const isError = event.status === "error";
  const hasPayload = Boolean(args || resultPreview);

  const screenshotUrls = useMemo(() => {
    const urls = new Set();
    collectScreenshotUrls(resultPreview, urls);
    return Array.from(urls).slice(0, 3);
  }, [resultPreview]);

  const color = isError ? "text-ember" : isStart ? "text-spark" : "text-surge";
  const border = isError ? "border-ember/20 bg-ember/5" : isStart ? "border-spark/20 bg-spark/5" : "border-surge/20 bg-surge/5";
  const verb = isStart ? "calling" : isError ? "failed" : "returned";
  const primaryScreenshot = screenshotUrls[0] || "";
  const isCloudinaryUrl = primaryScreenshot.startsWith("http");

  useEffect(() => {
    if (!primaryScreenshot) return;
    setLoadedScreenshot((current) => current || primaryScreenshot);
  }, [primaryScreenshot]);

  return (
    <div className={cn("rounded-lg border p-2.5", border)}>
      {/* ── header row ── */}
      <div className="flex w-full items-center gap-2">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Terminal className={cn("h-3.5 w-3.5 shrink-0", color)} />
          <span className={cn("text-xs font-semibold uppercase tracking-wide", color)}>{verb}</span>
          <span className="ml-1 rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs text-slate-200 truncate">
            {toolName}
          </span>
          {hasPayload && (
            <ChevronDown className={cn("ml-auto h-3 w-3 shrink-0 text-slate-600 transition-transform", expanded && "rotate-180")} />
          )}
        </button>

        {/* screenshot quick-access buttons — always visible when a screenshot exists */}
        {primaryScreenshot && (
          <div className="flex shrink-0 items-center gap-1 ml-2">
            <button
              onClick={() => setLoadedScreenshot(loadedScreenshot === primaryScreenshot ? "" : primaryScreenshot)}
              title={loadedScreenshot === primaryScreenshot ? "Hide screenshot" : "Show screenshot"}
              className={cn(
                "flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors",
                loadedScreenshot === primaryScreenshot
                  ? "border-surge/50 bg-surge/20 text-surge"
                  : "border-surge/30 bg-surge/10 text-surge hover:bg-surge/20"
              )}
            >
              <Camera className="h-3 w-3" />
            </button>
            {isCloudinaryUrl && (
              <a
                href={primaryScreenshot}
                target="_blank"
                rel="noreferrer"
                title="Open screenshot in new tab"
                className="flex items-center gap-1 rounded border border-white/15 bg-white/[0.04] px-1.5 py-0.5 text-[11px] font-medium text-slate-300 hover:bg-white/[0.08] transition-colors"
              >
                <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        )}
      </div>

      {/* ── inline 16:9 screenshot preview ── */}
      {loadedScreenshot && (
        <div className="mt-2 overflow-hidden rounded border border-white/10 bg-black/30">
          <div className="relative w-full" style={{ aspectRatio: "16/9" }}>
            <img
              src={loadedScreenshot}
              alt="Tool screenshot"
              className="absolute inset-0 h-full w-full rounded object-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          </div>
          {/* URL bar below if it's a real hosted URL */}
          {isScreenshotValue(loadedScreenshot) && loadedScreenshot.startsWith("http") && (
            <div className="flex items-center gap-2 border-t border-white/6 px-2 py-1">
              <span className="flex-1 truncate font-mono text-[10px] text-slate-500">{loadedScreenshot}</span>
              <a
                href={loadedScreenshot}
                target="_blank"
                rel="noreferrer"
                className="flex shrink-0 items-center gap-1 text-[10px] text-slate-400 hover:text-white transition-colors"
              >
                <ExternalLink className="h-3 w-3" />open
              </a>
            </div>
          )}
        </div>
      )}

      {/* ── expanded details ── */}
      {expanded && hasPayload && (
        <div className="mt-2 space-y-1.5">
          {args && (
            <PayloadView title="Input JSON" value={args} />
          )}
          {resultPreview && (
            <PayloadView title="Output JSON" value={resultPreview} />
          )}
          {screenshotUrls.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              {screenshotUrls.slice(1).map((url, idx) => (
                <button
                  key={`${url}-${idx}`}
                  onClick={() => setLoadedScreenshot(loadedScreenshot === url ? "" : url)}
                  className="rounded border border-surge/30 bg-surge/10 px-2 py-1 text-[11px] font-medium text-surge hover:bg-surge/20"
                >
                  {loadedScreenshot === url ? `Hide #${idx + 2}` : `Screenshot ${idx + 2}`}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusChip({ event }) {
  const meta = EVENT_META[event.kind] || { color: "text-slate-500", label: event.kind };
  const isError = event.status === "error";
  const message = typeof event.message === "string" ? event.message : safeJson(event.message);
  return (
    <div className={cn(
      "flex items-center gap-2 rounded-md border border-white/6 px-2.5 py-1.5 text-xs",
      isError && "border-ember/30 bg-ember/5"
    )}>
      <span className={cn("font-semibold", isError ? "text-ember" : meta.color)}>{meta.label}</span>
      {message && (
        <span className="whitespace-pre-wrap break-words text-slate-500">{message}</span>
      )}
    </div>
  );
}

function ReasoningFeed({ events }) {
  const bottomRef = useRef(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const relevant = useMemo(
    () => events.filter((e) =>
      e.kind === "tool_session_connecting" ||
      e.kind === "tool_session_ready" ||
      e.kind === "tool_session_closed" ||
      e.kind === "tool_session_failed" ||
      e.kind === "llm_turn_started" ||
      e.kind === "llm_response" ||
      e.kind === "llm_timeout" ||
      e.kind === "llm_rate_limited" ||
      e.kind === "llm_error" ||
      e.kind === "tool_call_started" ||
      e.kind === "tool_call_finished" ||
      e.kind === "agent_started" ||
      e.kind === "agent_finished" ||
      e.kind === "agent_failed" ||
      e.kind === "pipeline_started" ||
      e.kind === "pipeline_failed" ||
      e.kind === "run_cancelled" ||
      e.status === "error"
    ),
    [events]
  );

  if (!relevant.length) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-slate-700">
        Agent reasoning will appear here live
      </div>
    );
  }

  return (
    <>
      {relevant.map((ev, i) => {
        if (ev.kind === "llm_response") return <ThinkingBlock key={`r-${ev.seq}-${i}`} event={ev} />;
        if (ev.kind === "tool_call_started" || ev.kind === "tool_call_finished") return <ToolBlock key={`r-${ev.seq}-${i}`} event={ev} />;
        return <StatusChip key={`r-${ev.seq}-${i}`} event={ev} />;
      })}
      <div ref={bottomRef} />
    </>
  );
}

/* ─── full event log ─────────────────────────────────────────────────────── */

function EventRow({ event }) {
  const [expanded, setExpanded] = useState(false);
  const meta = EVENT_META[event.kind] || { color: "text-slate-400", label: event.kind };
  const hasDetails = event.details && Object.keys(event.details).length > 0;
  const isError = event.status === "error";
  const message = typeof event.message === "string" ? event.message : safeJson(event.message);

  return (
    <div className={cn(
      "rounded-md border text-xs transition-colors",
      isError ? "border-ember/30 bg-ember/5" : "border-white/6 hover:bg-white/[0.04]"
    )} id={`event-${event.seq}`}>
      <button
        onClick={() => hasDetails && setExpanded((v) => !v)}
        disabled={!hasDetails}
        className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left"
      >
        <div className={cn("h-1.5 w-1.5 shrink-0 rounded-full",
          isError ? "bg-ember" :
          event.kind === "llm_response" ? "bg-violet-400" :
          event.kind?.includes("tool") ? "bg-spark" :
          event.kind?.includes("finished") ? "bg-surge" :
          event.kind?.includes("failed") ? "bg-ember" :
          "bg-signal"
        )} />
        <span className={cn("shrink-0 font-medium", isError ? "text-ember" : meta.color)}>
          {meta.label}
        </span>
        <span className="flex-1 whitespace-pre-wrap break-words text-slate-600">{message}</span>
        <span className="shrink-0 font-mono text-slate-700">#{event.seq}</span>
        {hasDetails && (
          <ChevronRight className={cn("h-3 w-3 shrink-0 text-slate-700 transition-transform", expanded && "rotate-90")} />
        )}
      </button>
      {expanded && hasDetails && (
        <div className="border-t border-white/6 px-2.5 pb-2 pt-1.5">
          <pre className="overflow-auto rounded bg-black/40 p-2 text-xs text-slate-300 whitespace-pre-wrap break-words">
            {safeJson(event.details)}
          </pre>
        </div>
      )}
    </div>
  );
}

function EventLog({ events }) {
  const bottomRef = useRef(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  if (!events.length) {
    return (
      <div className="flex h-20 items-center justify-center text-xs text-slate-700">
        No events yet
      </div>
    );
  }

  return (
    <>
      {events.map((ev, i) => <EventRow key={`e-${ev.seq}-${i}`} event={ev} />)}
      <div ref={bottomRef} />
    </>
  );
}

/* ─── main ───────────────────────────────────────────────────────────────── */

export function RunStudio({ mode = "workflow" }) {
  const [url, setUrl]               = useState("");
  const [agent, setAgent]           = useState("classification");
  const [runId, setRunId]           = useState("");
  const [events, setEvents]         = useState([]);
  const [metrics, setMetrics]       = useState(null);
  const [tracePayload, setTrace]    = useState(null);
  const [streamError, setStreamError] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning]   = useState(false);
  const [latestScreenshot, setLatestScreenshot] = useState("");
  const [latestScreenshotAt, setLatestScreenshotAt] = useState("");
  const [screenshotFlash, setScreenshotFlash] = useState(false);
  const [promptPreview, setPromptPreview] = useState("");
  const [showPromptPreview, setShowPromptPreview] = useState(false);

  useEffect(() => {
    if (!runId) return;
    setIsRunning(true);
    setStreamError("");

    let source = null;
    let reconnectTimer = null;
    let retryCount = 0;
    let lastEventId = null;
    let done = false;
    const MAX_RETRIES = 6;
    const BASE_DELAY_MS = 1000;

    function connect() {
      if (done) return;
      const url = lastEventId
        ? apiUrl(`/ui/runs/${runId}/stream?last_event_id=${encodeURIComponent(lastEventId)}`)
        : apiUrl(`/ui/runs/${runId}/stream`);
      source = new EventSource(url);

      source.onmessage = (e) => {
        retryCount = 0;
        if (e.lastEventId) lastEventId = e.lastEventId;
        try {
          const payload = JSON.parse(e.data || "{}");
          if (!payload || typeof payload !== "object") return;

          setStreamError("");
          setTrace(payload);

          const incomingEvents = Array.isArray(payload.events)
            ? payload.events.filter((item) => item && typeof item === "object")
            : [];
          if (incomingEvents.length) {
            setEvents((cur) => mergeEvents(cur, incomingEvents));
          }

          if (payload.metrics && typeof payload.metrics === "object") {
            setMetrics(payload.metrics);
          }

          if (payload.error) {
            setStreamError((prev) => prev || `Stream error: ${payload.error}`);
          }

          if (payload.completed) {
            done = true;
            source.close();
            setIsRunning(false);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err || "Unknown stream parse error");
          setStreamError(`Stream payload parse failed: ${message}`);
        }
      };

      source.onerror = () => {
        source.close();
        if (done) return;
        if (retryCount >= MAX_RETRIES) {
          setIsRunning(false);
          setStreamError("Live stream disconnected. Reload to resume.");
          return;
        }
        const delay = BASE_DELAY_MS * Math.pow(2, retryCount);
        retryCount += 1;
        setStreamError(`Live stream interrupted — reconnecting in ${Math.round(delay / 1000)}s… (attempt ${retryCount}/${MAX_RETRIES})`);
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    connect();
    return () => {
      done = true;
      clearTimeout(reconnectTimer);
      if (source) source.close();
    };
  }, [runId]);

  useEffect(() => {
    if (mode !== "agent") return;
    const promptFile = AGENT_PROMPT_FILES[agent] || `${agent}_v1.md`;
    fetch(apiUrl(`/ui/prompts/${promptFile}`))
      .then((res) => res.ok ? res.json() : { content: "" })
      .then((payload) => setPromptPreview(payload?.content || ""))
      .catch(() => setPromptPreview(""));
  }, [agent, mode]);

  useEffect(() => {
    if (!runId || !isRunning) return;
    const timer = setInterval(async () => {
      try {
        const response = await fetch(apiUrl(`/ui/runs/${runId}/screenshot`), { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json();
        const next = payload?.screenshot_url || "";
        if (!next) return;
        setLatestScreenshot((cur) => {
          if (cur && cur !== next) {
            setScreenshotFlash(true);
            setTimeout(() => setScreenshotFlash(false), 450);
          }
          return next;
        });
        setLatestScreenshotAt(payload?.timestamp || "");
      } catch {
        // ignore transient polling errors
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [runId, isRunning]);

  const eventCounters = useMemo(() => {
    const counters = {
      toolCalls: 0,
      llmCalls: 0,
      errorCount: 0,
      agentToolCounts: AGENTS.reduce((acc, item) => {
        acc[item.value] = 0;
        return acc;
      }, {}),
    };

    for (const event of events) {
      if (!event || typeof event !== "object") continue;
      if (event.kind === "tool_call_started") {
        counters.toolCalls += 1;
        if (event.actor && Object.prototype.hasOwnProperty.call(counters.agentToolCounts, event.actor)) {
          counters.agentToolCounts[event.actor] += 1;
        }
      }
      if (event.kind === "llm_response") counters.llmCalls += 1;
      if (event.status === "error") counters.errorCount += 1;
    }

    return counters;
  }, [events]);

  const toolCalls = eventCounters.toolCalls;
  const llmCalls = eventCounters.llmCalls;
  const errorCount = eventCounters.errorCount;
  const agentToolCounts = eventCounters.agentToolCounts;

  const totalTokens = (metrics?.total_tokens_in || 0) + (metrics?.total_tokens_out || 0);
  const cachedInputTokens = metrics?.total_cached_input_tokens || 0;
  const newInputTokens = metrics?.total_new_input_tokens || 0;
  const cacheHitCalls = metrics?.total_cache_hit_calls || 0;
  const cacheHitRate = llmCalls > 0 ? (cacheHitCalls / llmCalls) * 100 : 0;
  const duration    = metrics?.total_duration_seconds;
  const completed   = tracePayload?.completed;
  const succeeded   = completed && metrics?.success;
  const failed      = completed && !metrics?.success;

  const screenshotStrip = useMemo(() => {
    const rows = [];
    const seen = new Set();
    for (const event of events) {
      const resultPreview = event?.details?.result_full ?? event?.details?.result_preview;
      const urls = new Set();
      collectScreenshotUrls(resultPreview, urls);
      for (const urlItem of Array.from(urls)) {
        if (seen.has(urlItem)) continue;
        seen.add(urlItem);
        rows.push({ url: urlItem, seq: event.seq });
      }
    }
    return rows;
  }, [events]);

  function jumpToEvent(seq) {
    if (!seq) return;
    document.getElementById(`event-${seq}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function startRun() {
    setIsStarting(true);
    setEvents([]);
    setMetrics(null);
    setTrace(null);
    setStreamError("");
    setLatestScreenshot("");
    setLatestScreenshotAt("");
    setScreenshotFlash(false);
    setRunId("");
    try {
      const endpoint = mode === "workflow" ? "/ui/workflows/run" : "/ui/agents/test";
      const body = mode === "workflow" ? { url } : { url, agent };
      const res = await fetch(apiUrl(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok) {
        throw new Error(payload?.detail || `Run start failed (status ${res.status})`);
      }
      setRunId(payload.run_id || "");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || "Run start failed");
      setStreamError(message);
    } finally {
      setIsStarting(false);
    }
  }

  async function cancelRun() {
    if (!runId) return;
    await fetch(apiUrl(`/ui/runs/${runId}/cancel`), { method: "POST" });
  }

  return (
    <div className="space-y-5">

      {/* ── page header ───────────────────────────────────────────────────── */}
      <div>
        <span className="owc-eyebrow">
          {mode === "workflow" ? "workflow studio · streaming" : "agent lab · single-agent test"}
        </span>
        <h1 className="mt-2 text-3xl font-semibold text-[var(--ink)]">
          {mode === "workflow" ? "Live pipeline" : "Isolate, instrument, iterate"}
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          {mode === "workflow"
            ? "Classify → Landing → Hosting → Email. Every tool call, LLM turn, and token arrives in real time over SSE."
            : "Run any one agent against a URL to inspect its tools, tokens, and reasoning without the rest of the pipeline firing."}
        </p>
      </div>

      {/* ── control card ──────────────────────────────────────────────────── */}
      <div className="rounded-[14px] border border-[var(--line)] p-4 space-y-3" style={{ background: "var(--card)", boxShadow: "var(--shadow-card)" }}>
        {mode === "agent" && (
          <div className="space-y-2">
            <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
              Agent
            </label>
            <AgentSelector value={agent} onChange={setAgent} counts={agentToolCounts} />
            <div className="rounded-lg border border-[var(--line)] bg-black/20">
              <button
                type="button"
                onClick={() => setShowPromptPreview((v) => !v)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11.5px] text-[var(--mute)] hover:text-[var(--ink-dim)]"
              >
                {showPromptPreview ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeftOpen className="h-3.5 w-3.5" />}
                Prompt preview ({agent})
              </button>
              {showPromptPreview && (
                <pre className="max-h-56 overflow-auto border-t border-white/10 px-3 py-2 text-[11px] text-slate-300 whitespace-pre-wrap">
                  {promptPreview || "No prompt preview available"}
                </pre>
              )}
            </div>
          </div>
        )}

        <div>
          <label className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
            Target URL
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && url && !isStarting && !isRunning && startRun()}
              placeholder="https://streaming-site.example.com/watch/123"
              className="flex-1 rounded-lg border border-[var(--line)] bg-black/25 px-3 py-2 text-[13px] text-[var(--ink)] placeholder:text-[var(--mute-3)] focus:outline-none"
              style={{ transition: "border-color .15s" }}
            />
            <Button
              variant="accent"
              onClick={startRun}
              disabled={!url || isStarting || isRunning}
              className="shrink-0"
            >
              {isStarting
                ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Starting</>
                : <><Play className="mr-1.5 h-3.5 w-3.5" />{mode === "workflow" ? "Run pipeline" : "Run agent"}</>}
            </Button>
            {isRunning && (
              <Button variant="ghost" onClick={cancelRun} className="shrink-0 border border-white/10">
                <Square className="mr-1.5 h-3.5 w-3.5" />Cancel
              </Button>
            )}
          </div>
        </div>

        {/* status bar */}
        {runId && (
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--line)] pt-3">
            <span className="font-mono text-[11px] text-[var(--mute-3)]">{runId.slice(0, 12)}…</span>
            {isRunning && (
              <span className="flex items-center gap-1 font-mono text-[11px] text-[var(--signal)]">
                <Loader2 className="h-3 w-3 animate-spin" />streaming
              </span>
            )}
            {succeeded && (
              <span className="flex items-center gap-1 font-mono text-[11px] text-[var(--mint)]">
                <CheckCircle2 className="h-3 w-3" />completed
              </span>
            )}
            {failed && (
              <span className="flex items-center gap-1 font-mono text-[11px] text-[var(--rose)]">
                <AlertCircle className="h-3 w-3" />
                {tracePayload?.cancel_requested ? "cancelled" : `failed · ${metrics?.failure_mode || "unknown"}`}
              </span>
            )}
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Pill icon={Wrench}     label="tools"  value={toolCalls} />
              <Pill icon={Cpu}        label="llm"    value={llmCalls} />
              <Pill icon={CircleDot}  label="cache"  value={`${cacheHitCalls}/${llmCalls || 0}`} />
              <Pill icon={CircleDot}  label="hit %"  value={`${cacheHitRate.toFixed(0)}%`} />
              <Pill icon={CircleDot}  label="cached tok" value={formatNumber(cachedInputTokens)} />
              <Pill icon={CircleDot}  label="new tok" value={formatNumber(newInputTokens)} />
              <Pill icon={Zap}        label="tokens" value={formatNumber(totalTokens)} />
              <Pill icon={DollarSign} label="cost"   value={formatCurrency(metrics?.total_cost_usd ?? metrics?.estimated_total_cost_usd ?? 0)} />
              {duration != null && <Pill icon={Clock} label="time" value={`${duration.toFixed(1)}s`} />}
              {errorCount > 0 && <Pill icon={AlertCircle} label="errors" value={errorCount} danger />}
            </div>
          </div>
        )}

        {streamError && (
          <div className="rounded-lg border border-[var(--rose)]/30 bg-[var(--rose)]/10 px-3 py-2 text-[12.5px] text-[var(--rose)]">
            {streamError}
          </div>
        )}
      </div>

      {/* ── live panels ───────────────────────────────────────────────────── */}
      {(events.length > 0 || runId) && (
        <div className="space-y-4">
          <WorkflowCanvas events={events} rootActor={tracePayload?.root_actor || (mode === "agent" ? agent : "orchestrator")} />
          <div className={cn("grid gap-4", mode === "agent" ? "xl:grid-cols-[1fr_340px]" : "xl:grid-cols-[1fr_300px]")}>

            {/* reasoning panel */}
            <div className="space-y-4">
              <div className="overflow-hidden rounded-[14px] border border-[var(--line)]" style={{ background: "var(--card)", boxShadow: "var(--shadow-card)" }}>
                <div className="flex items-center gap-2 border-b border-[var(--line)] px-[18px] py-3.5">
                  <Brain className="h-3.5 w-3.5 shrink-0 text-[var(--violet)]" />
                  <span className="text-[13.5px] font-medium text-[var(--ink)]">Agent reasoning</span>
                  <span className="text-[12px] text-[var(--mute)]">LLM thoughts + tool activity</span>
                  {isRunning && <Loader2 className="h-3 w-3 animate-spin text-[var(--mute-2)]" />}
                  <span className="owc-pill live ml-auto"><span className="dot" />{isRunning ? "live" : `${llmCalls} turns`}</span>
                </div>
                <div className="max-h-[560px] overflow-y-auto space-y-2 p-4">
                  <ReasoningFeed events={events} />
                </div>
              </div>
              <TimelinePanel events={events} onSelectEvent={jumpToEvent} />
            </div>

            {/* right panel */}
            <div className="space-y-4">
              {mode === "agent" && (
                <div className={cn("overflow-hidden rounded-[14px] border border-[var(--line)]", screenshotFlash && "ring-2 ring-[var(--signal)]/50")} style={{ background: "var(--card)", boxShadow: "var(--shadow-card)" }}>
                  <div className="flex items-center gap-2 border-b border-[var(--line)] px-[18px] py-3.5">
                    <span className="text-[13.5px] font-medium text-[var(--ink)]">Live Screenshot</span>
                    <span className="ml-auto font-mono text-[11px] text-[var(--mute-2)]">
                      {latestScreenshotAt ? new Date(latestScreenshotAt).toLocaleTimeString() : "waiting"}
                    </span>
                  </div>
                  {latestScreenshot ? (
                    <button
                      type="button"
                      className="block w-full bg-black/20"
                      onClick={() => window.open(latestScreenshot, "_blank", "noopener,noreferrer")}
                    >
                      <img src={latestScreenshot} alt="Live agent screenshot" className="h-44 w-full object-cover" />
                    </button>
                  ) : (
                    <div className="px-3 py-10 text-center font-mono text-[11px] text-[var(--mute-3)]">No screenshot yet</div>
                  )}
                  {screenshotStrip.length > 0 && (
                    <div className="flex gap-2 overflow-x-auto border-t border-[var(--line)] p-2">
                      {screenshotStrip.map((shot) => (
                        <button
                          key={`${shot.url}-${shot.seq}`}
                          type="button"
                          onClick={() => {
                            setLatestScreenshot(shot.url);
                            jumpToEvent(shot.seq);
                          }}
                          className="shrink-0 overflow-hidden rounded border border-[var(--line)]"
                          title={`Jump to event #${shot.seq}`}
                        >
                          <img src={shot.url} alt={`Screenshot ${shot.seq}`} className="h-14 w-20 object-cover" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="overflow-hidden rounded-[14px] border border-[var(--line)]" style={{ background: "var(--card)", boxShadow: "var(--shadow-card)" }}>
                <div className="flex items-center gap-2 border-b border-[var(--line)] px-[18px] py-3.5">
                  <span className="text-[13.5px] font-medium text-[var(--ink)]">Event log</span>
                  <span className="ml-auto font-mono text-[11px] text-[var(--mute)]">{events.length} events</span>
                </div>
                <div className="max-h-[560px] overflow-y-auto space-y-1 p-2">
                  <EventLog events={events} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
