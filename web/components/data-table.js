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

function fmtCell(key, value) {
  if (value === null || value === undefined) return <span className="text-slate-700">—</span>;
  if (typeof value === "boolean") {
    return value
      ? <span className="text-emerald-400">Yes</span>
      : <span className="text-slate-600">No</span>;
  }
  if (typeof value === "object") return <span className="font-mono text-slate-500">{JSON.stringify(value)}</span>;
  const str = String(value);

  // status-style values
  if (["success","passed"].includes(str)) return <span className="inline-flex items-center rounded-md bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-400">{str}</span>;
  if (["failed","error","fail"].includes(str)) return <span className="inline-flex items-center rounded-md bg-red-500/10 border border-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400">{str}</span>;
  if (["partial","warning"].includes(str)) return <span className="inline-flex items-center rounded-md bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-400">{str}</span>;

  // long strings
  if (str.length > 60) return <span className="font-mono text-xs text-slate-400 break-all">{str.slice(0, 60)}&hellip;</span>;
  if ((key.includes("id") || key.includes("_id")) && str.length > 12) {
    return <span className="font-mono text-xs text-slate-400">{str.slice(0, 8)}&hellip;</span>;
  }
  return str;
}

export function DataTable({ title, description, columns, rows, onRowClick, className }) {
  return (
    <div className={cn("rounded-xl border border-white/8 bg-white/[0.03] shadow-card overflow-hidden", className)}>
      {(title || description) && (
        <div className="px-5 py-3.5 border-b border-white/6">
          {title && <div className="text-sm font-semibold text-white">{title}</div>}
          {description && <div className="mt-0.5 text-xs text-slate-500">{description}</div>}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead>
            <tr className="border-b border-white/6">
              {columns.map((col) => (
                <th key={col} className="px-4 py-2.5 text-xs font-medium text-slate-500 whitespace-nowrap">
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
                    "border-b border-white/4 text-slate-300 transition-colors",
                    onRowClick && "cursor-pointer hover:bg-white/4"
                  )}
                >
                  {columns.map((col) => (
                    <td key={col} className="px-4 py-2.5 align-top whitespace-nowrap">
                      {fmtCell(col, row[col])}
                    </td>
                  ))}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-sm text-slate-600">
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
