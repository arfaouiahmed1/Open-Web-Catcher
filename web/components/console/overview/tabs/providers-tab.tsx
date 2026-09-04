"use client";

import { Globe2 } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";
import { SectionPanel } from "@/components/console/common/section-panel";
import { EmptyState } from "@/components/console/common/empty-state";
import { Badge } from "@/components/ui/badge";

export interface ProvidersTabProps {
  overview: Record<string, unknown> | null;
  state?: "loading" | "error" | "success";
}

export function ProvidersTab({ overview, state }: ProvidersTabProps) {
  if (state === "loading" || !overview) return <MetricCard label="Providers" state="loading" />;
  const rows = ((overview as Record<string, unknown>).provider_breakdown ?? []) as Array<Record<string, unknown>>;
  if (!rows.length) return <EmptyState tone="default" title="No provider data" description="No provider activity in this window. Run a pipeline to see provider usage here." />;
  return (
    <div className="space-y-4 animate-fade-up">
      <SectionPanel title="Providers — top 10" description="Model providers observed across recent runs" icon={<Globe2 className="h-3.5 w-3.5" />}>
        <ul className="divide-y divide-border/60 rounded-lg border">
          {rows.slice(0, 10).map((r) => (
            <li key={String(r.provider || r.label || Math.random())} className="flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-muted/20">
              <span className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                <span className="text-sm font-medium">{String(r.provider || r.label || "?")}</span>
                <Badge tone="muted" className="text-[10px]">{String(r.model_name || r.model || "").slice(0, 24)}</Badge>
              </span>
              <span className="font-mono text-xs tabular-nums">{String(r.count ?? r.analysis_count ?? "—")} analyses</span>
            </li>
          ))}
        </ul>
      </SectionPanel>
    </div>
  );
}
