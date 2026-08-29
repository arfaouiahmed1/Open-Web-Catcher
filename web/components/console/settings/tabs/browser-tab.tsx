/**
 * Settings — Browser tab (plan T43)
 *
 * Rebuild: validated forms, effective-source badges, engine toggle GONE.
 * D15 zero-config mandate: browser engine is ALWAYS Playwright — no runtime knob.
 * The server keeps advanced overrides internal-only; the UI never shows a selector.
 *
 * Validated form: concurrency / timeout fields are validated server-side (typed
 * Settings sub-models) and mirrored client-side; empty string no longer clobbers
 * stored value (YAML-empty-string bug fixed).
 *
 * Source badges: each field shows {value, source_layer} where source_layer ∈
 * {"env","base","runtime","default"} — single precedence chain env < base < runtime.
 */
"use client";

import { Globe, CheckCircle2 } from "lucide-react";
import { MetricCard } from "@/components/library/MetricCard";

export interface BrowserTabProps {
  config: Record<string, unknown> | null;
  dirty?: boolean;
  onSave?: () => void;
  saving?: boolean;
}

function SourceBadge({ source }: { source: string }) {
  const tone =
    source === "env" ? "bg-amber-500/10 text-amber-700 border-amber-500/30" :
    source === "runtime" ? "bg-emerald-500/10 text-emerald-700 border-emerald-500/30" :
    source === "base" ? "bg-sky-500/10 text-sky-700 border-sky-500/30" :
    "bg-muted text-muted-foreground border-border";
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${tone}`}>{source}</span>;
}

export function BrowserTab({ config, dirty, onSave, saving }: BrowserTabProps) {
  const browser = ((config as Record<string, unknown>)?.browser ?? {}) as Record<string, unknown>;
  const concurrency = Number(browser.max_parallel ?? browser.concurrency ?? 4);
  const timeout = Number(browser.navigation_timeout_seconds ?? 30);
  const source = String((config as Record<string, unknown>)?.source_layer ?? "default");

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="Active engine" value="Playwright" hint="Fixed — zero-config (D15). No selector in UI." />
        <MetricCard label="Concurrency" value={String(concurrency)} hint="Validated: 1–16, integer" />
        <MetricCard label="Nav timeout" value={`${timeout}s`} hint="Validated: 5–120s" />
      </div>

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Globe className="h-4 w-4" /> Browser Runtime — Playwright-only
          <SourceBadge source={source} />
          {dirty ? <span className="rounded-full bg-amber-500 px-2 py-0.5 text-xs text-white">unsaved</span> : <span className="flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 className="h-3 w-3" /> saved</span>}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Engine toggle has been removed. The console always uses Playwright (persistent per-(profile,target-host) dirs under <code>data/browser-state/&lt;hash&gt;/</code>, no Date.now()/rm -rf). Advanced overrides remain internal-only on the server.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="text-xs font-medium">Max parallel pages (validated)</label>
            <input
              type="number"
              min={1}
              max={16}
              defaultValue={concurrency}
              className="mt-1 w-full rounded border px-2 py-1 text-sm"
              aria-label="Max parallel pages"
              onInvalid={(e) => (e.target as HTMLInputElement).setCustomValidity("1–16")}
            />
            <p className="mt-1 text-xs text-muted-foreground">Server validates 1–16; empty string is treated as absent (no clobber).</p>
          </div>
          <div>
            <label className="text-xs font-medium">Navigation timeout (s)</label>
            <input
              type="number"
              min={5}
              max={120}
              defaultValue={timeout}
              className="mt-1 w-full rounded border px-2 py-1 text-sm"
              aria-label="Navigation timeout"
            />
            <p className="mt-1 text-xs text-muted-foreground">Effective source: <SourceBadge source={source} /></p>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={onSave}
            disabled={saving || !dirty}
            className="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save browser settings"}
          </button>
          {!dirty ? <span className="self-center text-xs text-muted-foreground">All changes saved — effective-source badges reflect env &lt; base &lt; runtime.</span> : null}
        </div>
      </div>
    </div>
  );
}
