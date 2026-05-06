"use client";

import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";

function isPrimitive(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function formatValue(value) {
  if (value == null) return "--";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "string") return value || "--";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
  return String(value);
}

function PrimitivePill({ children }) {
  return (
    <span
      className="inline-flex max-w-full items-center rounded-md border border-border bg-muted/40 px-2 py-1 text-[11px] text-muted-foreground/80"
    >
      <span className="truncate">{children}</span>
    </span>
  );
}

function KeyValueGrid({ entries = [] }) {
  if (!entries.length) return null;
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {entries.map(([key, value]) => (
        <div
          key={key}
          className="rounded-lg border border-border bg-muted/20 px-3 py-2.5"
        >
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
            {String(key).replace(/_/g, " ")}
          </div>
          <div className="mt-1 break-words text-[12px] leading-relaxed text-foreground/80">
            {formatValue(value)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ObjectSection({ label, value, limit }) {
  const primitiveEntries = Object.entries(value || {}).filter(([, nested]) => isPrimitive(nested)).slice(0, limit);
  const nestedEntries = Object.entries(value || {}).filter(([, nested]) => !isPrimitive(nested)).slice(0, Math.max(0, limit - primitiveEntries.length));

  return (
    <div className="space-y-3">
      {label ? (
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {label}
        </div>
      ) : null}
      <KeyValueGrid entries={primitiveEntries} />
      {nestedEntries.length ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {nestedEntries.map(([key, nested]) => (
            <div
              key={key}
              className="rounded-lg border border-border bg-muted/20 p-3"
            >
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
                {String(key).replace(/_/g, " ")}
              </div>
              {Array.isArray(nested) ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {nested.slice(0, limit).map((item, index) => (
                    <PrimitivePill key={`${key}-${index}`}>{formatValue(item)}</PrimitivePill>
                  ))}
                  {nested.length > limit ? <PrimitivePill>+{nested.length - limit} more</PrimitivePill> : null}
                </div>
              ) : (
                <div className="mt-2">
                  <KeyValueGrid entries={Object.entries(nested || {}).filter(([, child]) => isPrimitive(child)).slice(0, limit)} />
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function StructuredDataCard({ title, description, data, limit = 8, emptyLabel = "No structured data available." }) {
  const [mode, setMode] = useState("table");
  const normalized = useMemo(() => data ?? null, [data]);
  const isEmpty = useMemo(() => {
    if (normalized == null) return true;
    if (Array.isArray(normalized)) return normalized.length === 0;
    if (typeof normalized === "object") return Object.keys(normalized).length === 0;
    return false;
  }, [normalized]);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card/60 shadow-sm">
      {(title || description) ? (
        <div className="flex flex-row items-start justify-between gap-3 border-b border-border px-4 py-3.5">
          <div className="space-y-1">
            {title ? <div className="text-sm font-semibold text-foreground">{title}</div> : null}
            {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
          </div>
          {!isEmpty && !isPrimitive(normalized) ? (
            <div className="flex shrink-0 rounded-md border border-border bg-muted/30 p-0.5">
              {["table", "json"].map((entry) => (
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
      ) : null}

      <div className="p-4">
        {isEmpty ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            {emptyLabel}
          </div>
        ) : mode === "json" && !isPrimitive(normalized) ? (
          <ScrollArea className="max-h-[460px] rounded-lg border border-border bg-muted/20">
            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-[11.5px] leading-relaxed text-foreground/85">
              {JSON.stringify(normalized, null, 2)}
            </pre>
          </ScrollArea>
        ) : Array.isArray(normalized) ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              {normalized.slice(0, limit).map((item, index) => (
                <PrimitivePill key={index}>{isPrimitive(item) ? formatValue(item) : `Entry ${index + 1}`}</PrimitivePill>
              ))}
              {normalized.length > limit ? <PrimitivePill>+{normalized.length - limit} more</PrimitivePill> : null}
            </div>
          </div>
        ) : isPrimitive(normalized) ? (
          <div className="text-[12.5px] text-foreground/80">{formatValue(normalized)}</div>
        ) : (
          <ObjectSection value={normalized} limit={limit} />
        )}
      </div>
    </div>
  );
}
