"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea, ScrollAreaViewport, ScrollBar } from "@/components/ui/scroll-area";
import { safeJson } from "@/lib/utils";

const COPY_FEEDBACK_DURATION_MS = 900;
const LONG_VALUE_LIMIT = 260;

function isPrimitive(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function decodeUriStringSafe(value) {
  const text = String(value ?? "");
  if (!text || text.startsWith("data:")) return text;
  if (!/%[0-9a-fA-F]{2}/.test(text) && !text.includes("+")) return text;

  const candidates = text.includes("+") ? [text.replace(/\+/g, "%20"), text] : [text];
  for (const candidate of candidates) {
    for (const decoder of [decodeURIComponent, decodeURI]) {
      try {
        const decoded = decoder(candidate);
        if (decoded) return decoded;
      } catch {
        // Ignore decode failures.
      }
    }
  }
  return text;
}

function parseJsonLike(value) {
  if (typeof value !== "string") return value;
  const decoded = decodeUriStringSafe(value);
  const trimmed = decoded.trim();
  if (!trimmed) return decoded;
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return decoded;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return decoded;
  }
}

function normalizeStructuredValue(value, seen = new WeakSet()) {
  const parsed = parseJsonLike(value);
  if (typeof parsed === "string") return parsed;
  if (parsed == null || typeof parsed !== "object") return parsed;
  if (seen.has(parsed)) return parsed;

  seen.add(parsed);

  if (Array.isArray(parsed)) {
    return parsed.map((entry) => normalizeStructuredValue(entry, seen));
  }

  const normalized = {};
  for (const [key, nested] of Object.entries(parsed)) {
    normalized[key] = normalizeStructuredValue(nested, seen);
  }
  return normalized;
}

function primitiveLabel(value) {
  if (value == null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value || '""';
  return String(value);
}

function compactLabel(value, max = LONG_VALUE_LIMIT) {
  const text = primitiveLabel(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trim()}...`;
}

function typeLabel(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function summarizeValue(value) {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value && typeof value === "object") return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
  return primitiveLabel(value);
}

function isFilteredEmpty(value) {
  if (value === undefined) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (value && typeof value === "object") return Object.keys(value).length === 0;
  return false;
}

function valueTone(value) {
  if (value === null) return "text-muted-foreground";
  if (typeof value === "string") return "text-emerald-300";
  if (typeof value === "number" || typeof value === "bigint") return "text-amber-300";
  if (typeof value === "boolean") return value ? "text-sky-300" : "text-blue-300";
  return "text-foreground/80";
}

function nodeSummary(value) {
  if (Array.isArray(value)) return `[ ${value.length} items ]`;
  if (value && typeof value === "object") return `{ ${Object.keys(value).length} keys }`;
  return primitiveLabel(value);
}

function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof value === "string" ? value : safeJson(value));
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
    } catch {
      // Ignore clipboard failures.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1 rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
      title="Copy value"
    >
      <Copy className="h-2.5 w-2.5" />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function JsonNode({ name, value, depth = 0, defaultExpandedDepth = 2, limit = 0 }) {
  const isExpandable = value && typeof value === "object";
  const [expanded, setExpanded] = useState(depth < defaultExpandedDepth);

  if (!isExpandable) {
    return (
      <div className="py-0.5">
        {name ? <span className="text-muted-foreground">{name}: </span> : null}
        <span className={valueTone(value)} title={typeof value === "string" ? value : undefined}>
          {typeof value === "string" ? `"${compactLabel(value)}"` : compactLabel(value)}
        </span>
        <span className="ml-1.5 inline-flex align-middle">
          <CopyButton value={value} />
        </span>
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray ? value.map((item, idx) => [String(idx), item]) : Object.entries(value);
  const visibleEntries = limit > 0 ? entries.slice(0, limit) : entries;

  return (
    <div className="py-0.5">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          className="inline-flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {name ? <span className="text-muted-foreground">{name}:</span> : null}
          <span className="text-foreground/80">{isArray ? "[" : "{"}</span>
          {!expanded ? <span className="text-xs text-muted-foreground/70">{nodeSummary(value)}</span> : null}
          <span className="text-foreground/80">{isArray ? "]" : "}"}</span>
        </button>
        <CopyButton value={value} />
      </div>
      {expanded ? (
        <div className="ml-5 border-l border-border pl-3">
          {entries.length ? (
            visibleEntries.map(([key, nested]) => (
              <JsonNode
                key={`${depth}-${key}`}
                name={isArray ? `[${key}]` : key}
                value={nested}
                depth={depth + 1}
                defaultExpandedDepth={defaultExpandedDepth}
                limit={limit}
              />
            ))
          ) : (
            <div className="py-0.5 text-muted-foreground/70">{isArray ? "[]" : "{}"}</div>
          )}
          {limit > 0 && entries.length > visibleEntries.length ? (
            <div className="py-1 text-[11px] text-muted-foreground/70">
              {entries.length - visibleEntries.length} more item{entries.length - visibleEntries.length === 1 ? "" : "s"} hidden by compact limit
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function filterStructuredValue(value, term) {
  if (!term) return value;
  if (isPrimitive(value)) {
    return primitiveLabel(value).toLowerCase().includes(term) ? value : undefined;
  }
  if (Array.isArray(value)) {
    return value
      .map((entry, index) => {
        const direct = [`[${index}]`, summarizeValue(entry)].join(" ").toLowerCase().includes(term);
        if (direct) return entry;
        const filtered = filterStructuredValue(entry, term);
        return isFilteredEmpty(filtered) ? undefined : entry;
      })
      .filter((entry) => entry !== undefined);
  }

  const filteredEntries = Object.entries(value)
    .map(([key, nested]) => {
      const direct = [key, summarizeValue(nested)].join(" ").toLowerCase().includes(term);
      if (direct) return [key, nested];
      const filtered = filterStructuredValue(nested, term);
      return filtered === undefined ? null : [key, filtered];
    })
    .filter(Boolean);
  return Object.fromEntries(filteredEntries);
}

function buildTableRows(value, limit = 0) {
  const cap = Number(limit || 0);
  if (Array.isArray(value)) {
    return value.slice(0, cap > 0 ? cap : value.length).map((entry, index) => ({
      path: `[${index}]`,
      type: typeLabel(entry),
      summary: summarizeValue(entry),
      value: entry,
    }));
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return entries.slice(0, cap > 0 ? cap : entries.length).map(([key, nested]) => ({
      path: key,
      type: typeLabel(nested),
      summary: summarizeValue(nested),
      value: nested,
    }));
  }
  return [
    {
      path: "$",
      type: typeLabel(value),
      summary: summarizeValue(value),
      value,
    },
  ];
}

function TableView({ value, compact = false, limit = 0 }) {
  const rows = useMemo(() => buildTableRows(value, limit), [limit, value]);
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-muted/15">
      <div className="grid grid-cols-[minmax(120px,0.85fr)_88px_minmax(0,1fr)_auto] gap-3 border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/70">
        <div>Path</div>
        <div>Type</div>
        <div>Value</div>
        <div />
      </div>
      <ScrollArea className={compact ? "max-h-[260px]" : "max-h-[460px]"}>
        <div>
          {rows.map((row) => (
            <div
              key={row.path}
              className="grid grid-cols-[minmax(120px,0.85fr)_88px_minmax(0,1fr)_auto] gap-3 border-b border-border/70 px-3 py-2.5 text-[11px] last:border-b-0"
            >
              <div className="min-w-0 break-words font-mono text-foreground/90">{row.path}</div>
              <div className="font-mono text-muted-foreground">{row.type}</div>
              <div className="min-w-0 break-words text-foreground/85">
                {isPrimitive(row.value) ? compactLabel(row.value) : row.summary}
              </div>
              <div className="flex justify-end">
                <CopyButton value={row.value} />
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}

function PrimitiveView({ value }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-3 text-[12px] text-foreground/85">
      {primitiveLabel(value)}
    </div>
  );
}

function ScrollableStructuredPanel({ compact = false, children, contentClassName = "", maxHeight = "" }) {
  return (
    <ScrollArea
      className={compact ? "h-[260px] rounded-lg border border-border bg-muted/20" : "h-[460px] rounded-lg border border-border bg-muted/20"}
      style={maxHeight ? { height: maxHeight } : undefined}
    >
      <ScrollAreaViewport>
        <div className={contentClassName}>{children}</div>
      </ScrollAreaViewport>
      <ScrollBar orientation="vertical" />
      <ScrollBar orientation="horizontal" />
    </ScrollArea>
  );
}

export function StructuredDataCard({
  title,
  label,
  description,
  data,
  emptyLabel = "No structured data available.",
  defaultMode = "table",
  search = false,
  compact = false,
  limit = 0,
  maxHeight = "",
}) {
  const safeDefaultMode = ["table", "tree", "json"].includes(defaultMode) ? defaultMode : "table";
  const normalized = useMemo(() => normalizeStructuredValue(data ?? null), [data]);
  const [mode, setMode] = useState(safeDefaultMode);
  const [query, setQuery] = useState("");

  useEffect(() => {
    setMode(safeDefaultMode);
  }, [safeDefaultMode]);

  const effectiveTitle = title || label || "";
  const isEmpty = useMemo(() => {
    if (normalized == null) return true;
    if (Array.isArray(normalized)) return normalized.length === 0;
    if (typeof normalized === "object") return Object.keys(normalized).length === 0;
    return false;
  }, [normalized]);

  const filteredValue = useMemo(() => {
    const term = query.trim().toLowerCase();
    return filterStructuredValue(normalized, term);
  }, [normalized, query]);

  const filteredEmpty = useMemo(() => {
    if (filteredValue == null) return true;
    if (Array.isArray(filteredValue)) return filteredValue.length === 0;
    if (typeof filteredValue === "object" && !isPrimitive(filteredValue)) {
      return Object.keys(filteredValue).length === 0;
    }
    return false;
  }, [filteredValue]);

  const showModes = !isEmpty && !isPrimitive(normalized);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/60 shadow-sm">
      {(effectiveTitle || description || showModes || search) ? (
        <div className="flex flex-col gap-3 border-b border-border px-4 py-3.5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              {effectiveTitle ? <div className="text-sm font-semibold text-foreground">{effectiveTitle}</div> : null}
              {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
            </div>
            {showModes ? (
              <div className="flex shrink-0 rounded-md border border-border bg-muted/30 p-0.5">
                {["table", "tree", "json"].map((entry) => (
                  <Button
                    key={entry}
                    type="button"
                    variant={mode === entry ? "secondary" : "ghost"}
                    size="sm"
                    className="h-7 px-2 text-[11px] capitalize"
                    onClick={() => setMode(entry)}
                  >
                    {entry}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
          {search && !isEmpty ? (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search payload keys and values"
                className="h-8 pl-9 text-xs"
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="p-4">
        {isEmpty ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            {emptyLabel}
          </div>
        ) : filteredEmpty ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            No payload values match the current search.
          </div>
        ) : isPrimitive(filteredValue) ? (
          <PrimitiveView value={filteredValue} />
        ) : mode === "json" ? (
          <ScrollableStructuredPanel compact={compact} maxHeight={maxHeight} contentClassName="min-w-max p-3">
            <pre className="whitespace-pre font-mono text-[11.5px] leading-relaxed text-foreground/85">
              {safeJson(filteredValue)}
            </pre>
          </ScrollableStructuredPanel>
        ) : mode === "tree" ? (
          <ScrollableStructuredPanel compact={compact} maxHeight={maxHeight} contentClassName="min-w-max p-3 font-mono text-[11.5px] leading-relaxed text-foreground/85">
            <div>
              <JsonNode name="$" value={filteredValue} limit={limit} />
            </div>
          </ScrollableStructuredPanel>
        ) : (
          <TableView value={filteredValue} compact={compact} limit={limit} />
        )}
      </div>
    </div>
  );
}
