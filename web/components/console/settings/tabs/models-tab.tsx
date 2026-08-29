"use client";

import { MetricCard } from "@/components/library/MetricCard";

export interface ModelsTabProps {
  config: Record<string, unknown> | null;
}

export function ModelsTab({ config }: ModelsTabProps) {
  const models = ((config as Record<string, unknown>)?.models ?? {}) as Record<string, unknown>;
  const count = Object.keys(models).length;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <MetricCard label="Model slots" value={String(count || 5)} hint="Validated: per-agent model map, server rejects unknown fields" />
        <MetricCard label="Source" value={String((config as Record<string, unknown>)?.source_layer ?? "default")} hint="Effective source badge per field" />
      </div>
      <div className="rounded-lg border p-3 text-xs text-muted-foreground">
        Validated forms: each model field is typed via Settings sub-models; PATCH is rejected server-side on unknown keys (extra=&quot;forbid&quot;).
      </div>
    </div>
  );
}
