"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type SourceKind = "env" | "base" | "runtime" | "default" | "unknown";

const SOURCE_META: Record<SourceKind, { label: string; tone: "success" | "signal" | "violet" | "muted" | "default"; hint: string }> = {
  env: { label: "env", tone: "success", hint: "Environment variable — highest precedence" },
  base: { label: "base yaml", tone: "signal", hint: "Base config file (configs/app.yaml)" },
  runtime: { label: "runtime", tone: "violet", hint: "Runtime override (data/settings.runtime.yaml)" },
  default: { label: "default", tone: "muted", hint: "Built-in default (no override)" },
  unknown: { label: "unknown", tone: "default", hint: "Source not tracked" },
};

export interface SourceBadgeProps {
  source?: string | null;
  field?: string;
  className?: string;
  compact?: boolean;
}

function normalizeSource(raw?: string | null): SourceKind {
  const v = String(raw || "").toLowerCase().trim();
  if (v === "env" || v === "environment" || v.includes("env")) return "env";
  if (v === "runtime" || v.includes("runtime")) return "runtime";
  if (v === "base" || v.includes("base") || v.includes("yaml")) return "base";
  if (v === "default" || v === "fallback" || !v) return "default";
  return "unknown";
}

export function SourceBadge({ source, field, className, compact = false }: SourceBadgeProps) {
  const kind = normalizeSource(source);
  const meta = SOURCE_META[kind];
  const label = compact ? meta.label.slice(0, 3) : meta.label;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={cn("inline-flex", className)}>
            <Badge tone={meta.tone} className="gap-1 px-1.5 py-0 text-[9px] font-sans uppercase tracking-wider cursor-help">
              <span className="h-1.5 w-1.5 rounded-full bg-current opacity-80" aria-hidden />
              {label}
            </Badge>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px] text-xs">
          <p className="font-medium">{field ? `${field}: ${meta.label}` : `Source: ${meta.label}`}</p>
          <p className="text-muted-foreground">{meta.hint}</p>
          {source && source !== meta.label ? <p className="mt-1 font-mono text-[10px] opacity-70">raw: {String(source)}</p> : null}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export interface EffectiveSourceRowProps {
  label: string;
  source?: string | null;
  value?: React.ReactNode;
  hint?: string;
  className?: string;
}

export function EffectiveSourceRow({ label, source, value, hint, className }: EffectiveSourceRowProps) {
  return (
    <div className={cn("flex items-center justify-between gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2", className)}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-foreground">{label}</span>
          <SourceBadge source={source} field={label} />
        </div>
        {hint ? <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p> : null}
      </div>
      {value !== undefined ? <span className="shrink-0 font-mono text-xs text-foreground/80">{value}</span> : null}
    </div>
  );
}

export function SourceLegend({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground", className)}>
      <Info className="h-3 w-3 shrink-0" />
      <span>Effective value = env &gt; runtime yaml &gt; base yaml &gt; default.</span>
      <span className="hidden sm:inline">Hover badge for precedence.</span>
    </div>
  );
}
