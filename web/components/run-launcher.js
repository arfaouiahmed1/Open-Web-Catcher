"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Play,
  RefreshCw,
  Radio,
  Route,
  Waypoints,
  Workflow,
  X,
} from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import {
  formatBlockingReason,
  formatLaunchError,
  normalizeRuntimeStatus,
} from "@/lib/runtime-health";
import { statusLabel, statusTone } from "@/lib/run-status";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

// (RECENT_POLL_MS / HEALTH_POLL_MS removed — plan task 42: launcher data
    // refreshes on mount + tab focus, not on timers.)

const MODE_OPTIONS = [
  {
    value: "workflow",
    label: "Workflow",
    description: "Full pipeline: classify -> route -> parallel agent branches.",
    icon: Workflow,
  },
  {
    value: "agent",
    label: "Single agent",
    description: "Run one isolated agent directly.",
    icon: Bot,
  },
];

const AGENT_OPTIONS = [
  {
    value: "classification",
    label: "Classification",
    detail: "Route the page and reset context once classification finishes.",
    icon: Radio,
    color: "var(--sky)",
  },
  {
    value: "landing",
    label: "Landing",
    detail: "Inspect the landing-page branch without the full pipeline.",
    icon: Route,
    color: "var(--violet)",
  },
  {
    value: "hosting",
    label: "Hosting",
    detail: "Run hosting-page extraction directly, including parallel stream work.",
    icon: Waypoints,
    color: "var(--mint)",
  },
  {
    value: "embedded",
    label: "Embedded",
    detail: "Test the embedded-player path in isolation.",
    icon: Bot,
    color: "var(--signal)",
  },
];

const WORKFLOW_STAGES = [
  { label: "Classify", detail: "Read the page and route the workflow.", icon: Radio, color: "var(--sky)" },
  { label: "Route", detail: "Decide landing, hosting, or embedded follow-up.", icon: Route, color: "var(--violet)" },
  { label: "Parallelize", detail: "Landing, hosting, and embedded branches fan out in parallel.", icon: Waypoints, color: "var(--mint)" },
];

function isValidUrl(s) {
  try { new URL(s); return true; } catch { return false; }
}

function parseUrls(raw) {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function HealthPill({ healthy, label }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        healthy
          ? "border border-emerald-500/25 bg-emerald-500/10 text-emerald-600"
          : "border border-rose-500/25 bg-rose-500/10 text-rose-500",
      )}
    >
      {label}
    </span>
  );
}

function RuntimeStatusCard({ title, healthy, detail, note, badges = [] }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[12.5px] font-semibold text-foreground">{title}</div>
        <HealthPill healthy={healthy} label={healthy ? "ready" : "blocked"} />
      </div>
      <div className="mt-2 break-all font-mono text-[10.5px] text-muted-foreground">
        {detail}
      </div>
      {note ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">{note}</p>
      ) : null}
      {badges.length ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {badges.map((badge) => (
            <HealthPill key={badge.label} healthy={badge.healthy} label={badge.label} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RecentRunRow({ run }) {
  return (
    <div className="flex items-center gap-2.5 rounded-md px-3 py-2 text-[12px] transition-colors hover:bg-muted/40">
      <Badge tone={statusTone(run.final_status)} className="shrink-0 text-[10px] px-1.5 py-0">
        {statusLabel(run.final_status)}
      </Badge>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={run.url}>
        {run.url || run.run_id?.slice(0, 14)}
      </span>
      <Link href={`/runs/${run.run_id}`} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">
        <ExternalLink className="h-3.5 w-3.5" />
      </Link>
    </div>
  );
}

export function RunLauncher({ defaultMode = "workflow" }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initialMode = MODE_OPTIONS.some((o) => o.value === defaultMode) ? defaultMode : "workflow";
  const requestedMode = searchParams.get("mode");
  const mode = MODE_OPTIONS.some((o) => o.value === requestedMode) ? requestedMode : initialMode;

  const [agent, setAgent] = useState("classification");
  const [urlText, setUrlText] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [queued, setQueued] = useState(0);
  const [error, setError] = useState("");
  const [recentRuns, setRecentRuns] = useState([]);
  const [runtimeStatus, setRuntimeStatus] = useState(null);
  const [isLoadingRuntime, setIsLoadingRuntime] = useState(true);
  const [runtimeError, setRuntimeError] = useState("");
  const lastLaunchedIds = useRef([]);

  // Refresh recent runs (plan task 42): on mount + tab focus, no interval.
  useEffect(() => {
    let cancelled = false;
    function refresh() {
      apiFetch("/ui/runs?limit=8&offset=0")
        .then((payload) => {
          if (!cancelled) setRecentRuns(payload.rows || []);
        })
        .catch(() => {});
    }
    function onVisibility() {
      if (document.visibilityState === "visible") refresh();
    }
    refresh();
    document.addEventListener("visibilitychange", onVisibility);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVisibility); };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function refreshRuntimeStatus() {
      if (!cancelled) setIsLoadingRuntime(true);
      try {
        const payload = await apiFetch("/ui/browser/status");
        if (!cancelled) {
          setRuntimeStatus(normalizeRuntimeStatus(payload));
          setRuntimeError("");
        }
      } catch (nextError) {
        if (!cancelled) {
          setRuntimeError(nextError.message || "Failed to load runtime status");
        }
      } finally {
        if (!cancelled) setIsLoadingRuntime(false);
      }
    }

    refreshRuntimeStatus();
    // Plan task 42 (de-polling): health check on mount + tab focus only.
    function onHealthVisibility() {
      if (document.visibilityState === "visible") refreshRuntimeStatus();
    }
    document.addEventListener("visibilitychange", onHealthVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onHealthVisibility);
    };
  }, []);

  function setMode(next) {
    if (next === mode) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === initialMode) params.delete("mode");
    else params.set("mode", next);
    const q = params.toString();
    router.push(`${pathname}${q ? `?${q}` : ""}`, { scroll: false });
    setError("");
  }

  const urls = parseUrls(urlText);
  const validUrls = urls.filter(isValidUrl);
  const invalidUrls = urls.filter((u) => !isValidUrl(u));
  const launchReady = Boolean(runtimeStatus?.preflight?.launchReady);
  const blockingReasons = runtimeStatus?.preflight?.blockingReasons || [];
  const canSubmit = validUrls.length > 0 && !isStarting && launchReady;

  async function startRuns() {
    if (!validUrls.length || isStarting) return;
    if (!launchReady) {
      setError(
        blockingReasons.length
          ? blockingReasons.map(formatBlockingReason).join("\n\n")
          : "Runtime dependencies are not ready for a new run.",
      );
      return;
    }
    setIsStarting(true);
    setError("");
    setQueued(0);

    const endpoint = mode === "workflow" ? "/ui/workflows/run" : "/ui/agents/test";
    let launched = 0;
    const errors = [];
    const newIds = [];

    for (const u of validUrls) {
      try {
        const body = mode === "workflow" ? { url: u } : { agent, url: u };
        const res = await fetch(apiUrl(endpoint), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(formatLaunchError(payload?.detail, res.status));
        const runId = payload.run_id;
        if (!runId) throw new Error("Server did not return a run_id");
        newIds.push(runId);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("owc:track-run", { detail: { runId } }));
        }
        launched++;
      } catch (e) {
        errors.push(`${u}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    lastLaunchedIds.current = newIds;
    setIsStarting(false);
    setQueued(launched);

    if (errors.length) {
      setError(errors.join("\n"));
    } else {
      // Single run -> navigate; batch -> stay and show status
      if (newIds.length === 1) {
        router.push(`/runs/${newIds[0]}`);
      } else {
        setUrlText("");
        setTimeout(() => setQueued(0), 6000);
      }
    }
  }

  async function refreshRuntimeStatusNow() {
    setIsLoadingRuntime(true);
    try {
      const payload = await apiFetch("/ui/browser/status");
      setRuntimeStatus(normalizeRuntimeStatus(payload));
      setRuntimeError("");
    } catch (nextError) {
      setRuntimeError(nextError.message || "Failed to load runtime status");
    } finally {
      setIsLoadingRuntime(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Live runs</h1>
        <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
          Submit one URL or paste many (one per line) to queue a batch. Single runs navigate directly to the live trace view.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_320px]">
        {/* Config panel */}
        <Card>
          <CardHeader className="space-y-3 border-b pb-4">
            <Tabs value={mode} onValueChange={(v) => { setMode(v); setError(""); }}>
              <TabsList>
                {MODE_OPTIONS.map((opt) => {
                  const Icon = opt.icon;
                  return (
                    <TabsTrigger key={opt.value} value={opt.value} className="gap-1.5">
                      <Icon className="h-3.5 w-3.5" />
                      {opt.label}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
            <CardDescription className="text-sm">
              {mode === "workflow"
                ? "One URL in, full pipeline out - classify, route, and parallelize."
                : "Pick an agent below and run it in isolation against a single URL."}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-5 pt-5">
            {/* Agent selector */}
            {mode === "agent" && (
              <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Agent
                </Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {AGENT_OPTIONS.map((opt) => {
                    const active = agent === opt.value;
                    const Icon = opt.icon;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => { setAgent(opt.value); setError(""); }}
                        className={cn(
                          "group rounded-lg border p-3.5 text-left transition-all",
                          active
                            ? "bg-card ring-1"
                            : "bg-card hover:bg-muted/40",
                        )}
                        style={
                          active
                            ? {
                                borderColor: `color-mix(in oklch, ${opt.color} 50%, transparent)`,
                                boxShadow: `0 0 0 1px color-mix(in oklch, ${opt.color} 30%, transparent)`,
                              }
                            : undefined
                        }
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors"
                            style={{
                              background: active
                                ? `color-mix(in oklch, ${opt.color} 18%, transparent)`
                                : "var(--muted)",
                              color: active ? opt.color : "var(--muted-foreground)",
                            }}
                          >
                            <Icon className="h-3.5 w-3.5" />
                          </span>
                          <span
                            className="text-[13px] font-semibold"
                            style={{ color: active ? opt.color : undefined }}
                          >
                            {opt.label}
                          </span>
                        </div>
                        <p className="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
                          {opt.detail}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Workflow stage strip */}
            {mode === "workflow" && (
              <div className="grid gap-2 sm:grid-cols-3">
                {WORKFLOW_STAGES.map((stage) => {
                  const Icon = stage.icon;
                  return (
                    <div key={stage.label} className="rounded-lg border bg-card p-3">
                      <div className="flex items-center gap-2">
                        <span
                          className="flex h-7 w-7 items-center justify-center rounded-md"
                          style={{
                            background: `color-mix(in oklch, ${stage.color} 14%, transparent)`,
                            color: stage.color,
                          }}
                        >
                          <Icon className="h-3.5 w-3.5" />
                        </span>
                        <span className="text-[12.5px] font-semibold text-foreground">{stage.label}</span>
                      </div>
                      <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                        {stage.detail}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Runtime preflight
                  </Label>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                    Submission is blocked until Docker browser, MCP, and required tool profiles are all ready.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={refreshRuntimeStatusNow}
                  disabled={isLoadingRuntime}
                >
                  {isLoadingRuntime ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Refresh status
                </Button>
              </div>

              {runtimeError ? (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2.5 text-sm text-destructive">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                  <pre className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-xs">{runtimeError}</pre>
                </div>
              ) : null}

              {runtimeStatus ? (
                <>
                  <div className="grid gap-3 lg:grid-cols-3">
                    <RuntimeStatusCard
                      title="Browser"
                      healthy={runtimeStatus.summary.browserHealthy}
                      detail={runtimeStatus.browser.probe_url || runtimeStatus.browser.configured_ws_endpoint || "No browser endpoint configured"}
                      note={runtimeStatus.browser.error || runtimeStatus.browser.browser || ""}
                    />
                    <RuntimeStatusCard
                      title="MCP"
                      healthy={runtimeStatus.summary.mcpHealthy}
                      detail={runtimeStatus.mcp.probe_url || "No MCP endpoint configured"}
                      note={runtimeStatus.mcp.error || `profiles=${(runtimeStatus.mcp.profiles || []).join(", ") || "none"}`}
                    />
                    <RuntimeStatusCard
                      title="Tool profiles"
                      healthy={runtimeStatus.summary.profilesHealthy}
                      detail="classification, landing, hosting, embedded"
                      badges={runtimeStatus.preflight.profiles.map((row) => ({
                        label: row.profile,
                        healthy: row.healthy,
                      }))}
                    />
                  </div>

                  {!runtimeStatus.preflight.launchReady ? (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <pre className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-xs">
                        {blockingReasons.map(formatBlockingReason).join("\n\n")}
                      </pre>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-3 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading runtime status
                </div>
              )}
            </div>

            {/* URL input */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Target URL{urls.length > 1 ? "s" : ""}
                </Label>
                {urls.length > 1 && (
                  <span className="text-[10.5px] text-muted-foreground">
                    {validUrls.length} valid | {invalidUrls.length} invalid
                  </span>
                )}
              </div>
              <Textarea
                value={urlText}
                onChange={(e) => { setUrlText(e.target.value); setError(""); setQueued(0); }}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter submits
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startRuns();
                }}
                placeholder={"https://example.com/watch/123\nhttps://example.com/watch/456"}
                rows={urls.length > 1 ? Math.min(urls.length + 1, 6) : 2}
                className="resize-none font-mono text-xs"
              />
              {invalidUrls.length > 0 && (
                <p className="text-[11px] text-rose-500">
                  Invalid: {invalidUrls.join(", ")}
                </p>
              )}
              <p className="text-[10.5px] text-muted-foreground">
                One URL per line for batch runs. Press Cmd/Ctrl+Enter to submit.
              </p>
              {!launchReady && runtimeStatus ? (
                <p className="text-[11px] text-amber-700">
                  Launching is disabled until the runtime preflight is ready.
                </p>
              ) : null}
            </div>

            {/* Actions */}
            <div className="flex items-center gap-2">
              <Button
                variant="accent"
                onClick={startRuns}
                disabled={!canSubmit}
                className="min-w-[150px] justify-center"
              >
                {isStarting ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <Play className="mr-1.5 h-4 w-4" />
                )}
                {isStarting
                  ? `Launching ${validUrls.length}...`
                  : validUrls.length > 1
                    ? `Run ${validUrls.length} URLs`
                    : mode === "workflow"
                      ? "Run pipeline"
                      : "Run agent"}
              </Button>
              {urlText && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => { setUrlText(""); setError(""); setQueued(0); }}
                >
                  <X className="mr-1 h-3.5 w-3.5" />
                  Clear
                </Button>
              )}
            </div>

            {/* Success banner */}
            {queued > 0 && !error && (
              <div className="flex items-center gap-2 rounded-lg border border-mint/30 bg-mint/8 px-3 py-2.5 text-sm">
                <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: "var(--mint)" }} />
                <span style={{ color: "var(--mint)" }}>
                  {queued} run{queued !== 1 ? "s" : ""} queued successfully
                </span>
                <Link href="/runs" className="ml-auto text-xs underline" style={{ color: "var(--mint)" }}>
                  View all
                </Link>
              </div>
            )}

            {/* Error */}
            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2.5 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <pre className="min-w-0 flex-1 whitespace-pre-wrap font-mono text-xs">{error}</pre>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent runs panel */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm">Recent runs</CardTitle>
              <Link
                href="/runs"
                className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              >
                View all
              </Link>
            </div>
            <CardDescription className="text-[11.5px]">
              Live-updating list of the latest 8 runs.
            </CardDescription>
          </CardHeader>
          <CardContent className="px-2 pb-3 pt-0">
            {recentRuns.length ? (
              <div className="space-y-0.5">
                {recentRuns.map((run) => (
                  <RecentRunRow key={run.run_id} run={run} />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2 py-8 text-center">
                <Play className="h-6 w-6 text-muted-foreground/30" />
                <p className="text-xs text-muted-foreground">No runs yet - start one!</p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
