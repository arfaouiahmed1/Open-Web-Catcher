"use client";

import { cn } from "@/lib/utils";

function fmtHeader(key) {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bId\b/, "ID")
    .replace(/\bUrl\b/, "URL")
    .replace(/\bUsd\b/, "USD")
    .replace(/\bLlm\b/, "LLM");
}

function StatusPill({ value }) {
  const s = String(value).toLowerCase();
  const cls =
    ["success", "passed", "ok"].includes(s) ? "ok"   :
    ["failed", "error", "fail"].includes(s)  ? "err"  :
    ["partial", "warning"].includes(s)       ? "warn" : null;

  if (!cls) return <span>{value}</span>;
  return (
    <span className={`owc-pill ${cls}`}>
      <span className="dot" />
      {s === "success" || s === "passed" ? "ok" : s}
    </span>
  );
}

function fmtCell(key, value) {
  if (value === null || value === undefined) {
    return <span style={{ color: "var(--mute-3)" }}>—</span>;
  }
  if (typeof value === "boolean") {
    return value
      ? <span style={{ color: "var(--mint)" }}>Yes</span>
      : <span style={{ color: "var(--mute-3)" }}>No</span>;
  }
  if (typeof value === "object") {
    return (
      <span className="mono text-[12px]" style={{ color: "var(--mute)" }}>
        {JSON.stringify(value)}
      </span>
    );
  }
  const str = String(value);

  /* status pills */
  if (["success","passed","ok","failed","error","fail","partial","warning"].includes(str.toLowerCase())) {
    return <StatusPill value={str} />;
  }

  /* truncate long strings */
  if (str.length > 60) {
    return (
      <span className="mono text-xs" style={{ color: "var(--mute)" }} title={str}>
        {str.slice(0, 60)}&hellip;
      </span>
    );
  }
  if ((key.includes("id") || key.includes("_id")) && str.length > 14) {
    return (
      <span className="mono text-[11.5px]" style={{ color: "var(--ink-dim)" }}>
        {str.slice(0, 12)}&hellip;
      </span>
    );
  }
  return str;
}

export function DataTable({ title, description, columns, rows, onRowClick, className }) {
  return (
    <div
      className={cn("overflow-hidden rounded-[14px] border border-[var(--line)]", className)}
      style={{ background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      {(title || description) && (
        <div className="flex items-center gap-2.5 border-b border-[var(--line)] px-[18px] py-3.5">
          {title && <div className="text-[13.5px] font-medium text-[var(--ink)]">{title}</div>}
          {description && (
            <div className="text-[12px] text-[var(--mute)]">{description}</div>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table
          className="min-w-full border-collapse"
          style={{ borderSpacing: 0, fontSize: "13px" }}
        >
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  className="whitespace-nowrap border-b border-[var(--line)] px-4 py-2.5 text-left text-[10.5px] font-medium uppercase tracking-[0.1em]"
                  style={{ color: "var(--mute)", background: "rgba(255,255,255,0.012)" }}
                >
                  {fmtHeader(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row, i) => (
                <tr
                  key={i}
                  onClick={() => onRowClick?.(row)}
                  className={cn(
                    "border-b border-[var(--line)] transition-colors last:border-b-0",
                    onRowClick && "cursor-pointer hover:bg-white/[0.018]"
                  )}
                  style={{ color: "var(--ink-dim)" }}
                >
                  {columns.map((col) => (
                    <td key={col} className="whitespace-nowrap px-4 py-[11px] align-middle">
                      {fmtCell(col, row[col])}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={columns.length}
                  className="px-4 py-10 text-center text-sm"
                  style={{ color: "var(--mute-3)" }}
                >
                  No data yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
