"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

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
  const tone = ["success", "passed", "ok"].includes(s)
    ? "success"
    : ["failed", "error", "fail"].includes(s)
      ? "danger"
      : ["partial", "warning"].includes(s)
        ? "warning"
        : null;

  if (!tone) return <span>{value}</span>;
  return (
    <Badge tone={tone} className="gap-1 px-2 py-0.5 text-[10.5px]">
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {s === "success" || s === "passed" ? "ok" : s}
    </Badge>
  );
}

function fmtCell(key, value) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") {
    return value ? (
      <span className="text-[var(--mint)]">Yes</span>
    ) : (
      <span className="text-muted-foreground">No</span>
    );
  }
  if (typeof value === "object") {
    return (
      <span className="mono text-[12px] text-muted-foreground">
        {JSON.stringify(value)}
      </span>
    );
  }
  const str = String(value);

  /* status pills */
  if (
    [
      "success",
      "passed",
      "ok",
      "failed",
      "error",
      "fail",
      "partial",
      "warning",
    ].includes(str.toLowerCase())
  ) {
    return <StatusPill value={str} />;
  }

  /* truncate long strings */
  if (str.length > 60) {
    return (
      <span
        className="mono text-xs text-muted-foreground"
        title={str}
      >
        {str.slice(0, 60)}&hellip;
      </span>
    );
  }
  if ((key.includes("id") || key.includes("_id")) && str.length > 14) {
    return (
      <span className="mono text-[11.5px] text-foreground">
        {str.slice(0, 12)}&hellip;
      </span>
    );
  }
  return str;
}

export function DataTable({
  title,
  description,
  columns,
  rows,
  onRowClick,
  className,
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm",
        className,
      )}
    >
      {(title || description) && (
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          {title && (
            <div className="text-sm font-medium text-foreground">
              {title}
            </div>
          )}
          {description && (
            <div className="text-sm text-muted-foreground">{description}</div>
          )}
        </div>
      )}
      <div className="overflow-x-auto">
        <table
          className="min-w-full border-collapse text-sm"
          style={{ borderSpacing: 0 }}
        >
          <thead>
            <tr>
              {columns.map((col) => (
                <th
                  key={col}
                  className="whitespace-nowrap border-b border-border bg-muted/50 px-4 py-2.5 text-left text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground"
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
                    "border-b border-border transition-colors last:border-b-0",
                    onRowClick && "cursor-pointer hover:bg-accent/50",
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col}
                      className="whitespace-nowrap px-4 py-3 align-middle text-foreground"
                    >
                      {fmtCell(col, row[col])}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td
                  colSpan={columns.length}
                    className="px-4 py-10 text-center text-sm text-muted-foreground"
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
