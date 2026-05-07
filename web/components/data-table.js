"use client";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

  if (str.length > 60) {
    return (
      <span className="mono text-xs text-muted-foreground" title={str}>
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
  emptyLabel = "No data yet",
}) {
  const safeRows = Array.isArray(rows) ? rows : [];
  return (
    <Card className={cn("overflow-hidden text-card-foreground shadow-sm", className)}>
      {(title || description) && (
        <CardHeader className="space-y-1 border-b border-border px-4 py-3">
          {title ? <CardTitle className="text-sm font-medium">{title}</CardTitle> : null}
          {description ? (
            <CardDescription className="text-xs">{description}</CardDescription>
          ) : null}
        </CardHeader>
      )}
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
                  <TableRow
                    key={i}
                    onClick={() => onRowClick?.(row)}
                    className={cn(onRowClick && "cursor-pointer")}
                  >
                    {columns.map((col) => (
                      <TableCell
                        key={col}
                        className="whitespace-nowrap px-4 py-3 align-middle text-foreground"
                      >
                        {fmtCell(col, row[col])}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={columns.length}
                    className="px-4 py-10 text-center text-sm text-muted-foreground"
                  >
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
