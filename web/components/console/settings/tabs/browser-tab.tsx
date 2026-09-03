/**
 * Settings — Browser tab (polished)
 * Rebuild: validated forms, effective-source badges via shared SourceBadge, engine fixed to Playwright, dark/light refined.
 */
"use client";

import * as React from "react";
import { Globe, CheckCircle2, AlertCircle } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";
import { SourceBadge, SourceLegend } from "@/components/console/common/source-badge";
import { SectionPanel } from "@/components/console/common/section-panel";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface BrowserTabProps {
  config: Record<string, unknown> | null;
  dirty?: boolean;
  onSave?: () => void;
  saving?: boolean;
}

function validateConcurrency(v: string): string | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return "Must be an integer";
  if (n < 1 || n > 16) return "1–16";
  return undefined;
}
function validateTimeout(v: string): string | undefined {
  if (v.trim() === "") return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) return "Must be a number";
  if (n < 5 || n > 120) return "5–120";
  return undefined;
}

export function BrowserTab({ config, dirty, onSave, saving }: BrowserTabProps) {
  const browser = ((config as Record<string, unknown>)?.browser ?? {}) as Record<string, unknown>;
  const concurrencyRaw = String(browser.max_parallel ?? browser.concurrency ?? 4);
  const timeoutRaw = String(browser.navigation_timeout_seconds ?? 30);
  const source = String((config as Record<string, unknown>)?.source_layer ?? "default");
  const [conc, setConc] = React.useState(concurrencyRaw);
  const [to, setTo] = React.useState(timeoutRaw);
  React.useEffect(() => { setConc(concurrencyRaw); }, [concurrencyRaw]);
  React.useEffect(() => { setTo(timeoutRaw); }, [timeoutRaw]);
  const concError = validateConcurrency(conc);
  const toError = validateTimeout(to);
  const hasValidationError = Boolean(concError || toError);
  return (
    <div className="space-y-4 animate-fade-up">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Active engine" value="Playwright" hint="Fixed — zero-config (D15). No selector in UI." />
        <MetricCard label="Concurrency" value={String(Number(conc) || 4)} hint={concError ?? "Validated: 1–16, integer"} state={concError ? "error" : undefined} errorLabel={concError} />
        <MetricCard label="Nav timeout" value={`${Number(to) || 30}s`} hint={toError ?? "Validated: 5–120s"} state={toError ? "error" : undefined} errorLabel={toError} />
      </div>

      <SectionPanel title="Browser Runtime — Playwright-only" description="Engine toggle removed. Console always uses Playwright (persistent per-(profile,target-host) dirs, no Date.now()/rm -rf). Advanced overrides remain server-internal." icon={<Globe className="h-3.5 w-3.5" />} actions={<SourceBadge source={source} field="browser" />}>
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5 text-xs">
          <Badge tone="success" className="gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-current" /> Playwright
          </Badge>
          <span className="text-muted-foreground">Fixed engine · zero knob</span>
          <span className="ml-auto flex items-center gap-2">
            {dirty ? <Badge tone="warning" className="gap-1"><AlertCircle className="h-3 w-3" /> unsaved</Badge> : <span className="flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-3 w-3" /> saved</span>}
            <SourceBadge source={source} />
          </span>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          Engine toggle has been removed. The console always uses Playwright (persistent per-(profile,target-host) dirs under <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">data/browser-state/&lt;hash&gt;/</code>, no Date.now()/rm -rf). Advanced overrides remain internal-only on the server.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <Input label="Max parallel pages (validated)" type="number" min={1} max={16} value={conc} onChange={(e) => setConc(e.target.value)} error={concError} description="Server validates 1–16; empty string is treated as absent (no clobber)." />
          <Input label="Navigation timeout (s)" type="number" min={5} max={120} value={to} onChange={(e) => setTo(e.target.value)} error={toError} description="Effective source badge reflects env < base < runtime." />
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <SourceBadge source={source} field="browser concurrency" />
          <SourceBadge source={source} field="browser timeout" />
          <SourceLegend className="ml-auto hidden sm:flex" />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <Button onClick={onSave} disabled={Boolean(saving || !dirty || hasValidationError)} variant="accent" className="min-w-[184px]">
            {saving ? "Saving…" : hasValidationError ? "Fix validation" : dirty ? "Save browser settings" : "Saved"}
          </Button>
          {hasValidationError ? <span className="text-xs font-medium text-destructive">Fix validation errors before saving.</span> : !dirty ? <span className="text-xs text-muted-foreground">All changes saved — effective-source badges reflect env &lt; base &lt; runtime.</span> : null}
        </div>
      </SectionPanel>
    </div>
  );
}
