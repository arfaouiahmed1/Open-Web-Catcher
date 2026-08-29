"use client";

import { MetricCard } from "@/components/library/MetricCard";

export interface ProvidersTabProps {
  overview: Record<string, unknown> | null;
  state?: "loading" | "error" | "success";
}

export function ProvidersTab({ overview, state }: ProvidersTabProps) {
  if (state === "loading" || !overview) return <MetricCard label="Providers" state="loading" />;
  const rows = ((overview as Record<string, unknown>).provider_breakdown ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return <MetricCard label="Providers" value="—" state="empty" emptyLabel="No provider data in this overview window." />;
  return (
    <div className="rounded-lg border p-4 text-sm">
      <p className="font-medium">Providers — COUNT GROUP BY provider (top 10)</p>
      <ul className="mt-2 list-disc pl-4 text-muted-foreground">
        {rows.slice(0, 10).map((r) => (
          <li key={String(r.provider || r.label || Math.random())}>
            {String(r.provider || r.label || "?")} — {String(r.count ?? r.analysis_count ?? "")} analyses
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted-foreground">Source: /ui/overview provider_breakdown (SUM-by-provider fix in ui_repository).</p>
    </div>
  );
}
