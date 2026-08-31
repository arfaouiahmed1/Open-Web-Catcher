/**
 * Settings — General tab
 * Commercial polish: SourceBadge row per field, SourceLegend, validated readouts, dark/light tuned.
 */
"use client";

import { Settings2, Layers, ShieldCheck } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";
import { SourceBadge, SourceLegend } from "@/components/console/common/source-badge";
import { SectionPanel } from "@/components/console/common/section-panel";

export interface GeneralTabProps {
  config: Record<string, unknown> | null;
}

export function GeneralTab({ config }: GeneralTabProps) {
  const source = String((config as Record<string, unknown>)?.source_layer ?? (config as Record<string, unknown>)?.source ?? "default");
  const dirtyCount = Object.keys((config as Record<string, unknown>)?.dirtyTabs ?? {}).length;
  const cfg = (config ?? {}) as Record<string, unknown>;
  return (
    <div className="space-y-4 animate-fade-up">
      <SectionPanel title="Configuration overview" description="Effective values after precedence: env → base yaml → runtime yaml → default" icon={<Settings2 className="h-3.5 w-3.5" />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <MetricCard label="Effective source" value={source} hint="env < base yaml < runtime yaml (single chain, empty string ≠ clobber)" />
          <MetricCard label="Dirty tabs" value={String(dirtyCount)} hint="Validated forms track dirty state per tab (getDirtyTabs)" />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5">
          <SourceBadge source={source} field="global" />
          <span className="text-xs text-muted-foreground">Global precedence chain</span>
          <span className="ml-auto hidden sm:inline text-xs text-muted-foreground">Hover badge for hint</span>
        </div>
        <SourceLegend className="mt-3" />
      </SectionPanel>

      <SectionPanel title="Guardrails" description="Typed settings with extra=forbid — unknown keys rejected server-side" icon={<ShieldCheck className="h-3.5 w-3.5" />}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border p-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Layers className="h-3.5 w-3.5 text-muted-foreground" /> YAML safety
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Blank strings are dropped before merge — they never clobber a stored value. POPULATE_BY_NAME aliasing ensures snake_case payloads hydrate correctly.
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <div className="text-xs font-semibold">Validation</div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              PATCH aggregates field errors; UI shows inline errors and disables Save until valid. Dirty tabs badge reflects unsaved edits.
            </p>
          </div>
        </div>
        <div className="mt-3 grid gap-2 text-xs">
          <div className="flex items-center justify-between rounded-md border bg-card px-2.5 py-2">
            <span className="font-medium">Observability</span>
            <span className="flex items-center gap-2">
              <span className="font-mono text-muted-foreground">{String(cfg.observability_enabled ?? true)}</span>
              <SourceBadge source={source} />
            </span>
          </div>
          <div className="flex items-center justify-between rounded-md border bg-card px-2.5 py-2">
            <span className="font-medium">Retention / caps</span>
            <span className="font-mono text-xs text-muted-foreground">
              {String(cfg.retention_days_runs ?? 30)}d · {String(cfg.payload_cap_bytes ?? 8192)}B
            </span>
          </div>
        </div>
      </SectionPanel>
    </div>
  );
}
