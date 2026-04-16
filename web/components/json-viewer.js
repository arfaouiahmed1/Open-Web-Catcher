"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy } from "lucide-react";

import { safeJson } from "@/lib/utils";

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
        // try next strategy
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

function valueTone(value) {
  if (value === null) return "text-slate-500";
  if (typeof value === "string") return "text-emerald-300";
  if (typeof value === "number" || typeof value === "bigint") return "text-amber-300";
  if (typeof value === "boolean") return value ? "text-sky-300" : "text-blue-300";
  return "text-slate-300";
}

function renderPrimitive(value) {
  if (value === null) return "null";
  if (typeof value === "string") return `"${value}"`;
  return String(value);
}

function nodeSummary(value) {
  if (Array.isArray(value)) return `[ ${value.length} items ]`;
  if (value && typeof value === "object") return `{ ${Object.keys(value).length} keys }`;
  return renderPrimitive(value);
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof value === "string" ? value : safeJson(value));
      setCopied(true);
      setTimeout(() => setCopied(false), 900);
    } catch {
      // ignore clipboard failures
    }
  }

  return (
    <button
      onClick={copy}
      className="inline-flex items-center gap-1 rounded border border-white/10 bg-black/20 px-1.5 py-0.5 text-[10px] text-slate-500 hover:text-slate-200"
      title="Copy value"
      type="button"
    >
      <Copy className="h-2.5 w-2.5" />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function JsonNode({ name, value, depth = 0, defaultExpandedDepth = 2 }) {
  const isExpandable = value && typeof value === "object";
  const [expanded, setExpanded] = useState(depth < defaultExpandedDepth);

  if (!isExpandable) {
    return (
      <div className="py-0.5">
        {name ? <span className="text-slate-500">{name}: </span> : null}
        <span className={valueTone(value)}>{renderPrimitive(value)}</span>
        <span className="ml-1.5 inline-flex align-middle"><CopyButton value={value} /></span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item, idx) => [String(idx), item]) : Object.entries(value);

  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 text-slate-400 hover:text-white"
          type="button"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {name ? <span className="text-slate-500">{name}:</span> : null}
          <span className="text-slate-300">{isArray ? "[" : "{"}</span>
          {!expanded && <span className="text-xs text-slate-600">{nodeSummary(value)}</span>}
          <span className="text-slate-300">{isArray ? "]" : "}"}</span>
        </button>
        <CopyButton value={value} />
      </div>
      {expanded && (
        <div className="ml-5 border-l border-white/6 pl-3">
          {entries.length ? (
            entries.map(([key, nested]) => (
              <JsonNode
                key={`${depth}-${key}`}
                name={isArray ? `[${key}]` : key}
                value={nested}
                depth={depth + 1}
                defaultExpandedDepth={defaultExpandedDepth}
              />
            ))
          ) : (
            <div className="py-0.5 text-slate-600">{isArray ? "[]" : "{}"}</div>
          )}
        </div>
      )}
    </div>
  );
}

export function JsonViewer({ value, label }) {
  const normalized = useMemo(() => decodeUriDeep(value), [value]);
  const isEmpty = !normalized || (typeof normalized === "object" && Object.keys(normalized).length === 0);
  return (
    <div className="rounded-xl border border-white/8 bg-black/30 overflow-hidden shadow-card">
      {label && (
        <div className="px-4 py-2.5 border-b border-white/6 text-xs font-medium text-slate-500 uppercase tracking-wider">
          {label}
        </div>
      )}
      {isEmpty ? (
        <div className="px-4 py-6 text-xs text-slate-700 text-center">Empty</div>
      ) : (
        <div className="p-4 text-xs font-mono text-slate-300 overflow-auto max-h-[70vh] leading-relaxed">
          <JsonNode name="$" value={normalized} />
        </div>
      )}
    </div>
  );
}
