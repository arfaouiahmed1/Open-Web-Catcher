/**
 * Settings — Models tab
 * Polished: SourceBadge per slot, validated model map, forbidden-unknown guard, dark/light refined.
 */
"use client";

import { Cpu, CheckCircle2, AlertTriangle } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";
import { SourceBadge, SourceLegend } from "@/components/console/common/source-badge";
import { SectionPanel } from "@/components/console/common/section-panel";
import { Badge } from "@/components/ui/badge";

export interface ModelsTabProps {
  config: Record<string, unknown> | null;
}

export function ModelsTab({ config }: ModelsTabProps) {
  const models = ((config as Record<string, unknown>)?.models ?? (config as Record<string, unknown>)?.agent_model_config ?? {}) as Record<string, unknown>;
  const source = String((config as Record<string, unknown>)?.source_layer ?? "default");
  const count = Object.keys(models).length;
  const warnings = ((config as Record<string, unknown>)?.model_config_warnings ?? []) as unknown[];
  return (
    <div className="space-y-4 animate-fade-up">
      <SectionPanel title="Model slots" description="Per-agent model assignments · validated via Settings sub-models (extra=forbid)" icon={<Cpu className="h-3.5 w-3.5" />}>
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Model slots" value={String(count || 5)} hint="Validated: per-agent model map" />
          <MetricCard label="Effective source" value={source} hint="env < runtime yaml < base yaml < default" />
          <MetricCard label="Warnings" value={String(warnings.length)} hint={warnings.length ? (warnings[0] as string).slice(0, 48) : "No warnings"} />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <SourceBadge source={source} field="models" />
          <SourceLegend className="flex-1" />
        </div>
      </SectionPanel>

      <SectionPanel title="Live catalog" description="Server enriches model lists from the provider catalog (fallback when key absent) — pricing + context windows" >
        <div className="divide-y divide-border/60 rounded-lg border">
          {count ? (
            Object.entries(models).slice(0, 8).map(([slot, raw]) => {
              const v = raw as Record<string, unknown>;
              return (
                <div key={slot} className="flex items-center justify-between gap-3 px-3 py-2.5 hover:bg-muted/20">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold capitalize">{slot}</span>
                      <SourceBadge source={source} />
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">{String(v?.model ?? v?.id ?? "—")}</div>
                  </div>
                  <Badge tone="muted" className="font-mono text-[10px]">{String(v?.provider ?? "google")}</Badge>
                </div>
              );
            })
          ) : (
            <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground">
              <AlertTriangle className="h-4 w-4" /> No model slots — defaults will be used (5 agents → orchestrator fallback).
            </div>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <CheckCircle2 className="h-3 w-3 text-emerald-600" /> PATCH rejects unknown keys; empty string ≠ clobber.
          <span className="ml-auto hidden sm:inline">Each field shows its effective source badge.</span>
        </div>
      </SectionPanel>
    </div>
  );
}
