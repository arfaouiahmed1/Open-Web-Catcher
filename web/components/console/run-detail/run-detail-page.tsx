/* eslint-disable */
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, Check, Copy, ExternalLink, MoreHorizontal, RefreshCw, RotateCcw, Trash2, XCircle } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { useRunStream } from "@/lib/use-run-stream";
import { buildLlmRows } from "@/lib/llm-output-rows";
import { getContextWindow, loadPricing, peakContextUsage } from "@/lib/pricing";
import { formatCurrency, formatNumber } from "@/lib/utils";
import {
  resolveRunCost,
  resolveRunToolCallCount,
  runCostDetail,
  runCostSourceLabel,
} from "@/lib/run-detail-helpers";
import { useRunViewSettings, type RunViewSettings } from "@/components/run-view-settings";
import { BrowserLiveView } from "@/components/console/run-detail/browser-live-view";
import {
  canCancelRun,
  canDeleteRun,
  statusLabel,
  statusTone as runStatusTone,
} from "@/lib/run-status";
import { actorToStage, getRunTerminalState, normalizeTraceEvents, STAGE_LABELS } from "@/lib/run-trace";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RunTimelineTab } from "@/components/console/run-detail/tabs/run-timeline-tab";
import { RunEventFeedTab } from "@/components/console/run-detail/tabs/event-feed-tab";
import { ReasoningTraceTab } from "@/components/console/run-detail/tabs/reasoning-trace-tab";
import { CostMeterTab } from "@/components/console/run-detail/tabs/cost-meter-tab";
import { ScreenshotGridTab } from "@/components/console/run-detail/tabs/screenshot-grid-tab";
import { StreamProviderTab } from "@/components/console/run-detail/stream-provider-tab";
import { AgentOutputTab } from "@/components/console/run-detail/agent-output-tab";
import { AgentRunGraph } from "@/components/console/run-detail/agent-run-graph";
import { AgentPlanBoard } from "@/components/console/run-detail/agent-plan-board";
import { ContextWindowMonitor } from "@/components/console/run-detail/context-window-monitor";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmAction } from "@/components/console/common/confirm-action";
import {
  collectScreenshotUrls,
  extractLlmResponses,
} from "@/lib/run-trace";
import { collectRunProviderUrls } from "@/lib/run-log-sync";
import { formatDate, formatTime, formatTimestamp, parseTimestamp } from "@/lib/datetime";

const EMPTY_OBJECT = {};
const EMPTY_ARRAY: any[] = [];
const FAILURE_EVENT_KINDS = new Set(["llm_error", "llm_timeout", "llm_rate_limited", "pipeline_failed"]);
const FAILURE_STATUSES = new Set([
  "failed",
  "timeout",
  "site_dead",
  "page_inaccessible",
  "no_hosting_pages",
  "no_streams",
]);

function firstNonEmptyArray(...values: any[]) {
  const nonEmpty = values.find((value) => Array.isArray(value) && value.length > 0);
  if (nonEmpty) return nonEmpty;
  return values.find((value) => Array.isArray(value)) || EMPTY_ARRAY;
}

function fmt(ts: any) {
  if (!ts) return "--";
  try {
    return formatTimestamp(ts) || String(ts);
  } catch {
    return ts;
  }
}

function dur(seconds: any) {
  const value = Number(seconds || 0);
  if (!value) return "--";
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`;
}

function normalizeRunDetailError(message: any) {
  let text = String(message || "").trim();
  if (text.startsWith("{")) {
    try {
      const payload = JSON.parse(text);
      if (payload?.detail) text = String(payload.detail).trim();
    } catch {
      // Keep the original message when the body is not valid JSON.
    }
  }
  if (!text) return "Run data is unavailable right now.";
  if (text.includes("404") || /not found/i.test(text)) return "Run not found in this environment.";
  if (/failed to fetch/i.test(text)) return "Run data is unavailable right now.";
  return text;
}

function parseHostLabel(url: any) {
  const value = String(url || "").trim();
  if (!value) return "Run detail";
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

function cleanInlineText(value: any) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeFailurePreview(value: any) {
  const raw = cleanInlineText(value);
  if (!raw) return "";
  if (/503\s+service\s+unavailable/i.test(raw) && /high demand/i.test(raw)) {
    return "503 Service Unavailable. Gemini was unavailable due to high demand.";
  }
  if (/503\s+service\s+unavailable/i.test(raw)) {
    return "503 Service Unavailable.";
  }
  const trimmed =
    raw
      .replace(/^Model call failed:\s*/i, "")
      .replace(/^Classification failed:\s*/i, "")
      .trim() || raw;
  const braceIndex = trimmed.indexOf("{");
  if (braceIndex > 0) return trimmed.slice(0, braceIndex).trim();
  return trimmed;
}

function stageLabel(stage: any) {
  // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
  return STAGE_LABELS[stage] || stage || "--";
}

function getRunMode(jobState: any) {
  return String(jobState?.job_type || "").toLowerCase() === "workflow" ? "workflow run" : "agent run";
}

function isFailureStatus(status: any) {
  return FAILURE_STATUSES.has(String(status || "").trim().toLowerCase());
}

function HeroMetric({  label, value, description, emphasis = "var(--ink)"  }: any) {
  return (
    <div
      className="rounded-[16px] border px-3 py-3"
      style={{
        borderColor: "var(--line)",
        background: "color-mix(in oklch, var(--card) 94%, transparent)",
      }}
    >
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--mute-3)" }}>
        {label}
      </div>
      <div className="mt-1 text-[17px] font-semibold leading-tight" style={{ color: emphasis }}>
        {value}
      </div>
      {description ? (
        <div className="mt-1 text-[11px] leading-snug" style={{ color: "var(--mute)" }}>
          {description}
        </div>
      ) : null}
    </div>
  );
}

function DiagnosticsList({  items = EMPTY_ARRAY  }: any) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader
        className="border-b px-4 py-3"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in oklch, var(--signal) 6%, transparent), transparent 76%)",
        }}
      >
        <CardTitle className="text-sm font-medium">Run diagnostics</CardTitle>
        <CardDescription className="mt-1 text-[12px]">
          Failure context, model attempt, routing progress, and persisted timing.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-2">
        <dl className="divide-y divide-border/40" style={{ borderColor: "var(--line)" }}>
          {items.map((item: any) => (
            <div key={item.label} className="px-2 py-2">
              <dt className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
                {item.label}
              </dt>
              <dd className="mt-0.5 break-words text-[12.5px] font-medium leading-snug" style={{ color: "var(--ink)" }}>
                {item.value}
              </dd>
              {item.note ? (
                <dd className="mt-0.5 text-[11px] leading-snug" style={{ color: "var(--mute)" }}>
                  {item.note}
                </dd>
              ) : null}
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function RunKebabMenu({
  run,
  canDelete,
  isDeleting,
  onDelete,
}: any) {
  if (!run?.url && !canDelete) return null;
  const itemClass =
    "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[12px] transition-colors hover:bg-muted/60";
  return (
    <details className="relative">
      <summary
        aria-label="More run actions"
        className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md border transition-colors hover:bg-muted/60 [&::-webkit-details-marker]:hidden"
        style={{ borderColor: "var(--line)", color: "var(--mute-2)" }}
      >
        <MoreHorizontal className="h-4 w-4" />
      </summary>
      <div
        className="absolute right-0 z-20 mt-1 min-w-[210px] rounded-xl border p-1 shadow-lg"
        style={{
          borderColor: "var(--line)",
          background: "var(--card)",
          color: "var(--ink)",
        }}
      >
        {run?.url ? (
          <a href={run.url} target="_blank" rel="noopener noreferrer" className={itemClass}>
            <ExternalLink className="h-3.5 w-3.5" />
            Open source page
          </a>
        ) : null}
        {canDelete ? (
          <ConfirmAction
            title="Delete this run?"
            description="Removes the run and its persisted telemetry. This cannot be undone."
            actionLabel={isDeleting ? "Deleting..." : "Delete run"}
            onConfirm={onDelete}
            trigger={(
              <button type="button" className={itemClass} disabled={isDeleting} style={{ color: "var(--rose)" }}>
                <Trash2 className="h-3.5 w-3.5" />
                {isDeleting ? "Deleting..." : "Delete run"}
              </button>
            )}
          />
        ) : null}
      </div>
    </details>
  );
}

function RunHeader({
  runId,
  run,
  runMode,
  live,
  failureHeadline,
  failureNarrative,
  primaryMetrics = EMPTY_ARRAY,
  actions = null,
}: any) {
  const title = parseHostLabel(run?.url);
  const subtitle = cleanInlineText(run?.url || "");
  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader
        className="border-b px-4 py-4"
        style={{
          borderColor: "var(--line)",
          background:
            "linear-gradient(180deg, color-mix(in oklch, var(--signal) 8%, transparent), transparent 68%)",
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <Breadcrumb>
              <BreadcrumbList className="text-[11px]">
                <BreadcrumbItem>
                  <Link href="/" className="transition-colors hover:text-foreground">
                    Console
                  </Link>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <Link href="/runs" className="transition-colors hover:text-foreground">
                    Runs
                  </Link>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage className="max-w-[360px] truncate font-mono text-[11px]" title={runId || ""}>
                    {runId || "--"}
                  </BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </Breadcrumb>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {run?.final_status ? (
                <Badge tone={runStatusTone(run.final_status)}>{statusLabel(run.final_status)}</Badge>
              ) : null}
              <span
                className="rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em]"
                style={{
                  borderColor: "var(--line)",
                  color: "var(--mute-2)",
                  background: "var(--card-hi)",
                }}
              >
                {runMode}
              </span>
              {live ? (
                <span
                  className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
                  style={{
                    background: "color-mix(in oklch, var(--rose) 14%, transparent)",
                    border: "1px solid color-mix(in oklch, var(--rose) 30%, transparent)",
                    color: "var(--rose)",
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{
                      background: "var(--rose)",
                      animation: "breathe 1.2s ease-in-out infinite",
                    }}
                  />
                  Live
                </span>
              ) : null}
              <span
                className="rounded-full border px-2 py-0.5 font-mono text-[10px]"
                style={{
                  borderColor: "var(--line)",
                  color: "var(--mute-2)",
                  background: "var(--card-hi)",
                }}
              >
                {runId || "--"}
              </span>
            </div>

            <div className="mt-4 flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1">
                <span className="owc-eyebrow">run detail</span>
                <h1 className="mt-1 text-[30px] font-semibold leading-none" style={{ color: "var(--ink)" }}>
                  {title}
                </h1>
                {subtitle ? (
                  <div className="mt-2 flex items-center gap-1.5">
                    <p className="max-w-3xl truncate text-[12.5px]" style={{ color: "var(--mute)" }} title={subtitle}>
                      {subtitle}
                    </p>
                    <a
                      href={run?.url || "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0"
                      style={{ color: "var(--mute-3)" }}
                    >
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                ) : null}
              </div>
              {failureHeadline || failureNarrative ? (
                <div
                  className="min-w-[280px] max-w-[520px] rounded-[16px] border px-3 py-3"
                  style={{
                    borderColor:
                      isFailureStatus(run?.final_status)
                        ? "color-mix(in oklch, var(--rose) 26%, transparent)"
                        : "var(--line)",
                    background:
                      isFailureStatus(run?.final_status)
                        ? "color-mix(in oklch, var(--rose) 8%, transparent)"
                        : "color-mix(in oklch, var(--card) 92%, transparent)",
                  }}
                >
                  <div className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--mute-3)" }}>
                    {isFailureStatus(run?.final_status) ? "Primary blocker" : "Run summary"}
                  </div>
                  <div className="mt-1 text-[14px] font-semibold leading-snug" style={{ color: "var(--ink)" }}>
                    {failureHeadline || "Run summary"}
                  </div>
                  {failureNarrative ? (
                    <div className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--mute)" }}>
                      {failureNarrative}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          {actions ? <div className="flex shrink-0 flex-wrap justify-end gap-2">{actions}</div> : null}
        </div>
      </CardHeader>

      <CardContent className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-8">
        {primaryMetrics.map((metric: any) => (
          <HeroMetric key={metric.label} {...metric} />
        ))}
      </CardContent>
    </Card>
  );
}

function DatasetContextCard({  context  }: any) {
  if (!context?.batch && !context?.site) return null;
  const batch = context.batch || {};
  const site = context.site || {};
  const siteRun = context.site_run || {};
  return (
    <Card className="overflow-hidden shadow-card">
      <CardContent className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">Dataset batch context</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {site.url ? (
              <span className="max-w-[360px] truncate" title={site.url}>
                {site.url}
              </span>
            ) : null}
            {site.language ? <Badge>{site.language}</Badge> : null}
            {site.label ? <Badge tone="signal">{site.label}</Badge> : null}
            {siteRun.id ? <span className="font-mono">site-run #{siteRun.id}</span> : null}
          </div>
        </div>
        {batch.batch_id ? (
          <Button asChild variant="outline" size="sm">
            <Link href={`/runs?tab=batches&batch=${encodeURIComponent(batch.batch_id)}`}>
              Open batch
              <ExternalLink className="h-4 w-4" />
            </Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function RunDetailPage() {
  const { runId } = useParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const VALID_TABS = ["timeline", "browser", "reasoning", "streams", "events", "costs"] as const;
  type TabValue = (typeof VALID_TABS)[number];
  // Legacy aliases from the pre-cockpit layout: agent output merged into
  // Streams & Payloads, screenshot grid merged into Browser & Media.
  const LEGACY_TAB_ALIASES: Record<string, TabValue> = { output: "streams", screenshots: "browser" };
  const rawTab = searchParams.get("tab");
  const activeTab: TabValue = (VALID_TABS as readonly string[]).includes(rawTab || "")
    ? (rawTab as TabValue)
    : LEGACY_TAB_ALIASES[rawTab || ""] || "timeline";
  const handleTabChange = (value: string) => {
    const canonical: TabValue = (VALID_TABS as readonly string[]).includes(value)
      ? (value as TabValue)
      : LEGACY_TAB_ALIASES[value] || "timeline";
    const params = new URLSearchParams(searchParams.toString());
    params.set("tab", canonical);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const [payload, setPayload] = useState<any>(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [pricingMap, setPricingMap] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const { settings: viewSettings } = useRunViewSettings();
  const extendedView: RunViewSettings & { showGraph?: boolean; showPlanBoard?: boolean; showContextMonitor?: boolean } = viewSettings;
  const showLiveView = viewSettings.showLiveView !== false;
  const showScreenshots = viewSettings.showScreenshots !== false;
  const showEventStream = viewSettings.showEventStream !== false;
  const showGraph = extendedView.showGraph ?? true;
  const showPlanBoard = extendedView.showPlanBoard ?? true;
  const showContextMonitor = extendedView.showContextMonitor ?? true;
  const showCostEstimate = viewSettings.showCostEstimate !== false;

  useEffect(() => {
    let alive = true;
    loadPricing().then((map) => {
      if (alive) setPricingMap(map);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function refreshRun() {
    if (!runId) return;
    setIsRefreshing(true);
    setActionError("");
    try {
      const next = await apiFetch(`/ui/runs/${runId}`);
      setPayload(next);
    } catch (nextError: any) {
      setActionError(nextError instanceof Error ? nextError.message : "Refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    apiFetch(`/ui/runs/${runId}`, { signal: controller.signal })
      .then((nextPayload) => {
        if (!controller.signal.aborted) setPayload(nextPayload);
      })
      .catch((eventError) => {
        if (!controller.signal.aborted && eventError?.name !== "AbortError") {
          setError(normalizeRunDetailError(eventError instanceof Error ? eventError.message : "Failed to load run detail"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [runId]);

  const jobStatus = String(payload?.job_state?.status || payload?.job?.status || payload?.run?.job_state || "").toLowerCase();
  const runStatus = String(payload?.run?.final_status || payload?.run?.status || "").toLowerCase();
  const activeTraceTerminalState = useMemo(
    () => getRunTerminalState(payload?.active_trace?.events || EMPTY_ARRAY),
    [payload?.active_trace?.events],
  );
  const shouldRefresh = useMemo(
    () =>
      (Boolean(payload?.active_trace) && !activeTraceTerminalState.isTerminal) ||
      ["queued", "running", "retrying", "leased"].includes(jobStatus) ||
      ["queued", "running", "retrying"].includes(runStatus),
    [activeTraceTerminalState.isTerminal, jobStatus, payload?.active_trace, runStatus],
  );

  // Plan tasks 40+42: consume the stream's actual payload contract
  // ({ events, metrics, completed, ...}) rather than expecting a trace
  // snapshot that the SSE endpoint does not emit. `streamEnded` closes the
  // EventSource once the terminal payload is received, preventing reconnects
  // against an already-completed run.
  const [streamEnded, setStreamEnded] = useState(false);
  useEffect(() => {
    setStreamEnded(false);
  }, [runId]);
  // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
  const stream = useRunStream(runId, {
    enabled: shouldRefresh && !streamEnded,
    onPayload: (streamPayload) => {
      if (streamPayload?.completed) setStreamEnded(true);
    },
  });

  // (Polling removed — plan tasks 40+42: the useRunStream SSE subscription
  // above delivers live trace updates; the terminal state arrives as the
  // stream's final snapshot, so no interval refetch is needed.)

  const streamedEvents = stream.events || EMPTY_ARRAY;
  const isActiveTrace = Boolean(payload?.active_trace) || streamedEvents.length > 0;
  const trace = isActiveTrace
    ? {
        ...(payload?.active_trace || EMPTY_OBJECT),
        events: streamedEvents.length ? streamedEvents : payload?.active_trace?.events || EMPTY_ARRAY,
        metrics: stream.metrics || payload?.active_trace?.metrics || EMPTY_OBJECT,
        completed: Boolean(stream.completed || payload?.active_trace?.completed),
      }
    : null;
  const snapshot = payload?.snapshot ?? EMPTY_OBJECT;
  const persistedEventsRaw = payload?.events ?? EMPTY_ARRAY;
  const liveMetricsSafe = trace?.metrics || EMPTY_OBJECT;
  const normalizedPersistedEvents = useMemo(
    () => normalizeTraceEvents(persistedEventsRaw),
    [persistedEventsRaw],
  );
  const normalizedTraceEvents = useMemo(
    () => normalizeTraceEvents(trace?.events || EMPTY_ARRAY),
    [trace?.events],
  );
  const normalizedTrace = useMemo(
    () => (trace ? { ...trace, events: normalizedTraceEvents } : null),
    [normalizedTraceEvents, trace],
  );
  const runEvents = isActiveTrace ? normalizedTraceEvents : normalizedPersistedEvents;
  const runTerminalState = useMemo(() => getRunTerminalState(runEvents), [runEvents]);
  const llmCalls = useMemo(() => extractLlmResponses(runEvents), [runEvents]);
  const llmTelemetryRows = useMemo(() => buildLlmRows(runEvents), [runEvents]);
  const providerSnapshot = useMemo(
    () => ({
      all_streams: firstNonEmptyArray(snapshot.all_streams, payload?.all_streams),
      provider_analysis: firstNonEmptyArray(snapshot.provider_analysis, payload?.provider_analysis),
      takedown_emails: firstNonEmptyArray(snapshot.takedown_emails, payload?.takedown_emails),
      extraction_results: firstNonEmptyArray(snapshot.extraction_results, payload?.extraction_results),
    }),
    [
      payload?.all_streams,
      payload?.extraction_results,
      payload?.provider_analysis,
      payload?.takedown_emails,
      snapshot,
    ],
  );
  const providerUrls = useMemo(
    () => collectRunProviderUrls({ snapshot: providerSnapshot, events: runEvents }),
    [providerSnapshot, runEvents],
  );

  const screenshots = useMemo(() => {
    const attributed = Array.isArray(payload?.screenshots)
      ? payload.screenshots.filter((row: any) => row?.screenshot_url)
      : EMPTY_ARRAY;
    if (attributed.length) return attributed;
    const urls = new Set();
    // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
    collectScreenshotUrls(snapshot.all_screenshots || EMPTY_ARRAY, urls);
    // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
    collectScreenshotUrls(payload?.all_screenshots || EMPTY_ARRAY, urls);
    for (const event of runEvents) {
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      collectScreenshotUrls(event?.details, urls);
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      collectScreenshotUrls(event?.details_json, urls);
    }
    return Array.from(urls);
  }, [payload?.all_screenshots, payload?.screenshots, runEvents, snapshot]);

  const run = payload?.run || EMPTY_OBJECT;
  const parallelism = payload?.parallelism || {
    current_parallel_agents: 0,
    max_parallel_agents: 0,
  };
  const agentRollups = payload?.agent_rollups || EMPTY_ARRAY;
  const stageRollups = payload?.stage_rollups || EMPTY_ARRAY;
  const toolCalls = payload?.tool_calls || EMPTY_ARRAY;
  const jobState = payload?.job_state || payload?.job || null;
  const datasetContext = payload?.dataset_context || null;
  const degradedFallback = payload?.source === "background_job_result";
  const telemetryStatus = String(payload?.telemetry_status || run.telemetry_status || "").trim().toLowerCase();
  const telemetryMissing = degradedFallback && telemetryStatus === "missing";
  const allStreams = providerSnapshot.all_streams || EMPTY_ARRAY;
  const modelUsage = payload?.model_usage || snapshot?.metrics?.model_usage || EMPTY_ARRAY;

  // Cost fallback chain: logged run cost → priced LLM event calls (or
  // model_usage synthesis) → explicit unpriced / no-billable states. Never
  // renders `-- (Trace missing)`.
  const resolvedCost = resolveRunCost({
    run,
    modelUsage,
    llmCalls,
    pricingMap,
    liveMetrics: liveMetricsSafe,
  });
  const costTotals = {
    total: resolvedCost.total,
    input: resolvedCost.input,
    cached: resolvedCost.cached,
    cacheWrite: resolvedCost.cacheWrite,
    output: resolvedCost.output,
    calls: resolvedCost.calls,
    computed: resolvedCost.source === "priced" || resolvedCost.source === "logged" ? resolvedCost.calls : 0,
    unpriced: resolvedCost.unpriced,
  };

  const attemptedModel = (() => {
    const fromTelemetry = [...llmTelemetryRows].reverse().find((row) => row.provider || row.model);
    if (fromTelemetry) return { provider: fromTelemetry.provider, model: fromTelemetry.model };
    const fromStart = [...runEvents].reverse().find((event) => event?.kind === "llm_turn_started");
    if (fromStart?.details?.provider || fromStart?.details?.model_name) {
      return {
        provider: String(fromStart.details.provider || ""),
        model: String(fromStart.details.model_name || ""),
      };
    }
    return {
      provider: String(run.primary_provider || ""),
      model: String(run.primary_model || ""),
    };
  })();

  const primaryProvider = run.primary_provider || attemptedModel.provider || "";
  const primaryModel = run.primary_model || attemptedModel.model || "";

  const contextPeak = peakContextUsage(llmCalls, pricingMap);
  const contextWindow =
    contextPeak.contextWindow ||
    getContextWindow(
      primaryProvider,
      primaryModel,
      llmCalls,
      pricingMap,
    );
  const contextTokens = Number(contextPeak.tokens || 0);
  const contextPct = contextWindow > 0 ? Math.max(0, Math.min(1, contextTokens / contextWindow)) : 0;

  const failureEvent = (() => {
    // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
    const explicitFailure = [...runEvents].reverse().find((event) => FAILURE_EVENT_KINDS.has(event?.kind));
    if (explicitFailure) return explicitFailure;
    return [...runEvents].reverse().find(
      (event) =>
        event?.status === "error" ||
        (event?.kind === "pipeline_finished" && String(event?.status || "").toLowerCase() === "warning"),
    ) || null;
  })();

  const failureStage = actorToStage(failureEvent?.actor) || actorToStage(run.root_actor) || "";
  const failureStageLabel = stageLabel(failureStage || run.failure_mode || "");
  const failureText = normalizeFailurePreview(
    failureEvent?.details?.error_preview ||
      failureEvent?.details?.error ||
      failureEvent?.message ||
      run.classification_reasoning ||
      run.failure_mode,
  );
  const runFailed = isFailureStatus(run.final_status);

  const attemptedModelLabel =
    primaryProvider || primaryModel
      ? `${primaryProvider || "--"} / ${primaryModel || "--"}`
      : "--";
  const failureHeadline =
    runFailed
      ? primaryModel
        ? `${failureStageLabel} blocked while attempting ${primaryModel}`
        : `${failureStageLabel} blocked before completion`
      : run.final_status
        ? `${statusLabel(run.final_status)} run`
        : "Run summary";
  const failureNarrative =
    runFailed
      ? [
          primaryProvider || primaryModel
            ? `Attempted ${attemptedModelLabel}.`
            : "",
          failureText || "The run failed before persisted model telemetry was recorded.",
        ]
          .filter(Boolean)
          .join(" ")
      : failureText || "";

  const llmAttemptCount = Math.max(
    Number(run.total_llm_calls || 0),
    (runEvents || []).filter((event) => event?.kind === "llm_turn_started").length,
    llmTelemetryRows.length,
  );
  // Never reports 0 while tool telemetry exists: persisted counter, persisted
  // rows, paired start/finish rows, and raw start observations from events.
  const toolCallCount = Math.max(
    Number(liveMetricsSafe.total_tool_calls || 0),
    resolveRunToolCallCount({ run, toolCalls, runEvents }),
  );
  const screenshotCount = Math.max(Number(run.screenshot_count || 0), screenshots.length);
  const streamCount = Math.max(Number(run.stream_count || 0), allStreams.length);

  const uniqueActors = new Set(
    [
      ...agentRollups.map((row: any) => String(row?.actor || "").trim()),
      ...runEvents.map((event) => String(event?.actor || "").trim()),
    ].filter(Boolean),
  );

  const reachedStages = new Set(
    [
      ...stageRollups.map((row: any) => actorToStage(row?.agent_type) || String(row?.agent_type || "").trim().toLowerCase()),
      ...agentRollups.map((row: any) => actorToStage(row?.actor) || String(row?.agent_type || "").trim().toLowerCase()),
      ...runEvents.map((event) => actorToStage(event?.actor) || ""),
    ].filter(Boolean),
  );

  const toolProfiles = Array.from(
    new Set(
      runEvents
        .filter((event) => event?.kind === "tool_session_ready")
        .map((event) => String(event?.details?.profile || "").trim())
        .filter(Boolean),
    ),
  );
  const runTokens = useMemo(() => {
    let tin = 0, tout = 0;
    for (const call of llmCalls) {
      tin += Number(call.input_tokens || call.usage_metadata_json?.input_tokens || 0);
      tout += Number(call.output_tokens || call.usage_metadata_json?.output_tokens || 0);
    }
    if (tin === 0 && tout === 0) {
      for (const entry of modelUsage) {
        tin += Number(entry?.input_tokens || 0);
        tout += Number(entry?.output_tokens || 0);
      }
    }
    // Fallback to liveMetricsSafe if calls are empty but metrics have aggregates
    if (tin === 0 && tout === 0) {
      tin = Number(liveMetricsSafe.total_tokens_in || payload?.metrics?.total_tokens_in || 0);
      tout = Number(liveMetricsSafe.total_tokens_out || payload?.metrics?.total_tokens_out || 0);
    }
    return { total_tokens_in: tin, total_tokens_out: tout, total_llm_calls: costTotals.calls || llmAttemptCount };
  }, [llmCalls, modelUsage, costTotals.calls, llmAttemptCount, liveMetricsSafe, payload?.metrics]);
  const decisionCount = runEvents.filter((event) => event?.kind === "orchestrator_decision").length;

  const lastSuccessfulStageRow = [...stageRollups].reverse().find((row) =>
    ["success", "done", "completed", "partial"].includes(String(row?.status || "").toLowerCase()),
  );
  const lastSuccessfulStage = lastSuccessfulStageRow
    ? stageLabel(actorToStage(lastSuccessfulStageRow.agent_type) || lastSuccessfulStageRow.agent_type)
    : "--";

  // Compact 6-tile KPI ribbon: cost (logged → priced → explicit unpriced /
  // no-billable states), duration, tokens, tool calls (event-backed),
  // captured streams, screenshots.
  const costDescription = showCostEstimate
    ? `${runCostDetail(resolvedCost, llmAttemptCount)} · ${runCostSourceLabel(resolvedCost.source)}`
    : "Hidden by display settings";
  const heroMetrics = [
    {
      label: "Estimated Cost",
      value: showCostEstimate ? formatCurrency(resolvedCost.total) : "Hidden",
      description: costDescription,
      emphasis: "var(--mint)",
    },
    {
      label: "Duration",
      value: dur(run.duration_seconds),
      description: parallelism?.max_parallel_agents > 1 ? `Peak overlap ${formatNumber(parallelism.max_parallel_agents)} agents` : "Wall-clock run time",
      emphasis: "var(--ink)",
    },
    {
      label: "Total Tokens",
      value: formatNumber(runTokens.total_tokens_in + runTokens.total_tokens_out),
      description: `${formatNumber(runTokens.total_llm_calls)} LLM calls`,
      emphasis: "var(--violet)",
    },
    {
      label: "Tool Calls",
      value: formatNumber(toolCallCount),
      description: toolCallCount > toolCalls.length ? "Including observed events" : "MCP tool executions",
      emphasis: "var(--sky)",
    },
    {
      label: "Captured Streams",
      value: formatNumber(streamCount),
      description: streamCount > 0 ? "Provider URLs found" : "No provider URLs found",
      emphasis: "var(--ink)",
    },
    {
      label: "Screenshots",
      value: formatNumber(screenshotCount),
      description: screenshotCount > 0 ? "Captured frames" : "No frames captured",
      emphasis: "var(--ink)",
    },
  ];

  const diagnosticsItems = [
    { label: "Attempted model", value: attemptedModelLabel, note: primaryModel ? "Derived from LLM attempt events when persisted primary model is empty." : "" },
    { label: "Failure stage", value: runFailed ? failureStageLabel : "--", note: runFailed ? failureText : "" },
    { label: "Last successful stage", value: lastSuccessfulStage, note: lastSuccessfulStage !== "--" ? "Last completed stage before the terminal state." : "" },
    { label: "LLM calls", value: formatNumber(llmAttemptCount), note: llmAttemptCount > Number(run.total_llm_calls || 0) ? "Attempts including failures." : "Persisted model calls." },
    { label: "Context window", value: contextWindow > 0 ? formatNumber(contextWindow) : "--", note: contextWindow > 0 ? `${(contextPct * 100).toFixed(1)}% peak used.` : "No context telemetry." },
    { label: "Agents touched", value: formatNumber(uniqueActors.size), note: uniqueActors.size > 0 ? Array.from(uniqueActors).slice(0, 4).join(", ") : "No actor telemetry." },
    { label: "Stages reached", value: formatNumber(reachedStages.size), note: reachedStages.size > 0 ? Array.from(reachedStages).map(stageLabel).slice(0, 4).join(", ") : "No stage telemetry." },
    { label: "Routing decisions", value: formatNumber(decisionCount), note: decisionCount > 0 ? "Event-derived orchestrator decisions." : "No decisions recorded." },
    { label: "Tool profiles", value: toolProfiles.length ? toolProfiles.join(", ") : "--", note: toolProfiles.length ? `${formatNumber(toolProfiles.length)} MCP profile${toolProfiles.length === 1 ? "" : "s"} connected.` : "No tool session handshakes recorded." },
    { label: "Duration", value: dur(run.duration_seconds), note: parallelism?.max_parallel_agents > 1 ? `Peak overlap ${formatNumber(parallelism.max_parallel_agents)} agents.` : "" },
    { label: "Started", value: fmt(run.started_at || run.created_at) },
    { label: "Finished", value: fmt(run.finished_at) },
  ];

  // T40 live-run: derive library-grade datasets directly from useRunStream SSE events.
  // Zero polling — these memos recompute only when SSE delivers new payloads.
  const planSteps = useMemo(() => {
    const rawSteps =
      (stream.plan && Array.isArray(stream.plan.steps) && stream.plan.steps) ||
      (payload?.plan && Array.isArray(payload.plan.steps) && payload.plan.steps) ||
      (payload?.active_trace?.plan && Array.isArray(payload.active_trace.plan.steps) && payload.active_trace.plan.steps) ||
      (payload?.active_trace?.events ? [] : EMPTY_ARRAY);
    if (Array.isArray(rawSteps) && rawSteps.length > 0) {
      return rawSteps.map((s, idx) => {
        const statusRaw = String(s.status || s.state || "pending").toLowerCase();
        const canonical =
          statusRaw === "completed" || statusRaw === "done" ? "done" :
          statusRaw === "running" || statusRaw === "active" || statusRaw === "in_progress" ? "in_progress" :
          statusRaw === "failed" || statusRaw === "error" ? "failed" :
          statusRaw === "skipped" ? "skipped" : "pending";
        return {
          id: String(s.id || s.step_id || `step-${idx}`),
          title: String(s.title || s.name || `Step ${idx + 1}`),
          criteria: String(s.criteria || s.description || ""),
          budget: s.budget != null ? s.budget : null,
          status: canonical,
        };
      });
    }
    // Fallback: synthesize from plan_step_update SSE events
    const fromEvents = new Map();
    for (const ev of runEvents) {
      if (ev?.kind !== "plan_step_update") continue;
      const d = ev.details || {};
      const id = String(d.step_id || d.id || ev.seq || "");
      if (!id) continue;
      const statusRaw = String(d.status || d.state || "in_progress").toLowerCase();
      const canonical =
        statusRaw === "completed" || statusRaw === "done" ? "done" :
        statusRaw === "running" || statusRaw === "active" || statusRaw === "in_progress" ? "in_progress" :
        statusRaw === "failed" || statusRaw === "error" ? "failed" :
        statusRaw === "skipped" ? "skipped" : "pending";
      fromEvents.set(id, {
        id,
        title: String(d.title || d.step_title || id),
        criteria: String(d.criteria || ""),
        budget: d.budget != null ? d.budget : null,
        status: canonical,
      });
    }
    if (fromEvents.size > 0) return Array.from(fromEvents.values());
    return [];
  }, [stream.plan, payload?.plan, payload?.active_trace?.plan, runEvents]);

  const runCosts = useMemo(() => ({
    estimated_input_cost_usd: Number(costTotals.input || 0),
    estimated_cached_input_cost_usd: Number(costTotals.cached || 0),
    estimated_cache_write_cost_usd: Number(costTotals.cacheWrite || 0),
    estimated_output_cost_usd: Number(costTotals.output || 0),
    estimated_total_cost_usd: Number(costTotals.total || 0),
  }), [costTotals]);


  if (isLoading) {
    return (
      <div className="space-y-5">
        <Card className="overflow-hidden shadow-card">
          <CardHeader className="space-y-3 border-b px-4 py-4">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-[32rem]" />
          </CardHeader>
          <CardContent className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-8">
            {Array.from({ length: 8 }).map((_, idx) => (
              <Skeleton key={idx} className="h-24 rounded-xl" />
            ))}
          </CardContent>
        </Card>
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div className="space-y-4">
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border px-4 py-3 text-sm"
          style={{
            borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
            background: "color-mix(in oklch, var(--rose) 8%, transparent)",
            color: "var(--rose)",
          }}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">Run unavailable</div>
            <div className="mt-0.5 text-[12.5px] opacity-90">{error || "Run not found"}</div>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/runs">Back to runs</Link>
        </Button>
      </div>
    );
  }

  async function cancelRun() {
    if (!runId || isCancelling) return;
    setIsCancelling(true);
    setActionError("");
    try {
      await apiFetch(`/ui/runs/${runId}/cancel`, {
        method: "POST",
      });
      await refreshRun();
    } catch (nextError: any) {
      setActionError(nextError instanceof Error ? nextError.message : "Cancel failed");
    } finally {
      setIsCancelling(false);
    }
  }

  async function deleteRun() {
    if (!runId || isDeleting) return;
    setIsDeleting(true);
    setActionError("");
    try {
      await apiFetch(`/ui/runs/${runId}`, {
        method: "DELETE",
      });
      router.push("/runs");
      router.refresh();
    } catch (nextError: any) {
      setActionError(nextError instanceof Error ? nextError.message : "Delete failed");
      setIsDeleting(false);
    }
  }

  async function restartRun() {
    if (!run.url || isRestarting) return;
    setIsRestarting(true);
    setActionError("");
    try {
      const nextPayload = {
        batch_name: `Restart: ${runId ? runId.slice(0, 12) : "run"}`,
        language: datasetContext?.site?.language || "",
        label: datasetContext?.site?.label || "",
        query: "",
        limit: 0,
        urls: [run.url],
      };
      const created = await apiFetch<{ batch_id: string }>("/api/datasets/batches", {
        method: "POST",
        body: JSON.stringify(nextPayload),
      });
      router.push(`/runs?tab=batches&batch=${encodeURIComponent(created.batch_id)}`);
      router.refresh();
    } catch (nextError: any) {
      setActionError(nextError instanceof Error ? nextError.message : "Restart failed");
    } finally {
      setIsRestarting(false);
    }
  }
  async function copyTargetUrl() {
    const url = String(run?.url || "");
    if (!url) return;
    setActionError("");
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = url;
        document.body.appendChild(fallback);
        fallback.select();
        document.execCommand("copy");
        document.body.removeChild(fallback);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (nextError: unknown) {
      setActionError(nextError instanceof Error ? nextError.message : "Copy failed");
    }
  }

  return (
    <div className="space-y-5">
      {degradedFallback ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-xl border px-4 py-3 text-sm"
          style={{
            borderColor: "color-mix(in oklch, var(--amber) 28%, transparent)",
            background: "color-mix(in oklch, var(--amber) 9%, transparent)",
            color: "var(--signal)",
          }}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">
              {telemetryMissing ? "Final answer recovered, telemetry missing" : "Background result recovered"}
            </div>
            <div className="mt-0.5 text-[12.5px] opacity-90">
              {payload.telemetry_message ||
                run.telemetry_message ||
                "This run is using the background job payload because normalized run telemetry was unavailable."}
            </div>
          </div>
        </div>
      ) : null}

      <RunHeader
        runId={runId}
        run={run}
        runMode={getRunMode(jobState)}
        live={isActiveTrace && !runTerminalState.isTerminal}
        failureHeadline={failureHeadline}
        failureNarrative={failureNarrative}
        primaryMetrics={heroMetrics}
        actions={(
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={refreshRun}
              disabled={isLoading || isRefreshing}
            >
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            {run?.url ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={copyTargetUrl}
                aria-label="Copy target URL"
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                {copied ? "Copied" : "Copy link"}
              </Button>
            ) : null}
            {canCancelRun(run) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={cancelRun}
                disabled={isCancelling}
              >
                <XCircle className="h-4 w-4" />
                {isCancelling ? "Stopping..." : "Stop run"}
              </Button>
            ) : null}
            {run?.url ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={restartRun}
                disabled={isRestarting}
              >
                <RotateCcw className="h-4 w-4" />
                {isRestarting ? "Restarting..." : "Restart"}
              </Button>
            ) : null}
            <RunKebabMenu
              run={run}
              canDelete={canDeleteRun(run)}
              isDeleting={isDeleting}
              onDelete={deleteRun}
            />
          </>
        )}
      />

      {/* Cockpit workspace: primary tabs sit directly under the KPI ribbon;
          the agent run map, inspector, and diagnostics dock in the sidebar.
          SSE-first composition, zero polling. */}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full min-w-0">
          <TabsList className="w-full justify-start overflow-x-auto">
            <TabsTrigger value="timeline">Timeline & Steps</TabsTrigger>
            <TabsTrigger value="browser">Browser & Media</TabsTrigger>
            <TabsTrigger value="reasoning">Reasoning & LLM</TabsTrigger>
            <TabsTrigger value="streams">Streams & Payloads</TabsTrigger>
            <TabsTrigger value="events">Event Stream</TabsTrigger>
            <TabsTrigger value="costs">Costs & Context</TabsTrigger>
          </TabsList>
          <TabsContent value="timeline">
            <div className="space-y-5">
              <RunTimelineTab steps={planSteps} events={runEvents} streamStatus={stream.status} connected={stream.connected} />
              {showPlanBoard ? <AgentPlanBoard events={runEvents} /> : null}
            </div>
          </TabsContent>
          <TabsContent value="browser">
            <div className="space-y-5">
              {showLiveView ? (
                <BrowserLiveView
                  runId={typeof runId === "string" ? runId : Array.isArray(runId) ? runId[0] : ""}
                  events={runEvents}
                  persistedScreenshots={screenshots}
                />
              ) : null}
              {showScreenshots ? (
                <ScreenshotGridTab events={runEvents} screenshots={screenshots} />
              ) : null}
              {!showLiveView && !showScreenshots ? (
                <Card>
                  <CardContent className="px-4 py-8 text-center text-[12.5px]" style={{ color: "var(--mute)" }}>
                    Browser views are hidden by display settings. Re-enable them under Settings → Display.
                  </CardContent>
                </Card>
              ) : null}
            </div>
          </TabsContent>
          <TabsContent value="reasoning">
            <ReasoningTraceTab events={runEvents} />
          </TabsContent>
          <TabsContent value="streams">
            <div className="space-y-5">
              <StreamProviderTab
                runId={typeof runId === "string" ? runId : Array.isArray(runId) ? runId[0] : ""}
                runUrl={run?.url || ""}
                streamUrls={providerUrls.length ? providerUrls : allStreams}
                providerAnalysis={providerSnapshot.provider_analysis || EMPTY_ARRAY}
                extractionResults={providerSnapshot.extraction_results || EMPTY_ARRAY}
              />
              <AgentOutputTab
                stageRollups={stageRollups}
                agentRollups={agentRollups}
                parallelism={parallelism}
                takedownEmails={providerSnapshot.takedown_emails || EMPTY_ARRAY}
              />
            </div>
          </TabsContent>
          <TabsContent value="events">
            {showEventStream ? (
              <RunEventFeedTab
                events={runEvents}
                maxItems={viewSettings.eventLimit}
                compact={viewSettings.compactEvents}
                showTimestamps={viewSettings.showTimestamps}
                highlightErrors={viewSettings.highlightErrors}
              />
            ) : (
              <Card>
                <CardContent className="px-4 py-8 text-center text-[12.5px]" style={{ color: "var(--mute)" }}>
                  The event stream is hidden by display settings. Re-enable it under Settings → Display.
                </CardContent>
              </Card>
            )}
          </TabsContent>
          <TabsContent value="costs">
            <div className="space-y-5">
              <CostMeterTab costs={runCosts} metrics={runTokens as any} />
              {showContextMonitor ? <ContextWindowMonitor events={runEvents} /> : null}
            </div>
          </TabsContent>
        </Tabs>
        <aside className="min-w-0 space-y-5">
          {showGraph ? (
            <AgentRunGraph
              runId={typeof runId === "string" ? runId : ""}
              events={runEvents}
              agentRollups={agentRollups}
              rootActor={run.root_actor || "orchestrator"}
              streamConnected={stream.connected}
              streamStatus={stream.status}
              completed={Boolean(trace?.completed || stream.completed || runTerminalState.isTerminal)}
              runStatus={run.final_status || run.status || ""}
              showToolArgs={viewSettings.showToolArgs}
            />
          ) : (
            <Card>
              <CardContent className="px-4 py-6 text-center text-[12.5px]" style={{ color: "var(--mute)" }}>
                The agent run map is hidden by display settings. Re-enable it under Settings → Display.
              </CardContent>
            </Card>
          )}
          <DiagnosticsList items={diagnosticsItems} />
        </aside>
      </div>
    </div>
  );
}