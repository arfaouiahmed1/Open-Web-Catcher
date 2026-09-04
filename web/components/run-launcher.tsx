"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Fingerprint,
  FlaskConical,
  Loader2,
  Play,
  RefreshCw,
  Radio,
  Route,
  ShieldCheck,
  SlidersHorizontal,
  Waypoints,
  Workflow,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { formatBlockingReason, normalizeRuntimeStatus } from "@/lib/runtime-health";
import { statusLabel, statusTone } from "@/lib/run-status";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/console/common/page-header";
import { LoadingView } from "@/components/console/common/loading-view";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

// Typed contracts — keep runtime behavior identical to original JS
export type LauncherMode = "workflow" | "agent";
export interface RunLauncherProps { defaultMode?: LauncherMode; }
interface RuntimeStatus { summary: { browserHealthy: boolean; mcpHealthy: boolean; profilesHealthy: boolean }; browser: { probe_url?: string; configured_ws_endpoint?: string; error?: string; browser?: string }; mcp: { probe_url?: string; error?: string; profiles?: string[] }; preflight: { launchReady: boolean; profiles: Array<{ profile: string; healthy: boolean }>; blocking_reasons?: unknown[] }; }
interface RecentRun { run_id: string; url?: string; final_status?: string; }

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

const WORKFLOW_PIPELINE_STAGES = [
  {
    id: "classification",
    step: "Stage 1",
    label: "Classification & Ingestion",
    detail: "Target URL analysis, DOM inspection, and page-type decision.",
    icon: Fingerprint,
    color: "var(--sky)",
    agents: ["classification"],
    role: "Classification reads the target page, inspects the DOM, and decides whether it is a landing, hosting, or embedded page — with confidence.",
    tools: ["navigate", "inspect", "screenshot"],
    artifacts: "page_type decision + confidence score, DOM evidence snapshot",
    model: "Global default (Settings → Models → classification slot)",
  },
  {
    id: "orchestration",
    step: "Stage 2",
    label: "Orchestration & Routing",
    detail: "Context evaluation, agent assignment, and fanout strategy.",
    icon: Route,
    color: "var(--violet)",
    agents: ["orchestrator"],
    role: "Orchestrator evaluates classification context, assigns landing / hosting / embedded agents, and plans the parallel fanout.",
    tools: ["plan", "memory_search"],
    artifacts: "Fanout plan: assigned agents and per-branch budgets",
    model: "Global default (Settings → Models → orchestrator slot)",
  },
  {
    id: "extraction",
    step: "Stage 3",
    label: "Parallel Agent Extraction",
    detail: "Landing-match discovery, hosting stream probing, embedded sandbox bypass.",
    icon: Waypoints,
    color: "var(--mint)",
    agents: ["landing", "hosting", "embedded"],
    role: "Landing discovers matches, hosting probes stream players across parallel pages, and embedded bypasses sandboxed iframes — all concurrently.",
    tools: ["navigate", "inspect", "interact", "harvest", "screenshot", "wait"],
    artifacts: "Candidate stream URLs (HLS / DASH / MP4) plus player metadata",
    model: "Per-agent slots (inherit the global default unless overridden)",
  },
  {
    id: "validation",
    step: "Stage 4",
    label: "Validation & Machine Evidence",
    detail: "Stream URL verification, playback confirmation, blobref evidence tokens.",
    icon: ShieldCheck,
    color: "var(--signal)",
    agents: ["orchestrator"],
    role: "Validator pass confirms every stream URL is reachable and playable, then mints local blobref evidence tokens for the payload.",
    tools: ["harvest", "inspect"],
    artifacts: "Verified playable streams, playback confirmations, blobref evidence tokens",
    model: "Global default (Settings → Models → orchestrator slot)",
  },
];

const WORKFLOW_PRESETS = [
  {
    label: "Live Sports Portal",
    url: "https://freeshot.live/live-tv",
    hint: "Channel listing with pagination",
  },
  {
    label: "Streaming Schedule",
    url: "https://streamed.pk/",
    hint: "Live vs scheduled card separation",
  },
  {
    label: "Embedded Player Test",
    url: "https://freeshot.live/live-tv/espn-arg/871",
    hint: "Direct match page with embed slot",
  },
  {
    label: "Sandboxed Iframe Test",
    url: "https://streamed.pk/category/cricket",
    hint: "Category page with iframe players",
  },
];

const MODEL_OVERRIDE_OPTIONS = [
  { value: "default", label: "Global Default", hint: "Whatever Settings → Models defines" },
  { value: "high-speed", label: "High-Speed", hint: "Fast, cheaper lane when available" },
  { value: "experimental", label: "Experimental", hint: "Bleeding-edge lane when available" },
];


function isValidUrl(s: string): boolean {
  try { new URL(s); return true; } catch { return false; }
}

function parseUrls(raw: string): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function readRunId(payload: unknown): string {
  if (payload && typeof payload === "object" && "run_id" in payload) {
    const runId = payload.run_id;
    if (typeof runId === "string" && runId) return runId;
  }
  return "";
}

function HealthPill({ healthy, label }: { healthy: boolean; label: string }): React.JSX.Element {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        healthy
          ? "border-[color-mix(in_oklch,var(--mint)_28%,transparent)] bg-[color-mix(in_oklch,var(--mint)_12%,transparent)] text-[var(--mint-text)]"
          : "border-[color-mix(in_oklch,var(--rose)_28%,transparent)] bg-[color-mix(in_oklch,var(--rose)_12%,transparent)] text-[var(--rose-text)]",
      )}
    >
      {label}
    </span>
  );
}

function RuntimeStatusCard({ title, healthy, detail, note, badges = [] }: { title: string; healthy: boolean; detail: string; note?: string; badges?: Array<{ label: string; healthy: boolean }> }): React.JSX.Element {
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

function RecentRunRow({ run }: { run: RecentRun }): React.JSX.Element {
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

export function RunLauncher({ defaultMode = "workflow" }: RunLauncherProps): React.JSX.Element {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initialMode = MODE_OPTIONS.some((o) => o.value === defaultMode) ? defaultMode : "workflow";
  const requestedMode = searchParams.get("mode");
  const mode = (MODE_OPTIONS.some((o) => o.value === requestedMode) ? requestedMode : initialMode) as string;

  const [agent, setAgent] = useState<string>("classification");
  const [urlText, setUrlText] = useState<string>("");
  const [isStarting, setIsStarting] = useState<boolean>(false);
  const [queued, setQueued] = useState<number>(0);
  const [error, setError] = useState<string>("");
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [isLoadingRecentRuns, setIsLoadingRecentRuns] = useState<boolean>(true);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const [isLoadingRuntime, setIsLoadingRuntime] = useState<boolean>(true);
  const [runtimeError, setRuntimeError] = useState<string>("");
  const lastLaunchedIds = useRef<string[]>([]);
  // Workflow-mode workspace state: interactive pipeline canvas, advanced options, launch handoff.
  const [selectedStageId, setSelectedStageId] = useState<string>("classification");
  const [modelOverride, setModelOverride] = useState<string>("default");
  const [concurrency, setConcurrency] = useState<number>(4);
  const [runTag, setRunTag] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [launchedIds, setLaunchedIds] = useState<string[]>([]);
  const [handoffRunId, setHandoffRunId] = useState<string>("");

  const selectedStage = WORKFLOW_PIPELINE_STAGES.find((stage) => stage.id === selectedStageId)
    ?? WORKFLOW_PIPELINE_STAGES[0];

  function applyPreset(url: string) {
    setUrlText(url);
    setError("");
    setQueued(0);
    setLaunchedIds([]);
    setHandoffRunId("");
  }

  // Refresh recent runs (plan task 42): on mount + tab focus, no interval.
  useEffect(() => {
    let cancelled = false;
    function refresh() {
      setIsLoadingRecentRuns(true);
      apiFetch("/ui/runs?limit=8&offset=0")
        .then((payload) => {
          if (!cancelled) setRecentRuns(((payload as unknown as { rows?: RecentRun[] }).rows ?? []) as RecentRun[]);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setIsLoadingRecentRuns(false);
        });
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
          setRuntimeStatus(normalizeRuntimeStatus(payload as unknown as never));
          setRuntimeError("");
        }
      } catch (nextError: unknown) {
        if (!cancelled) {
          setRuntimeError((nextError as Error).message || "Failed to load runtime status");
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

  function setMode(next: string) {
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
  const blocking_reasons = (runtimeStatus?.preflight as unknown as { blockingReasons?: unknown[]; blocking_reasons?: unknown[] })?.blockingReasons ?? (runtimeStatus?.preflight as unknown as { blocking_reasons?: unknown[] })?.blocking_reasons ?? [];
  const canSubmit = validUrls.length > 0 && !isStarting && launchReady;

  async function startRuns() {
    if (!validUrls.length || isStarting) return;
    if (!launchReady) {
      setError(
        blocking_reasons.length
          ? (blocking_reasons as unknown as Array<never>).map(formatBlockingReason as unknown as (v: unknown)=>string).join("\n\n")
          : "Runtime dependencies are not ready for a new run.",
      );
      return;
    }
    setIsStarting(true);
    setError("");
    setQueued(0);
    setLaunchedIds([]);
    setHandoffRunId("");

    const endpoint = mode === "workflow" ? "/ui/workflows/run" : "/ui/agents/test";
    let launched = 0;
    const errors = [];
    const newIds = [];

    for (const u of validUrls) {
      try {
        // Launch contracts are strict (extra fields are rejected): workflow posts
        // { url }, single-agent posts { agent, url }. Advanced options stay
        // operator-side staging and never enter the request payload.
        const body = mode === "workflow" ? { url: u } : { agent, url: u };
        const payload = await apiFetch(endpoint, {
          method: "POST",
          body: JSON.stringify(body),
        });
        const runId = readRunId(payload);
        if (!runId) throw new Error("Server did not return a run_id");
        newIds.push(runId);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("owc:run-state-changed", { detail: { runId } }));
        }
        launched++;
      } catch (e: unknown) {
        errors.push(`${u}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    lastLaunchedIds.current = newIds as unknown as never[];
    setIsStarting(false);
    setQueued(launched);
    setLaunchedIds(newIds);

    if (errors.length) {
      setError(errors.join("\n"));
    } else {
      // Single run -> brief handoff banner, then navigate to the live trace;
      // batch -> stay, clear input, and show queue position below.
      if (newIds.length === 1) {
        setHandoffRunId(newIds[0]);
        const target = newIds[0];
        window.setTimeout(() => {
          router.push(`/runs/${target}`);
        }, 600);
      } else if (newIds.length > 1) {
        setUrlText("");
        setTimeout(() => setQueued(0), 9000);
      }
    }
  }

  async function refreshRuntimeStatusNow() {
    setIsLoadingRuntime(true);
    try {
      const payload = await apiFetch("/ui/browser/status");
      setRuntimeStatus(normalizeRuntimeStatus(payload as unknown as never));
      setRuntimeError("");
    } catch (nextError: unknown) {
      setRuntimeError((nextError as Error).message || "Failed to load runtime status");
    } finally {
      setIsLoadingRuntime(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="execution"
        title="Live runs"
        description="Submit one URL or paste many (one per line) to queue a batch. Single runs navigate directly to the live trace view."
        icon={<Play className="h-5 w-5" />}
      />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_320px]">
        {/* Config panel */}
        <Card>
          <CardHeader className="space-y-3 border-b pb-4">
            <Tabs value={mode as string} onValueChange={(v: string) => { setMode(v); setError(""); }}>
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

            {/* Workflow workspace: presets, interactive pipeline canvas, advanced options */}
            {mode === "workflow" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Quick-start presets
                  </Label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {WORKFLOW_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => applyPreset(preset.url)}
                        className="group rounded-lg border bg-card p-3 text-left transition-all hover:bg-muted/40"
                        title={`Load ${preset.url}`}
                      >
                        <div className="flex items-center gap-2">
                          <FlaskConical className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                          <span className="text-[12.5px] font-semibold text-foreground">{preset.label}</span>
                        </div>
                        <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">{preset.hint}</p>
                        <p className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground/80" title={preset.url}>
                          {preset.url}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Pipeline canvas — select a stage to inspect it
                  </Label>
                  <ol className="grid gap-2 lg:grid-cols-4">
                    {WORKFLOW_PIPELINE_STAGES.map((stage, index) => {
                      const Icon = stage.icon;
                      const active = selectedStage.id === stage.id;
                      return (
                        <li key={stage.id} className="relative">
                          <button
                            type="button"
                            onClick={() => setSelectedStageId(stage.id)}
                            aria-pressed={active}
                            className={cn(
                              "w-full rounded-lg border bg-card p-3 text-left transition-all hover:bg-muted/40",
                              active && "bg-card ring-1",
                            )}
                            style={
                              active
                                ? {
                                    borderColor: `color-mix(in oklch, ${stage.color} 50%, transparent)`,
                                    boxShadow: `0 0 0 1px color-mix(in oklch, ${stage.color} 30%, transparent)`,
                                  }
                                : undefined
                            }
                          >
                            <div className="flex items-center gap-2">
                              <span
                                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                                style={{
                                  background: `color-mix(in oklch, ${stage.color} 14%, transparent)`,
                                  color: stage.color,
                                }}
                              >
                                <Icon className="h-3.5 w-3.5" />
                              </span>
                              <span className="text-[10.5px] font-semibold uppercase tracking-wide text-muted-foreground">
                                {stage.step}
                              </span>
                            </div>
                            <div className="mt-2 text-[12.5px] font-semibold text-foreground">{stage.label}</div>
                            <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                              {stage.detail}
                            </p>
                          </button>
                          {index < WORKFLOW_PIPELINE_STAGES.length - 1 ? (
                            <ChevronRight className="absolute -right-2.5 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 rounded-full border bg-background text-muted-foreground lg:block" />
                          ) : null}
                        </li>
                      );
                    })}
                  </ol>
                  <div className="rounded-lg border bg-muted/20 p-3.5" aria-live="polite">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className="flex h-7 w-7 items-center justify-center rounded-md"
                        style={{
                          background: `color-mix(in oklch, ${selectedStage.color} 14%, transparent)`,
                          color: selectedStage.color,
                        }}
                      >
                        <selectedStage.icon className="h-3.5 w-3.5" />
                      </span>
                      <span className="text-[13px] font-semibold text-foreground">
                        {selectedStage.step}: {selectedStage.label}
                      </span>
                      {selectedStage.agents.map((agentName) => (
                        <Badge key={agentName} tone="muted" className="font-mono text-[10px]">
                          {agentName}
                        </Badge>
                      ))}
                    </div>
                    <p className="mt-2 text-[12px] leading-relaxed text-muted-foreground">{selectedStage.role}</p>
                    <dl className="mt-3 grid gap-2 text-[11.5px] sm:grid-cols-3">
                      <div className="rounded-md border bg-card px-2.5 py-2">
                        <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">MCP tools</dt>
                        <dd className="mt-1 font-mono text-[11px] leading-relaxed text-foreground">
                          {selectedStage.tools.join(" · ")}
                        </dd>
                      </div>
                      <div className="rounded-md border bg-card px-2.5 py-2">
                        <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Artifacts</dt>
                        <dd className="mt-1 leading-relaxed text-foreground">{selectedStage.artifacts}</dd>
                      </div>
                      <div className="rounded-md border bg-card px-2.5 py-2">
                        <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Model</dt>
                        <dd className="mt-1 leading-relaxed text-foreground">{selectedStage.model}</dd>
                      </div>
                    </dl>
                  </div>
                </div>

                <div className="overflow-hidden rounded-lg border">
                  <button
                    type="button"
                    onClick={() => setShowAdvanced((value) => !value)}
                    aria-expanded={showAdvanced}
                    className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-muted/40"
                  >
                    <SlidersHorizontal className="h-4 w-4 text-muted-foreground" />
                    <span className="text-[13px] font-semibold text-foreground">Advanced run options</span>
                    <span className="hidden text-[11px] text-muted-foreground sm:inline">Model lane · concurrency · tag</span>
                    <ChevronDown
                      className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", showAdvanced && "rotate-180")}
                    />
                  </button>
                  {showAdvanced ? (
                    <div className="space-y-4 border-t px-3.5 py-3.5">
                      <div className="space-y-2">
                        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Model lane
                        </Label>
                        <div className="grid gap-2 sm:grid-cols-3">
                          {MODEL_OVERRIDE_OPTIONS.map((option) => {
                            const active = modelOverride === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => setModelOverride(option.value)}
                                aria-pressed={active}
                                className={cn(
                                  "rounded-lg border bg-card p-2.5 text-left transition-all hover:bg-muted/40",
                                  active && "border-primary/50 ring-1 ring-primary/30",
                                )}
                              >
                                <div className="text-[12.5px] font-semibold text-foreground">{option.label}</div>
                                <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{option.hint}</div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label
                            htmlFor="workflow-concurrency"
                            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Concurrency budget · {concurrency} page{concurrency === 1 ? "" : "s"}
                          </Label>
                          <input
                            id="workflow-concurrency"
                            type="range"
                            min={1}
                            max={10}
                            step={1}
                            value={concurrency}
                            onChange={(event) => setConcurrency(Number(event.target.value))}
                            className="w-full accent-primary"
                          />
                          <div className="flex justify-between text-[10.5px] text-muted-foreground">
                            <span>1 page</span>
                            <span>10 pages</span>
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label
                            htmlFor="workflow-tag"
                            className="text-xs font-semibold uppercase tracking-wider text-muted-foreground"
                          >
                            Run tag
                          </Label>
                          <Input
                            id="workflow-tag"
                            value={runTag}
                            onChange={(event) => setRunTag(event.target.value)}
                            placeholder="e.g. nightly-sports-sweep"
                            className="h-9 font-mono text-xs"
                          />
                          <p className="text-[10.5px] text-muted-foreground">Label for grouping this launch in your notes.</p>
                        </div>
                      </div>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        The workflow launch API accepts the target URL today — lane, concurrency, and tag are
                        staged operator-side and do not change the request payload.
                      </p>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Live preflight
                  </Label>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">
                    Submission is blocked until the Playwright browser driver, MCP server, and required tool profiles are all ready.
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
                  Re-check preflight
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
                        {(blocking_reasons as unknown as Array<never>).map(formatBlockingReason as unknown as (v: unknown)=>string).join("\n\n")}
                      </pre>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="grid gap-3 lg:grid-cols-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="rounded-lg border bg-card px-3 py-3 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <Skeleton className="h-4 w-20" />
                        <Skeleton className="h-5 w-12 rounded-full" />
                      </div>
                      <Skeleton className="h-3 w-full" />
                      <Skeleton className="h-3 w-3/4" />
                    </div>
                  ))}
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
                onChange={(e) => { setUrlText(e.target.value); setError(""); setQueued(0); setLaunchedIds([]); setHandoffRunId(""); }}
                onKeyDown={(e) => {
                  // Cmd/Ctrl+Enter submits
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) startRuns();
                }}
                placeholder={"https://example.com/watch/123\nhttps://example.com/watch/456"}
                rows={urls.length > 1 ? Math.min(urls.length + 1, 6) : 2}
                className="resize-none font-mono text-xs"
              />
              {invalidUrls.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="inline-flex items-center gap-1 text-[11px] text-[var(--rose-text)]">
                    <AlertTriangle className="h-3 w-3" /> Invalid:
                  </span>
                  {invalidUrls.map((u) => (
                    <Badge key={u} tone="danger" className="font-mono text-[10px] max-w-[260px] truncate" title={u}>
                      {u}
                    </Badge>
                  ))}
                </div>
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
                  onClick={() => { setUrlText(""); setError(""); setQueued(0); setLaunchedIds([]); setHandoffRunId(""); }}
                >
                  <X className="mr-1 h-3.5 w-3.5" />
                  Clear
                </Button>
              )}
            </div>

            {/* Handoff banner: single run started, navigating to the live trace */}
            {handoffRunId && !error && (
              <div className="flex items-center gap-2 rounded-lg border border-mint/30 bg-mint/8 px-3 py-2.5 text-sm animate-pulse">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin" style={{ color: "var(--mint)" }} />
                <span style={{ color: "var(--mint)" }}>
                  Run started — opening live trace{" "}
                  <span className="font-mono text-xs">{handoffRunId.slice(0, 8)}…</span>
                </span>
                <Link href={`/runs/${handoffRunId}`} className="ml-auto text-xs underline" style={{ color: "var(--mint)" }}>
                  Open now
                </Link>
              </div>
            )}

            {/* Queue banner: batch launch position with direct run links */}
            {queued > 0 && !error && !handoffRunId && (
              <div className="space-y-2 rounded-lg border border-mint/30 bg-mint/8 px-3 py-2.5 text-sm">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 shrink-0" style={{ color: "var(--mint)" }} />
                  <span style={{ color: "var(--mint)" }}>
                    {queued} run{queued !== 1 ? "s" : ""} queued successfully
                  </span>
                  <Link href="/runs" className="ml-auto text-xs underline" style={{ color: "var(--mint)" }}>
                    View all
                  </Link>
                </div>
                {launchedIds.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {launchedIds.slice(0, 5).map((runId, index) => (
                      <Link
                        key={runId}
                        href={`/runs/${runId}`}
                        className="rounded-md border border-mint/30 px-2 py-0.5 font-mono text-[10.5px] hover:bg-mint/10"
                        style={{ color: "var(--mint)" }}
                        title={runId}
                      >
                        #{index + 1} · {runId.slice(0, 8)}
                      </Link>
                    ))}
                    {launchedIds.length > 5 ? (
                      <span className="px-1 py-0.5 text-[10.5px]" style={{ color: "var(--mint)" }}>
                        +{launchedIds.length - 5} more
                      </span>
                    ) : null}
                  </div>
                ) : null}
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
            {isLoadingRecentRuns ? (
              <LoadingView label="Loading recent runs…" variant="shimmer" rows={2} className="px-2" />
            ) : recentRuns.length ? (
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
