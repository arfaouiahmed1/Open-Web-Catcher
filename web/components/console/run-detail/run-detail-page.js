"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AlertCircle, ExternalLink, RefreshCw, RotateCcw, Trash2, XCircle } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { buildLlmRows } from "@/lib/llm-output-rows";
import { estimateRunCost, getContextWindow, loadPricing, peakContextUsage, synthCallsFromModelUsage } from "@/lib/pricing";
import { formatCurrency, formatNumber } from "@/lib/utils";
import {
  canCancelRun,
  canDeleteRun,
  statusLabel,
  statusTone as runStatusTone,
} from "@/lib/run-status";
import { actorToStage, getRunTerminalState, normalizeTraceEvents, STAGE_LABELS } from "@/lib/run-trace";
import { RunDetailLive } from "@/components/run-detail-live";
import { Badge } from "@/components/ui/badge";
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

const EMPTY_OBJECT = {};
const EMPTY_ARRAY = [];
const FAILURE_EVENT_KINDS = new Set(["llm_error", "llm_timeout", "llm_rate_limited", "pipeline_failed"]);
const FAILURE_STATUSES = new Set([
  "failed",
  "timeout",
  "site_dead",
  "page_inaccessible",
  "no_hosting_pages",
  "no_streams",
]);

function firstNonEmptyArray(...values) {
  const nonEmpty = values.find((value) => Array.isArray(value) && value.length > 0);
  if (nonEmpty) return nonEmpty;
  return values.find((value) => Array.isArray(value)) || EMPTY_ARRAY;
}

function fmt(ts) {
  if (!ts) return "--";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function dur(seconds) {
  const value = Number(seconds || 0);
  if (!value) return "--";
  if (value < 60) return `${value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}m ${(value % 60).toFixed(0)}s`;
}

function normalizeRunDetailError(message) {
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

function parseHostLabel(url) {
  const value = String(url || "").trim();
  if (!value) return "Run detail";
  try {
    return new URL(value).host || value;
  } catch {
    return value;
  }
}

function cleanInlineText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeFailurePreview(value) {
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

function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage || "--";
}

function getRunMode(jobState) {
  return String(jobState?.job_type || "").toLowerCase() === "workflow" ? "workflow run" : "agent run";
}

function isFailureStatus(status) {
  return FAILURE_STATUSES.has(String(status || "").trim().toLowerCase());
}

function HeroMetric({ label, value, description, emphasis = "var(--ink)" }) {
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

function DiagnosticsGrid({ items = EMPTY_ARRAY }) {
  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader
        className="border-b px-4 py-4"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in oklch, var(--signal) 6%, transparent), transparent 76%)",
        }}
      >
        <CardTitle className="text-sm font-medium">Run diagnostics</CardTitle>
        <CardDescription className="mt-1 text-[12px]">
          Failure context, model attempt, routing progress, and persisted timing for this run.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-2 2xl:grid-cols-4">
        {items.map((item) => (
          <div
            key={item.label}
            className="rounded-[14px] border px-3 py-2.5"
            style={{
              borderColor: "var(--line)",
              background: "color-mix(in oklch, var(--bg) 82%, transparent)",
            }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>
              {item.label}
            </div>
            <div className="mt-1 break-words text-[13px] font-medium leading-snug" style={{ color: "var(--ink)" }}>
              {item.value}
            </div>
            {item.note ? (
              <div className="mt-1 text-[11px] leading-snug" style={{ color: "var(--mute)" }}>
                {item.note}
              </div>
            ) : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function SecondaryActionsCard({
  run,
  canDelete,
  isDeleting,
  isRestarting,
  onRestart,
  onDelete,
}) {
  if (!run?.url && !canDelete) return null;
  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
        <CardTitle className="text-sm font-medium">Run actions</CardTitle>
        <CardDescription className="text-[12px]">
          Secondary actions for replaying or cleaning up this run.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 p-4">
        {run?.url ? (
          <Button type="button" variant="outline" size="sm" onClick={onRestart} disabled={isRestarting}>
            <RotateCcw className="h-4 w-4" />
            {isRestarting ? "Restarting..." : "Restart run"}
          </Button>
        ) : null}
        {run?.url ? (
          <Button asChild type="button" variant="outline" size="sm">
            <a href={run.url} target="_blank" rel="noopener noreferrer">
              Open source page
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        ) : null}
        {canDelete ? (
          <ConfirmAction
            title="Delete this run?"
            description="Removes the run and its persisted telemetry. This cannot be undone."
            actionLabel={isDeleting ? "Deleting..." : "Delete run"}
            onConfirm={onDelete}
            trigger={(
              <Button type="button" variant="outline" size="sm" disabled={isDeleting}>
                <Trash2 className="h-4 w-4" />
                Delete run
              </Button>
            )}
          />
        ) : null}
      </CardContent>
    </Card>
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
}) {
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
                  background: "rgba(255,255,255,0.52)",
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
                  background: "rgba(255,255,255,0.55)",
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
        {primaryMetrics.map((metric) => (
          <HeroMetric key={metric.label} {...metric} />
        ))}
      </CardContent>
    </Card>
  );
}

function DatasetContextCard({ context }) {
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
            <Link href={`/runs?batch=${encodeURIComponent(batch.batch_id)}`}>
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
  const [payload, setPayload] = useState(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [isCancelling, setIsCancelling] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRestarting, setIsRestarting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");
  const [pricingMap, setPricingMap] = useState(null);

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
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : "Refresh failed");
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    setError("");
    apiFetch(`/ui/runs/${runId}`)
      .then(setPayload)
      .catch((eventError) => setError(normalizeRunDetailError(eventError.message)))
      .finally(() => setLoading(false));
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

  useEffect(() => {
    if (!shouldRefresh) return undefined;
    const id = setInterval(() => {
      apiFetch(`/ui/runs/${runId}`)
        .then((next) => {
          setPayload(next);
          const nextJobStatus = String(next?.job_state?.status || next?.job?.status || next?.run?.job_state || "").toLowerCase();
          const nextRunStatus = String(next?.run?.final_status || next?.run?.status || "").toLowerCase();
          if (
            !next?.active_trace &&
            !["queued", "running", "retrying", "leased"].includes(nextJobStatus) &&
            !["queued", "running", "retrying"].includes(nextRunStatus)
          ) {
            clearInterval(id);
          }
        })
        .catch((nextError) => setActionError(nextError instanceof Error ? nextError.message : "Refresh failed"));
    }, 5000);
    return () => clearInterval(id);
  }, [runId, shouldRefresh]); // eslint-disable-line react-hooks/exhaustive-deps

  const isActiveTrace = Boolean(payload?.active_trace);
  const trace = isActiveTrace ? payload.active_trace : null;
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
      ? payload.screenshots.filter((row) => row?.screenshot_url)
      : EMPTY_ARRAY;
    if (attributed.length) return attributed;
    const urls = new Set();
    collectScreenshotUrls(snapshot.all_screenshots || EMPTY_ARRAY, urls);
    collectScreenshotUrls(payload?.all_screenshots || EMPTY_ARRAY, urls);
    for (const event of runEvents) {
      collectScreenshotUrls(event?.details, urls);
      collectScreenshotUrls(event?.details_json, urls);
    }
    return Array.from(urls);
  }, [payload?.all_screenshots, payload?.screenshots, runEvents, snapshot]);

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

  const run = payload.run || EMPTY_OBJECT;
  const parallelism = payload.parallelism || {
    current_parallel_agents: 0,
    max_parallel_agents: 0,
  };
  const agentRollups = payload.agent_rollups || EMPTY_ARRAY;
  const stageRollups = payload.stage_rollups || EMPTY_ARRAY;
  const toolCalls = payload.tool_calls || EMPTY_ARRAY;
  const jobState = payload.job_state || payload.job || null;
  const datasetContext = payload.dataset_context || null;
  const degradedFallback = payload.source === "background_job_result";
  const telemetryStatus = String(payload.telemetry_status || run.telemetry_status || "").trim().toLowerCase();
  const telemetryMissing = degradedFallback && telemetryStatus === "missing";
  const allStreams = providerSnapshot.all_streams || EMPTY_ARRAY;
  const modelUsage = payload.model_usage || snapshot?.metrics?.model_usage || EMPTY_ARRAY;

  const effectiveCalls = llmCalls.length > 0 ? llmCalls : synthCallsFromModelUsage(modelUsage);
  const costTotals = estimateRunCost(effectiveCalls, pricingMap);

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
  const toolCallCount = isActiveTrace
    ? Math.max(Number(liveMetricsSafe.total_tool_calls || 0), toolCalls.length)
    : Math.max(Number(run.total_tool_calls || 0), toolCalls.length);
  const screenshotCount = Math.max(Number(run.screenshot_count || 0), screenshots.length);
  const streamCount = Math.max(Number(run.stream_count || 0), allStreams.length);

  const uniqueActors = new Set(
    [
      ...agentRollups.map((row) => String(row?.actor || "").trim()),
      ...runEvents.map((event) => String(event?.actor || "").trim()),
    ].filter(Boolean),
  );

  const reachedStages = new Set(
    [
      ...stageRollups.map((row) => actorToStage(row?.agent_type) || String(row?.agent_type || "").trim().toLowerCase()),
      ...agentRollups.map((row) => actorToStage(row?.actor) || String(row?.agent_type || "").trim().toLowerCase()),
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
  const decisionCount = runEvents.filter((event) => event?.kind === "orchestrator_decision").length;

  const lastSuccessfulStageRow = [...stageRollups].reverse().find((row) =>
    ["success", "done", "completed", "partial"].includes(String(row?.status || "").toLowerCase()),
  );
  const lastSuccessfulStage = lastSuccessfulStageRow
    ? stageLabel(actorToStage(lastSuccessfulStageRow.agent_type) || lastSuccessfulStageRow.agent_type)
    : "--";

  const heroMetrics = [
    {
      label: "Estimated Cost",
      value: telemetryMissing ? "--" : formatCurrency(costTotals.total),
      description:
        telemetryMissing
          ? "Trace missing"
          : llmAttemptCount > 0 && costTotals.calls === 0
            ? "Attempted but no priced telemetry"
            : costTotals.calls > 0
              ? `${formatNumber(costTotals.calls)} priced call${costTotals.calls === 1 ? "" : "s"}`
              : "No model pricing captured",
      emphasis: "var(--mint)",
    },
    {
      label: "Context Window",
      value: contextWindow > 0 ? `${formatNumber(contextWindow)}` : "--",
      description:
        contextWindow > 0
          ? `${(contextPct * 100).toFixed(1)}% used`
          : primaryModel
            ? `Attempted ${primaryModel}`
            : "No context telemetry",
      emphasis: contextWindow > 0 ? "var(--signal)" : "var(--ink)",
    },
    {
      label: "LLM Calls",
      value: formatNumber(llmAttemptCount),
      description: llmAttemptCount > Number(run.total_llm_calls || 0) ? "Attempts including failures" : "Persisted model calls",
      emphasis: "var(--violet)",
    },
    {
      label: "Tool Calls",
      value: formatNumber(toolCallCount),
      description: "MCP tool executions",
      emphasis: "var(--sky)",
    },
    {
      label: "Screenshots",
      value: formatNumber(screenshotCount),
      description: screenshotCount > 0 ? "Captured frames" : "No frames captured",
      emphasis: "var(--ink)",
    },
    {
      label: "Streams",
      value: formatNumber(streamCount),
      description: streamCount > 0 ? "Provider URLs found" : "No provider URLs found",
      emphasis: "var(--ink)",
    },
    {
      label: "Agents touched",
      value: formatNumber(uniqueActors.size),
      description: uniqueActors.size > 0 ? `${Array.from(uniqueActors).slice(0, 2).join(", ")}${uniqueActors.size > 2 ? "..." : ""}` : "No actor telemetry",
      emphasis: "var(--signal)",
    },
    {
      label: "Stages reached",
      value: formatNumber(reachedStages.size),
      description: reachedStages.size > 0 ? Array.from(reachedStages).map(stageLabel).slice(0, 2).join(", ") : "No stage telemetry",
      emphasis: "var(--signal)",
    },
  ];

  const diagnosticsItems = [
    { label: "Attempted model", value: attemptedModelLabel, note: primaryModel ? "Derived from LLM attempt events when persisted primary model is empty." : "" },
    { label: "Failure stage", value: runFailed ? failureStageLabel : "--", note: runFailed ? failureText : "" },
    { label: "Last successful stage", value: lastSuccessfulStage, note: lastSuccessfulStage !== "--" ? "Last completed stage before the terminal state." : "" },
    { label: "Routing decisions", value: formatNumber(decisionCount), note: decisionCount > 0 ? "Event-derived orchestrator decisions." : "No decisions recorded." },
    { label: "Tool profiles", value: toolProfiles.length ? toolProfiles.join(", ") : "--", note: toolProfiles.length ? `${formatNumber(toolProfiles.length)} MCP profile${toolProfiles.length === 1 ? "" : "s"} connected.` : "No tool session handshakes recorded." },
    { label: "Duration", value: dur(run.duration_seconds), note: parallelism?.max_parallel_agents > 1 ? `Peak overlap ${formatNumber(parallelism.max_parallel_agents)} agents.` : "" },
    { label: "Started", value: fmt(run.started_at || run.created_at) },
    { label: "Finished", value: fmt(run.finished_at) },
  ];

  async function cancelRun() {
    if (!runId || isCancelling) return;
    setIsCancelling(true);
    setActionError("");
    try {
      const response = await fetch(apiUrl(`/ui/runs/${runId}/cancel`), {
        method: "POST",
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Cancel failed (${response.status})`);
      }
      await refreshRun();
    } catch (nextError) {
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
      const response = await fetch(apiUrl(`/ui/runs/${runId}`), {
        method: "DELETE",
      });
      if (!response.ok) {
        const message = await response.text();
        throw new Error(message || `Delete failed (${response.status})`);
      }
      router.push("/runs");
      router.refresh();
    } catch (nextError) {
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
      const created = await apiFetch("/api/datasets/batches", {
        method: "POST",
        body: JSON.stringify(nextPayload),
      });
      router.push(`/runs?batch=${encodeURIComponent(created.batch_id)}`);
      router.refresh();
    } catch (nextError) {
      setActionError(nextError instanceof Error ? nextError.message : "Restart failed");
    } finally {
      setIsRestarting(false);
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
          </>
        )}
      />

      <DatasetContextCard context={datasetContext} />

      {actionError ? (
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
          <div>{actionError}</div>
        </div>
      ) : null}

      <DiagnosticsGrid items={diagnosticsItems} />

      <SecondaryActionsCard
        run={run}
        canDelete={canDeleteRun(run)}
        isDeleting={isDeleting}
        isRestarting={isRestarting}
        onRestart={restartRun}
        onDelete={deleteRun}
      />

      <RunDetailLive
        runId={runId}
        runUrl={run.url || ""}
        providerUrls={providerUrls}
        providerAnalysis={providerSnapshot.provider_analysis || EMPTY_ARRAY}
        takedownEmails={providerSnapshot.takedown_emails || EMPTY_ARRAY}
        extractionResults={providerSnapshot.extraction_results || EMPTY_ARRAY}
        snapshotScreenshots={screenshots}
        activeTrace={normalizedTrace}
        persistedEvents={runEvents}
        persistedToolCalls={toolCalls}
        initialDecisions={payload?.decisions || EMPTY_ARRAY}
        defaultStreaming={isActiveTrace && !runTerminalState.isTerminal}
        rootActor={run.root_actor || normalizedTrace?.root_actor || ""}
        agentRollups={agentRollups}
        stageRollups={stageRollups}
        parallelism={parallelism}
        primaryProvider={primaryProvider}
        primaryModel={primaryModel}
      />
    </div>
  );
}
