"use client";

import { useMemo } from "react";

function isPrimitive(value) {
  return value == null || ["string", "number", "boolean"].includes(typeof value);
}

function formatValue(value) {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === "string") return value || "—";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (typeof value === "object") return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? "" : "s"}`;
  return String(value);
}

function PrimitivePill({ children }) {
  return (
    <span
      className="inline-flex max-w-full items-center rounded-[8px] border px-2 py-1 text-[11px]"
      style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.03)", color: "var(--ink-dim)" }}
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
          className="rounded-[10px] border px-3 py-2.5"
          style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)" }}
        >
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
            {String(key).replace(/_/g, " ")}
          </div>
          <div className="mt-1 break-words text-[12px] leading-relaxed" style={{ color: "var(--ink-dim)" }}>
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
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-2)" }}>
          {label}
        </div>
      ) : null}
      <KeyValueGrid entries={primitiveEntries} />
      {nestedEntries.length ? (
        <div className="grid gap-3 xl:grid-cols-2">
          {nestedEntries.map(([key, nested]) => (
            <div
              key={key}
              className="rounded-[12px] border p-3"
              style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.015)" }}
            >
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
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
  const normalized = useMemo(() => data ?? null, [data]);
  const isEmpty = useMemo(() => {
    if (normalized == null) return true;
    if (Array.isArray(normalized)) return normalized.length === 0;
    if (typeof normalized === "object") return Object.keys(normalized).length === 0;
    return false;
  }, [normalized]);

  return (
    <div
      className="overflow-hidden rounded-[14px] border"
      style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      {(title || description) ? (
        <div className="border-b px-4 py-3.5" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)" }}>
          {title ? <div className="text-[13.5px] font-semibold" style={{ color: "var(--ink)" }}>{title}</div> : null}
          {description ? <div className="mt-0.5 text-[11.5px]" style={{ color: "var(--mute)" }}>{description}</div> : null}
        </div>
      ) : null}

      <div className="p-4">
        {isEmpty ? (
          <div className="rounded-[10px] border border-dashed px-4 py-6 text-center text-[12px]" style={{ borderColor: "var(--line)", color: "var(--mute)" }}>
            {emptyLabel}
          </div>
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
          <div className="text-[12.5px]" style={{ color: "var(--ink-dim)" }}>{formatValue(normalized)}</div>
        ) : (
          <ObjectSection value={normalized} limit={limit} />
        )}
      </div>
    </div>
  );
}
