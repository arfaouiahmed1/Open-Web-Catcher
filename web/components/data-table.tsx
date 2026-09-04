"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StateFrame } from "@/components/library/StateFrame";
import type { ComponentState } from "@/components/library/types";

function fmtHeader(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bId\b/, "ID")
    .replace(/\bUrl\b/, "URL")
    .replace(/\bUsd\b/, "USD")
    .replace(/\bLlm\b/, "LLM");
}

function StatusPill({ value }: { value: string }): React.JSX.Element {
  const s = String(value).toLowerCase();
  const tone: "success" | "danger" | "warning" | null = ["success", "passed", "ok"].includes(s)
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

function fmtCell(key: string, value: unknown): React.ReactNode {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (typeof value === "boolean") {
    return value ? <span className="text-[var(--mint-text)]">Yes</span> : <span className="text-muted-foreground">No</span>;
  }
  if (typeof value === "object") {
    return <span className="mono text-[12px] text-muted-foreground">{JSON.stringify(value)}</span>;
  }
  const str = String(value);

  if (["success", "passed", "ok", "failed", "error", "fail", "partial", "warning"].includes(str.toLowerCase())) {
    return <StatusPill value={str} />;
  }

  if (str.length > 60) {
    return (
      <span className="mono text-xs text-muted-foreground" title={str}>
        {str.slice(0, 60)}&hellip;
      </span>
    );
  }
  if ((key.includes("id") || key.includes("_id")) && str.length > 14) {
    return <span className="mono text-[11.5px] text-foreground">{str.slice(0, 12)}&hellip;</span>;
  }
  return str;
}

export interface DataTableProps<T extends Record<string, unknown> = Record<string, unknown>> {
  title?: string;
  description?: string;
  columns: string[];
  rows?: T[];
  onRowClick?: (row: T) => void;
  className?: string;
  emptyLabel?: string;
  state?: ComponentState;
}

export function DataTable<T extends Record<string, unknown>>({
  title,
  description,
  columns,
  rows,
  onRowClick,
  className,
  emptyLabel = "No data yet",
  state,
}: DataTableProps<T>): React.JSX.Element {
  const safeRows = Array.isArray(rows) ? rows : [];
  const hasData = safeRows.length > 0;
  const resolvedState: ComponentState = state ?? (hasData ? "success" : "empty");

  if (resolvedState !== "success") {
    return (
      <StateFrame component="DataTable" state={resolvedState} emptyLabel={emptyLabel} className={className}>
        <div />
      </StateFrame>
    );
  }

  return (
    <Card className={cn("overflow-hidden text-card-foreground shadow-sm", className)}>
      {(title || description) ? (
        <CardHeader className="space-y-1 border-b border-border px-4 py-3">
          {title ? <CardTitle className="text-sm font-medium">{title}</CardTitle> : null}
          {description ? <CardDescription className="text-xs">{description}</CardDescription> : null}
        </CardHeader>
      ) : null}
      <CardContent className="p-0">
        <ScrollArea className="max-h-[520px]">
          <Table className="min-w-full">
            <TableHeader className="bg-muted/40">
              <TableRow>
                {columns.map((col) => (
                  <TableHead key={col} className="whitespace-nowrap">
                    {fmtHeader(col)}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {safeRows.length ? (
                safeRows.map((row, i) => (
                  <TableRow key={i} onClick={() => onRowClick?.(row)} className={cn(onRowClick && "cursor-pointer")}>
                    {columns.map((col) => (
                      <TableCell key={col} className="whitespace-nowrap px-4 py-3 align-middle text-foreground">
                        {fmtCell(col, row[col])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="py-10 text-center text-sm text-muted-foreground">
                    {emptyLabel}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

export default React.memo(DataTable) as typeof DataTable;
