"use client";

import * as React from "react";
import { Globe, CheckCircle2, AlertCircle, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export interface BrowserRuntimePlaywright {
  launch_timeout_ms?: number;
  extra_launch_args?: string[];
  adblock_allowlist_hosts?: string[];
  streaming_safe_mode?: string;
  asset_diagnostics_enabled?: boolean;
  popup_blocking_enabled?: boolean;
  ubol_enabled?: boolean;
  stream_cors_patch_enabled?: boolean;
  stream_cors_include_credentials?: boolean;
  iframe_sandbox_patch_enabled?: boolean;
  iframe_auto_recovery_enabled?: boolean;
  iframe_recovery_timeout_ms?: number;
  media_capture_timeout_ms?: number;
  media_cors_patch_enabled?: boolean;
  media_playback_verification_enabled?: boolean;
  [key: string]: unknown;
}

export interface BrowserSyncStatus {
  stale?: boolean;
  active_runtime_source?: string;
  synced_at?: string;
}

export interface BrowserTabProps {
  runtime: BrowserRuntimePlaywright;
  maxParallelHostingPages: string;
  source?: string;
  dirty?: boolean;
  saving?: boolean;
  syncStatus?: BrowserSyncStatus | null;
  onRuntimeChange: (key: string, value: unknown) => void;
  onRuntimeListChange: (key: string, value: string | string[]) => void;
  onMaxParallelChange: (value: string) => void;
  onSave: () => void;
}

function toListText(value: unknown): string {
  if (Array.isArray(value)) return (value as unknown[]).map((v) => String(v ?? "")).filter(Boolean).join(", ");
  if (typeof value === "string") return value;
  return "";
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl border border-border/60 bg-card px-3.5 py-3 transition-colors hover:bg-muted/20">
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-foreground">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[12px] leading-relaxed text-muted-foreground">{description}</span>
        ) : null}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} className="mt-0.5 shrink-0" />
    </label>
  );
}

function FieldGroup({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-border/70 bg-card/95 p-4">
      <div>
        <h3 className="text-[14px] font-semibold text-foreground">{title}</h3>
        {description ? <p className="mt-0.5 text-[12px] leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

export function BrowserTab({
  runtime,
  maxParallelHostingPages,
  source = "default",
  dirty = false,
  saving = false,
  syncStatus = null,
  onRuntimeChange,
  onRuntimeListChange,
  onMaxParallelChange,
  onSave,
}: BrowserTabProps): React.JSX.Element {
  const rt = runtime ?? {};
  const maxParallel = Number(maxParallelHostingPages);
  const maxParallelError =
    maxParallelHostingPages.trim() === ""
      ? "Required: 1–16."
      : !Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 16
        ? "Must be an integer from 1 to 16."
        : undefined;
  const launchMs = Number(rt.launch_timeout_ms ?? 0);
  const launchError =
    !Number.isFinite(launchMs) || launchMs < 5000 || launchMs > 120000
      ? "Must be between 5000 and 120000 ms."
      : undefined;
  const mediaMs = Number(rt.media_capture_timeout_ms ?? 0);
  const mediaError =
    !Number.isFinite(mediaMs) || mediaMs < 5000 || mediaMs > 120000
      ? "Must be between 5000 and 120000 ms."
      : undefined;
  const iframeMs = Number(rt.iframe_recovery_timeout_ms ?? 0);
  const iframeError =
    !Number.isFinite(iframeMs) || iframeMs < 5000 || iframeMs > 60000
      ? "Must be between 5000 and 60000 ms."
      : undefined;
  const hasError = Boolean(maxParallelError || launchError || mediaError || iframeError);

  return (
    <div className="space-y-4 animate-fade-up">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5 text-xs">
        <Badge tone="success" className="gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-current" /> Engine: Playwright 1.62.1 (Isolated Sessions)
        </Badge>
        <span className="text-muted-foreground">
          Playwright-only engine policy per ADR-003 / D15. Puppeteer has been removed. Sessions use isolated browser
          contexts per run.
        </span>
        <span className="ml-auto flex items-center gap-2">
          {dirty ? (
            <Badge tone="warning" className="gap-1">
              <AlertCircle className="h-3 w-3" /> unsaved
            </Badge>
          ) : (
            <span className="flex items-center gap-1 text-emerald-600">
              <CheckCircle2 className="h-3 w-3" /> saved
            </span>
          )}
          <Badge tone="muted">{source}</Badge>
        </span>
      </div>

      {syncStatus ? (
        <div className="flex items-start gap-2 rounded-xl border border-border/60 bg-card px-3.5 py-3 text-[12px] text-muted-foreground">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Bridge {syncStatus.stale ? "looks stale — regenerate before the next session" : "is aligned with API settings"}.
            <span className="ml-1 font-mono text-[11px]">
              source: {syncStatus.active_runtime_source || "unknown"} · synced: {syncStatus.synced_at || "not recorded"}
            </span>
          </span>
        </div>
      ) : null}

      <FieldGroup
        title="Execution & Concurrency"
        description="How many pages run at once, how long launches may take, and which streaming policy applies."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Max parallel pages"
            type="number"
            min={1}
            max={16}
            step={1}
            value={maxParallelHostingPages}
            onChange={(e) => onMaxParallelChange(e.target.value)}
            error={maxParallelError}
            description="Maps to max_parallel_hosting_pages (1–16). Shared with Models → Runtime Controls."
          />
          <Input
            label="Launch timeout (ms)"
            type="number"
            min={5000}
            max={120000}
            step={1000}
            value={String(rt.launch_timeout_ms ?? "")}
            onChange={(e) => onRuntimeChange("launch_timeout_ms", Number.parseInt(e.target.value || "0", 10) || 0)}
            error={launchError}
            description="Maps to browser_runtime.playwright.launch_timeout_ms (5000–120000ms)."
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="Streaming safe mode"
            value={String(rt.streaming_safe_mode || "adaptive")}
            onChange={(v) => onRuntimeChange("streaming_safe_mode", v)}
            options={[
              { value: "adaptive", label: "Adaptive", description: "Safe mode for hosting, embedded, player-like pages." },
              { value: "strict", label: "Strict", description: "Always prefer the safer streaming policy." },
              { value: "off", label: "Off", description: "Keep the standard policy even on player pages." },
            ]}
          />
          <div className="space-y-1.5">
            <Textarea
              id="browser-extra-launch-args"
              name="browser.extra_launch_args"
              label="Extra launch args"
              value={toListText(rt.extra_launch_args)}
              onChange={(e) => onRuntimeListChange("extra_launch_args", e.target.value)}
              placeholder="--disable-dev-shm-usage, --lang=en-US"
              rows={2}
            />
            <p className="text-xs text-muted-foreground">Comma or newline separated Chromium flags. Keep minimal.</p>
          </div>
        </div>
      </FieldGroup>

      <FieldGroup
        title="Content & Ad Blocking"
        description="uBOL handling for standard pages, popup control, asset diagnostics, and allowlisted hosts."
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <ToggleRow
            label="uBOL adblocker"
            description="Load uBlock Origin Lite for standard pages. Player-like targets stand down automatically."
            checked={Boolean(rt.ubol_enabled)}
            onChange={(v) => onRuntimeChange("ubol_enabled", v)}
          />
          <ToggleRow
            label="Popup blocking"
            description="Block new tabs and window.open popups so agents stay on task."
            checked={Boolean(rt.popup_blocking_enabled)}
            onChange={(v) => onRuntimeChange("popup_blocking_enabled", v)}
          />
          <ToggleRow
            label="Asset diagnostics"
            description="Return script, stylesheet, and manifest failure summaries for blank renders."
            checked={Boolean(rt.asset_diagnostics_enabled)}
            onChange={(v) => onRuntimeChange("asset_diagnostics_enabled", v)}
          />
        </div>
        <div className="space-y-1.5">
          <Textarea
            id="browser-adblock-allowlist-hosts"
            name="browser.adblock_allowlist_hosts"
            label="Adblock allowlist hosts"
            value={toListText(rt.adblock_allowlist_hosts)}
            onChange={(e) => onRuntimeListChange("adblock_allowlist_hosts", e.target.value)}
            placeholder="example.com, cdn.example.com"
            rows={2}
          />
          <p className="text-xs text-muted-foreground">Comma or newline separated hostnames left alone by uBOL.</p>
        </div>
      </FieldGroup>

      <FieldGroup
        title="Media & Stream Extraction"
        description="Playback verification, capture windows, and last-resort CORS compatibility patches."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Media capture timeout (ms)"
            type="number"
            min={5000}
            max={120000}
            step={1000}
            value={String(rt.media_capture_timeout_ms ?? "")}
            onChange={(e) => onRuntimeChange("media_capture_timeout_ms", Number.parseInt(e.target.value || "0", 10) || 0)}
            error={mediaError}
            description="How long the runtime listens for HLS, DASH, and direct media requests."
          />
          <div className="flex items-end gap-2 pb-1 text-[12px] text-muted-foreground">
            <Globe className="h-3.5 w-3.5" />
            Capture covers HLS / DASH / progressive media requests.
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleRow
            label="Media playback verification"
            description="Wait for play/playing signals before reporting success."
            checked={Boolean(rt.media_playback_verification_enabled)}
            onChange={(v) => onRuntimeChange("media_playback_verification_enabled", v)}
          />
          <ToggleRow
            label="Media CORS patch"
            description="Collect cross-origin stream diagnostics for missing CORS headers."
            checked={Boolean(rt.media_cors_patch_enabled)}
            onChange={(v) => onRuntimeChange("media_cors_patch_enabled", v)}
          />
          <ToggleRow
            label="Stream CORS patch"
            description="Last-resort compatibility patch. Keep off unless diagnostics show a real stream-header issue."
            checked={Boolean(rt.stream_cors_patch_enabled)}
            onChange={(v) => onRuntimeChange("stream_cors_patch_enabled", v)}
          />
          <ToggleRow
            label="Stream CORS include credentials"
            description="Include credentials when the stream CORS patch is active."
            checked={Boolean(rt.stream_cors_include_credentials)}
            onChange={(v) => onRuntimeChange("stream_cors_include_credentials", v)}
          />
        </div>
      </FieldGroup>

      <FieldGroup
        title="Iframe & Sandbox Recovery"
        description="Recover cross-frame playback without over-correcting standard pages."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <ToggleRow
            label="Iframe auto-recovery"
            description="Retry iframe failures from sandbox, CORS-like blocking, and transient network errors."
            checked={Boolean(rt.iframe_auto_recovery_enabled)}
            onChange={(v) => onRuntimeChange("iframe_auto_recovery_enabled", v)}
          />
          <ToggleRow
            label="Iframe sandbox patch"
            description="Loosen player iframe sandbox restrictions that block playback."
            checked={Boolean(rt.iframe_sandbox_patch_enabled)}
            onChange={(v) => onRuntimeChange("iframe_sandbox_patch_enabled", v)}
          />
        </div>
        <div className="max-w-sm">
          <Input
            label="Iframe recovery timeout (ms)"
            type="number"
            min={5000}
            max={60000}
            step={1000}
            value={String(rt.iframe_recovery_timeout_ms ?? "")}
            onChange={(e) =>
              onRuntimeChange("iframe_recovery_timeout_ms", Number.parseInt(e.target.value || "0", 10) || 0)
            }
            error={iframeError}
            description="Max time for a recovery reload before reporting failure."
          />
        </div>
      </FieldGroup>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={onSave} disabled={Boolean(saving || !dirty || hasError)} variant="accent" className="min-w-[184px]">
          {saving ? "Saving…" : hasError ? "Fix validation" : dirty ? "Save browser settings" : "Saved"}
        </Button>
        {hasError ? (
          <span className="text-xs font-medium text-destructive">Fix validation errors before saving.</span>
        ) : !dirty ? (
          <span className="text-xs text-muted-foreground">All changes saved — badges reflect env &lt; base &lt; runtime.</span>
        ) : null}
      </div>
    </div>
  );
}
