"use client";

import { MetricCard } from "@/components/library/MetricCard";

export interface GeneralTabProps {
  config: Record<string, unknown> | null;
}

export function GeneralTab({ config }: GeneralTabProps) {
  const summary = ((config as Record<string, unknown>)?.summary ?? {}) as Record<string, unknown>;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <MetricCard label="Config source" value={String((config as Record<string, unknown>)?.source_layer ?? "default")} hint="env < base yaml < runtime yaml (single chain, empty string ≠ clobber)" />
      <MetricCard label="Dirty tabs" value={String(Object.keys((config as Record<string, unknown>)?.dirtyTabs ?? {}).length || 0)} hint="Validated forms track dirty state per tab" />
    </div>
  );
}
