"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { AlertCircle, ExternalLink, RefreshCw, Trash2, XCircle } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import {
  canCancelRun,
  canDeleteRun,
  statusLabel,
  statusTone as runStatusTone,
} from "@/lib/run-status";
import { AgentOutputPanel } from "@/components/agent-output-panel";
import { StreamProviderTab } from "@/components/console/run-detail/stream-provider-tab";
import { DataTable } from "@/components/data-table";
import { KpiCard } from "@/components/kpi-card";
import { RunDetailLive } from "@/components/run-detail-live";
import { LlmOutputPanel } from "@/components/dashboard";
import { ScreenshotGallery } from "@/components/console/run-detail/browser-live-view";
import { useRunViewSettings } from "@/components/run-view-settings";
import { CostEstimateCard, ContextWindowMeter } from "@/components/dashboard";
import { StructuredDataCard } from "@/components/structured-data-card";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmAction } from "@/components/console/common/confirm-action";
import {
  buildContextWindowGroups,
  buildPersistedLlmEvents,
  collectScreenshotUrls,
  extractLlmResponses,
  normalizeTraceEvents,
  summarizeRunState,
} from "@/lib/run-trace";
import { collectRunProviderUrls } from "@/lib/run-log-sync";

const EMPTY_OBJECT = {};
const EMPTY_ARRAY = [];

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
  if (text.includes("404") || /not found/i.test(text))
    return "Run not found in this environment.";
  if (/failed to fetch/i.test(text))
    return "Run data is unavailable right now.";
  return text;
}

function RunMeta({ run, jobState, parallelism }) {
  const classificationValue = run.top_level_page_type
    ? run.classification_confidence
      ? `${run.top_level_page_type} / ${run.classification_confidence}`
      : run.top_level_page_type
    : "unknown";
  const items = [
    { label: "Root actor", value: run.root_actor || jobState?.actor || "unknown" },
    { label: "Duration", value: dur(run.duration_seconds) },
    { label: "Started", value: fmt(run.started_at || run.created_at) },
    { label: "Finished", value: fmt(run.finished_at) },
  ];

  if (classificationValue !== "unknown") {
    items.push({ label: "Classification", value: classificationValue });
  }
  if (run.page_type && run.page_type !== "unknown") {
    items.push({ label: "Page type", value: run.page_type });
  }
  if (parallelism?.max_parallel_agents || parallelism?.current_parallel_agents) {
    items.push({
      label: "Parallel",
      value: `${formatNumber(parallelism?.current_parallel_agents || 0)} live / ${formatNumber(parallelism?.max_parallel_agents || 0)} peak`,
    });
  }

  if (jobState?.status) {
    items.push({
      label: "Job",
      value: `${jobState.display_status || jobState.status} (${jobState.attempts || 0}/${jobState.max_attempts || 0})`,
    });
  }
  if (run.primary_model) {
    items.push({
      label: "Model",
      value: `${run.primary_provider || ""} ${run.primary_model}`.trim(),
    });
  }

  return (
    <dl className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
      {items.map(({ label, value }) => (
        <div
          key={label}
          className="rounded-[12px] border px-3 py-2.5"
          style={{
            borderColor: "var(--line)",
            background: "color-mix(in oklch, var(--card) 88%, transparent)",
          }}
        >
          <dt
            className="text-[10px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: "var(--mute-3)" }}
          >
            {label}
          </dt>
          <dd
            className="mt-1 break-words text-[13px] font-medium"
            style={{ color: "var(--ink)" }}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function ExpandableTable({ title, description, columns, rows, expand }) {
  const showAll = expand;
  const displayed = showAll ? rows : rows.slice(0, 8);
  return (
    <DataTable
      title={title}
      description={
        description
          ? `${description}${!showAll && rows.length > 8 ? ` / ${rows.length - 8} more hidden` : ""}`
          : undefined
      }
      columns={columns}
      rows={displayed}
    />
  );
}

function RunHeader({
  runId,
  url,
  run,
  title,
  subtitle,
  live,
  jobState = null,
  parallelism = null,
  actions = null,
}) {
  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader
        className="px-4 py-4"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in oklch, var(--signal) 8%, transparent), transparent 68%)",
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Breadcrumb>
                <BreadcrumbList className="text-[11px]">
                  <BreadcrumbItem>
                    <Link
                      href="/"
                      className="transition-colors hover:text-foreground"
                    >
                      Console
                    </Link>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <Link
                      href="/runs"
                      className="transition-colors hover:text-foreground"
                    >
                      Runs
                    </Link>
                  </BreadcrumbItem>
                  <BreadcrumbSeparator />
                  <BreadcrumbItem>
                    <BreadcrumbPage className="font-mono text-[11px]">
                      {runId ? `${runId.slice(0, 12)}...` : "--"}
                    </BreadcrumbPage>
                  </BreadcrumbItem>
                </BreadcrumbList>
              </Breadcrumb>
              {live ? (
                <span
                  className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
                  style={{
                    background:
                      "color-mix(in oklch, var(--rose) 14%, transparent)",
                    border:
                      "1px solid color-mix(in oklch, var(--rose) 30%, transparent)",
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
                {runId ? runId.slice(0, 12) : "--"}
              </span>
            </div>
            <span className="owc-eyebrow mt-1">run detail</span>
            <h1
              className="mt-1 font-mono text-[28px] font-semibold leading-none"
              style={{ color: "var(--ink)" }}
            >
              {title || (runId ? `${runId.slice(0, 18)}...` : "Run")}
            </h1>
            {url || subtitle ? (
              <div className="mt-2 flex items-center gap-1.5">
                <p
                  className="max-w-3xl truncate text-[12.5px]"
                  style={{ color: "var(--mute)" }}
                  title={url}
                >
                  {subtitle || url}
                </p>
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="shrink-0"
                    style={{ color: "var(--mute-3)" }}
                  >
                    <ExternalLink className="h-3 w-3" />
                  </a>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            {run?.final_status ? (
              <Badge tone={runStatusTone(run.final_status)} className="mt-1 shrink-0">
                {statusLabel(run.final_status)}
              </Badge>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <span
                className="rounded-full border px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.12em]"
                style={{
                  borderColor: "var(--line)",
                  color: "var(--mute-2)",
                  background: "rgba(255,255,255,0.52)",
                }}
              >
                {String(jobState?.job_type || "").toLowerCase() === "workflow" ? "workflow run" : "agent run"}
              </span>
              <span
                className="rounded-full border px-2.5 py-1 font-mono text-[10px]"
                style={{
                  borderColor: "var(--line)",
                  color: "var(--mute-2)",
                  background: "rgba(255,255,255,0.52)",
                }}
              >
                {formatNumber(parallelism?.current_parallel_agents || 0)} live / {formatNumber(parallelism?.max_parallel_agents || 0)} peak
              </span>
            </div>
            {actions ? <div className="flex flex-wrap justify-end gap-2">{actions}</div> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="border-t px-4 py-4" style={{ borderColor: "var(--line)" }}>
        <RunMeta run={run} jobState={jobState} parallelism={parallelism} />
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

function summarizeProviderAnalysis(entries = []) {
  return (Array.isArray(entries) ? entries : []).reduce((acc, entry, index) => {
    acc[`provider ${index + 1}`] = {
      provider: String(entry?.provider || ""),
      stream_url: String(entry?.stream_url || ""),
      hostname: String(entry?.hostname || ""),
      ip: String(entry?.ip || ""),
      country: String(entry?.country || ""),
      abuse_email: String(entry?.abuse_email || ""),
    };
    return acc;
  }, {});
}

function summarizeTakedownEmails(entries = []) {
  return (Array.isArray(entries) ? entries : []).reduce((acc, entry, index) => {
    acc[`email ${index + 1}`] = {
      provider: String(entry?.provider || ""),
      abuse_email: String(entry?.abuse_email || ""),
      subject: String(entry?.subject || ""),
      infringing_url: String(entry?.infringing_url || ""),
      stream_count: Array.isArray(entry?.stream_urls) ? entry.stream_urls.length : 0,
    };
    return acc;
  }, {});
}

function summarizeStreams(entries = []) {
  return (Array.isArray(entries) ? entries : []).reduce((acc, entry, index) => {
    if (typeof entry === "string") {
      acc[`stream ${index + 1}`] = entry;
      return acc;
    }
    acc[`stream ${index + 1}`] = {
      url: String(entry?.url || ""),
      protocol: String(entry?.protocol || ""),
      provider: String(entry?.provider || ""),
    };
    return acc;
  }, {});
}

function RunFinalOutputsSection({
  snapshot = EMPTY_OBJECT,
  isWorkflowRun = false,
}) {
  if (!isWorkflowRun) return null;

  const providerAnalysis = summarizeProviderAnalysis(snapshot.provider_analysis || EMPTY_ARRAY);
  const takedownEmails = summarizeTakedownEmails(snapshot.takedown_emails || EMPTY_ARRAY);
  const allStreams = summarizeStreams(snapshot.all_streams || EMPTY_ARRAY);
  const allScreenshots = Array.isArray(snapshot.all_screenshots) ? snapshot.all_screenshots : [];

  const cards = [
    {
      title: "Provider analysis",
      description: "Persisted provider lookup results and analysis metadata.",
      data: providerAnalysis,
      emptyLabel: "No provider analysis was persisted for this run.",
    },
    {
      title: "Takedown emails",
      description: "Generated takedown payloads captured in the final snapshot.",
      data: takedownEmails,
      emptyLabel: "No takedown emails were persisted for this run.",
    },
    {
      title: "Streams",
      description: "All collected stream URLs across the run.",
      data: allStreams,
      emptyLabel: "No streams were persisted for this run.",
    },
    {
      title: "Screenshots",
      description: "Captured screenshot URLs from the completed workflow.",
      data: allScreenshots,
      emptyLabel: "No screenshots were persisted for this run.",
    },
  ].filter((card) => {
    if (Array.isArray(card.data)) return card.data.length > 0;
    if (card.data && typeof card.data === "object") return Object.keys(card.data).length > 0;
    return Boolean(card.data);
  });

  if (!cards.length) return null;

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="border-b px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm font-medium">Final outputs</CardTitle>
            <p className="mt-1 text-[12px] text-muted-foreground">
              Workflow-only snapshot data surfaced directly from the persisted run.
            </p>
          </div>
          <Badge tone="signal" className="shrink-0">
            Workflow view
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 p-4 xl:grid-cols-2">
        {cards.map((card) => (
          <StructuredDataCard
            key={card.title}
            title={card.title}
            description={card.description}
            data={card.data}
            limit={5}
            emptyLabel={card.emptyLabel}
          />
        ))}
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
  const [tab, setTab] = useState("workflow");
  const [liveMetrics, setLiveMetrics] = useState(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionError, setActionError] = useState("");
  const tabsHeaderRef = useRef(null);
  const tabListRef = useRef(null);
  const { settings } = useRunViewSettings();

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

  useEffect(() => {
    const jobStatus = String(payload?.job_state?.status || payload?.job?.status || payload?.run?.job_state || "").toLowerCase();
    const runStatus = String(payload?.run?.final_status || payload?.run?.status || "").toLowerCase();
    const shouldRefresh =
      Boolean(payload?.active_trace) ||
      ["queued", "running", "retrying", "leased"].includes(jobStatus) ||
      ["queued", "running", "retrying"].includes(runStatus);
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
  const persistedLlmCalls = payload?.llm_calls ?? EMPTY_ARRAY;
  const liveMetricsSafe = liveMetrics || trace?.metrics || EMPTY_OBJECT;
  const agentRuns = payload?.agent_runs ?? EMPTY_ARRAY;
  const jobStatus = String(payload?.job_state?.status || payload?.job?.status || payload?.run?.job_state || "").toLowerCase();
  const runStatus = String(payload?.run?.final_status || payload?.run?.status || "").toLowerCase();
  const shouldRefresh = useMemo(
    () =>
      Boolean(payload?.active_trace) ||
      ["queued", "running", "retrying", "leased"].includes(jobStatus) ||
      ["queued", "running", "retrying"].includes(runStatus),
    [jobStatus, payload?.active_trace, runStatus],
  );
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
  const activeLlmCalls = useMemo(() => extractLlmResponses(runEvents), [runEvents]);
  const llmCalls = useMemo(
    () => (isActiveTrace ? activeLlmCalls : (persistedLlmCalls.length ? persistedLlmCalls : activeLlmCalls)),
    [activeLlmCalls, isActiveTrace, persistedLlmCalls],
  );
  const runState = useMemo(() => summarizeRunState(runEvents), [runEvents]);
  const contextFromEvents = !isActiveTrace && !persistedLlmCalls.length && activeLlmCalls.length > 0;
  const contextGroups = useMemo(
    () =>
      buildContextWindowGroups({
        events: runEvents,
        llmCalls,
        agentRuns,
        active: isActiveTrace || contextFromEvents,
      }),
    [agentRuns, contextFromEvents, isActiveTrace, llmCalls, runEvents],
  );
  const llmOutputEvents = useMemo(() => {
    const hasLlmEvents = runEvents.some((event) =>
      ["llm_response", "llm_error", "llm_timeout", "llm_rate_limited"].includes(String(event?.kind || "")),
    );
    if (hasLlmEvents) return runEvents;
    return buildPersistedLlmEvents({ llmCalls: persistedLlmCalls, agentRuns });
  }, [agentRuns, persistedLlmCalls, runEvents]);
  const providerSnapshot = useMemo(
    () => ({
      all_streams: snapshot.all_streams || payload?.all_streams || EMPTY_ARRAY,
      provider_analysis: snapshot.provider_analysis || payload?.provider_analysis || EMPTY_ARRAY,
      takedown_emails: snapshot.takedown_emails || payload?.takedown_emails || EMPTY_ARRAY,
    }),
    [payload?.all_streams, payload?.provider_analysis, payload?.takedown_emails, snapshot],
  );
  const providerUrls = useMemo(
    () => collectRunProviderUrls({ snapshot: providerSnapshot, events: runEvents }),
    [providerSnapshot, runEvents],
  );

  useEffect(() => {
    if (tabsHeaderRef.current) {
      tabsHeaderRef.current.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    }
    const active = tabListRef.current?.querySelector("[data-state='active']");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [tab]);

  const screenshots = useMemo(() => {
    const urls = new Set();
    collectScreenshotUrls(snapshot.all_screenshots || EMPTY_ARRAY, urls);
    collectScreenshotUrls(payload?.all_screenshots || EMPTY_ARRAY, urls);
    for (const event of runEvents) {
      collectScreenshotUrls(event?.details, urls);
      collectScreenshotUrls(event?.details_json, urls);
    }
    return Array.from(urls);
  }, [payload?.all_screenshots, runEvents, snapshot]);

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Card className="overflow-hidden shadow-card">
          <CardHeader className="space-y-3 border-b px-4 py-4">
            <Skeleton className="h-3 w-40" />
            <Skeleton className="h-6 w-72" />
            <Skeleton className="h-4 w-96" />
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 px-4 py-4 sm:grid-cols-4">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-4 w-28" />
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, idx) => (
            <Skeleton key={idx} className="h-24 rounded-xl" />
          ))}
        </div>
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
            <div className="mt-0.5 text-[12.5px] opacity-90">
              {error || "Run not found"}
            </div>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/runs">Back to runs</Link>
        </Button>
      </div>
    );
  }

  const run = payload.run || EMPTY_OBJECT;
  const agentOutputs = payload.agent_outputs || EMPTY_ARRAY;
  const agentRollups = payload.agent_rollups || EMPTY_ARRAY;
  const stageRollups = payload.stage_rollups || EMPTY_ARRAY;
  const modelUsage = payload.model_usage || EMPTY_ARRAY;
  const parallelism = payload.parallelism || {
    current_parallel_agents: 0,
    max_parallel_agents: 0,
  };
  const toolCalls = payload.tool_calls || EMPTY_ARRAY;
  const jobState = payload.job_state || payload.job || null;
  const datasetContext = payload.dataset_context || null;
  const degradedFallback = payload.source === "background_job_result";
  const telemetryStatus = String(payload.telemetry_status || run.telemetry_status || "").trim().toLowerCase();
  const telemetryMissing = degradedFallback && telemetryStatus === "missing";
  const missingMetricValue = telemetryMissing ? "--" : null;
  const metricDescription = (fallback, normal) => (telemetryMissing ? "Trace not persisted" : normal || fallback);

  const llmCallCount = isActiveTrace
    ? Math.max(Number(liveMetricsSafe.total_llm_calls || 0), llmCalls.length)
    : Math.max(Number(run.total_llm_calls || 0), llmCalls.length);
  const toolCallCount = isActiveTrace
    ? Math.max(Number(liveMetricsSafe.total_tool_calls || 0), toolCalls.length)
    : Math.max(Number(run.total_tool_calls || 0), toolCalls.length);
  const tokensIn = isActiveTrace
    ? Number(liveMetricsSafe.total_tokens_in || 0)
    : Number(run.total_tokens_in || 0);
  const tokensOut = isActiveTrace
    ? Number(liveMetricsSafe.total_tokens_out || 0)
    : Number(run.total_tokens_out || 0);
  const runMode = String(jobState?.job_type || run.job_type || "").trim().toLowerCase();
  const rootActorMode = String(
    run.root_actor || normalizedTrace?.root_actor || jobState?.actor || "",
  )
    .trim()
    .toLowerCase();
  const inferredRunMode = runMode || (rootActorMode === "orchestrator" ? "workflow" : rootActorMode ? "agent" : "");
  const isAgentRun = inferredRunMode === "agent";
  const isWorkflowRun = inferredRunMode === "workflow" || rootActorMode === "orchestrator";
  const providerAnalysis = snapshot.provider_analysis || EMPTY_ARRAY;
  const takedownEmails = snapshot.takedown_emails || EMPTY_ARRAY;
  const allStreams = snapshot.all_streams || EMPTY_ARRAY;
  const allScreenshots = snapshot.all_screenshots || EMPTY_ARRAY;
  const hasFinalOutputs =
    (Array.isArray(providerAnalysis) && providerAnalysis.length > 0) ||
    (Array.isArray(takedownEmails) && takedownEmails.length > 0) ||
    (Array.isArray(allStreams) && allStreams.length > 0) ||
    (Array.isArray(allScreenshots) && allScreenshots.length > 0);
  const showFinalOutputs = isWorkflowRun && hasFinalOutputs;

  const kpis = [
    {
      label: "LLM Calls",
      value: missingMetricValue || formatNumber(llmCallCount),
      accent: "violet",
      description: metricDescription("Model completions", "Model completions"),
    },
    {
      label: "Tool Calls",
      value: missingMetricValue || formatNumber(toolCallCount),
      accent: "sky",
      description: metricDescription("MCP tool calls", "MCP tool calls"),
    },
    {
      label: "Tokens",
      value: missingMetricValue || formatNumber(tokensIn + tokensOut),
      accent: "signal",
      description: telemetryMissing
        ? "Trace not persisted"
        : `${formatNumber(tokensIn)} in / ${formatNumber(tokensOut)} out`,
    },
    {
      label: "Parallel",
      value: missingMetricValue || `${formatNumber(parallelism.current_parallel_agents || 0)} / ${formatNumber(parallelism.max_parallel_agents || 0)}`,
      accent: "signal",
      description: telemetryMissing ? "Trace not persisted" : "Live / peak agents",
    },
      {
        label: "Screenshots",
        value: missingMetricValue || formatNumber(Math.max(Number(run.screenshot_count || 0), screenshots.length)),
        accent: "sky",
        description: metricDescription("Captures taken", "Captures taken"),
      },
      {
        label: "Streams",
        value: missingMetricValue || formatNumber(Math.max(Number(run.stream_count || 0), allStreams.length)),
        accent: "signal",
        description: metricDescription("Stream URLs found", "Stream URLs found"),
      },
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

  const topLevelKpis = kpis.filter((kpi) =>
    ["LLM Calls", "Tool Calls", "Tokens", "Screenshots"].includes(kpi.label),
  );

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
        url={run.url || normalizedTrace?.metrics?.url}
        run={run}
        live={isActiveTrace}
        jobState={jobState}
        parallelism={parallelism}
        subtitle={isActiveTrace ? "Streaming from in-memory observer" : null}
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
            {canDeleteRun(run) ? (
              <ConfirmAction
                title="Delete this run?"
                description="Removes the run and its persisted telemetry. This cannot be undone."
                actionLabel={isDeleting ? "Deleting..." : "Delete run"}
                onConfirm={deleteRun}
                trigger={(
                  <Button type="button" variant="outline" size="sm" disabled={isDeleting}>
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                )}
              />
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

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {topLevelKpis.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div ref={tabsHeaderRef} className="rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
          <div ref={tabListRef} className="max-w-full overflow-x-auto">
          <TabsList className="h-auto w-max min-w-full flex-nowrap justify-start gap-1 border-0 bg-transparent p-0 shadow-none">
            <TabsTrigger value="workflow">Workflow</TabsTrigger>
            <TabsTrigger value="reasoning">
              Reasoning
              {llmCalls.length ? (
                <Badge tone="violet" className="ml-1 px-1.5 py-0 text-[10px]">
                  {llmCalls.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="agents">
              Agents
              {agentRollups.length || agentOutputs.length || contextGroups.length ? (
                <Badge tone="signal" className="ml-1 px-1.5 py-0 text-[10px]">
                  {Math.max(agentRollups.length || agentOutputs.length, contextGroups.length)}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="data">
              Tables
              {agentRuns.length + toolCalls.length + persistedLlmCalls.length + modelUsage.length ? (
                <Badge tone="violet" className="ml-1 px-1.5 py-0 text-[10px]">
                  {agentRuns.length + toolCalls.length + persistedLlmCalls.length + modelUsage.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            {settings.showScreenshots ? (
              <TabsTrigger value="screenshots">
                Screenshots
                {screenshots.length > 0 ? (
                  <Badge tone="sky" className="ml-1 px-1.5 py-0 text-[10px]">
                    {screenshots.length}
                  </Badge>
                ) : null}
              </TabsTrigger>
            ) : null}
            {providerUrls.length > 0 ? (
              <TabsTrigger value="providers">Provider Intel</TabsTrigger>
            ) : null}
          </TabsList>
          </div>
        </div>

        <TabsContent value="workflow" className="space-y-4">
          <RunDetailLive
            runId={runId}
            activeTrace={normalizedTrace}
            persistedEvents={runEvents}
            persistedToolCalls={toolCalls}
            initialDecisions={payload?.decisions || EMPTY_ARRAY}
            defaultStreaming={isActiveTrace}
            rootActor={run.root_actor || normalizedTrace?.root_actor || ""}
            onMetricsChange={(next) => {
              setLiveMetrics(next);
            }}
          />
        </TabsContent>

        <TabsContent value="reasoning">
          <LlmOutputPanel
            events={llmOutputEvents}
            emptyMessage={
              telemetryMissing
                ? "No LLM calls were persisted for this run."
                : undefined
            }
          />
        </TabsContent>

        <TabsContent value="agents" className="space-y-4">
          <div className="grid gap-3 lg:grid-cols-2">
            <ContextWindowMeter
              llmCalls={llmCalls}
              primaryModel={run.primary_model}
              primaryProvider={run.primary_provider}
              groups={contextGroups}
              focusKey={runState?.active?.actor || runState?.active?.stage || ""}
            />
            <CostEstimateCard
              llmCalls={llmCalls}
              modelUsage={modelUsage}
              agentRollups={agentRollups}
              unavailable={telemetryMissing}
            />
          </div>
          <AgentOutputPanel
            stageRollups={stageRollups}
            agentRollups={agentRollups}
            parallelism={parallelism}
            title={
              isAgentRun ? "Agent output" : "Workflow outputs"
            }
          />
        </TabsContent>

        <TabsContent value="data">
          <div className="space-y-5">
            <div className="grid gap-5 xl:grid-cols-2">
              <ExpandableTable
                title="Agent Runs"
                description="Per-agent normalized execution records"
                columns={[
                  "actor",
                  "agent_type",
                  "status",
                  "tool_calls_made",
                  "llm_calls_made",
                  "duration_seconds",
                ]}
                rows={agentRuns}
                expand={settings.expandTables}
              />
              <ExpandableTable
                title="Tool Calls"
                description="Tool usage and reliability trail"
                columns={[
                  "seq",
                  "actor",
                  "tool_name",
                  "status",
                  "duration_seconds",
                  "target_summary",
                ]}
                rows={toolCalls}
                expand={settings.expandTables}
              />
            </div>
            <div className="grid gap-5 xl:grid-cols-2">
              <ExpandableTable
                title="Model Usage"
                description="Persisted provider/model cost totals for this run"
                columns={[
                  "provider",
                  "model_name",
                  "llm_calls",
                  "input_tokens",
                  "cached_input_tokens",
                  "new_input_tokens",
                  "output_tokens",
                  "estimated_total_cost_usd",
                ]}
                rows={modelUsage}
                expand={settings.expandTables}
              />
              <ExpandableTable
                title="LLM Calls"
                description="Prompt, token, and cost telemetry"
                columns={[
                  "seq",
                  "actor",
                  "provider",
                  "model_name",
                  "input_tokens",
                  "cached_input_tokens",
                  "new_input_tokens",
                  "output_tokens",
                  "context_window",
                  "total_cost_usd",
                  "cost_source",
                ]}
                rows={persistedLlmCalls}
                expand={settings.expandTables}
              />
              <ExpandableTable
                title="Agent Outputs"
                description="Normalized per-agent output records"
                columns={[
                  "agent_run_id",
                  "actor",
                  "agent_type",
                  "summary_text",
                  "validation_status",
                  "stream_count",
                ]}
                rows={agentOutputs}
                expand={settings.expandTables}
              />
            </div>
            <RunFinalOutputsSection snapshot={snapshot} isWorkflowRun={showFinalOutputs} />
          </div>
        </TabsContent>

        <TabsContent value="screenshots">
          <ScreenshotGallery screenshots={screenshots} />
        </TabsContent>

        <TabsContent value="providers">
          <StreamProviderTab runId={runId} runUrl={run.url} streamUrls={providerUrls} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
