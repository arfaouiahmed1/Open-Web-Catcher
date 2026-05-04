"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronLeft, ExternalLink } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { statusLabel, statusTone as runStatusTone } from "@/lib/run-status";
import { AgentOutputPanel } from "@/components/agent-output-panel";
import { DataTable } from "@/components/data-table";
import { KpiCard } from "@/components/kpi-card";
import { RunDetailLive } from "@/components/console/run-detail/run-detail-live";
import { LlmOutputPanel } from "@/components/dashboard";
import { TimelinePanel } from "@/components/timeline-panel";
import { ScreenshotGallery } from "@/components/console/run-detail/browser-live-view";
import { useRunViewSettings } from "@/components/run-view-settings";
import { CostEstimateCard, ContextWindowMeter } from "@/components/dashboard";
import { synthCallsFromModelUsage } from "@/lib/pricing";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  buildContextWindowGroups,
  summarizeRunState,
} from "@/lib/run-trace";

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
  const items = [
    { label: "Root actor", value: run.root_actor || jobState?.actor || "--" },
    { label: "Page type", value: run.page_type || "--" },
    { label: "Duration", value: dur(run.duration_seconds) },
    { label: "Started", value: fmt(run.started_at || run.created_at) },
    { label: "Finished", value: fmt(run.finished_at) },
    {
      label: "Parallel",
      value: `${formatNumber(parallelism?.current_parallel_agents || 0)} live / ${formatNumber(parallelism?.max_parallel_agents || 0)} peak`,
    },
  ];

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
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      {items.map(({ label, value }) => (
        <div key={label}>
          <dt
            className="text-[10px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: "var(--mute-3)" }}
          >
            {label}
          </dt>
          <dd
            className="mt-0.5 text-[12.5px]"
            style={{ color: "var(--ink-dim)" }}
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
          ? `${description}${!showAll && rows.length > 8 ? ` · ${rows.length - 8} more hidden` : ""}`
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
}) {
  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="border-b px-4 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link
                href="/runs"
                className="flex items-center gap-1 text-[11px] transition-colors"
                style={{ color: "var(--mute-2)" }}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Runs
              </Link>
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
            </div>
            <span className="owc-eyebrow mt-1">run detail</span>
            <h1
              className="mt-1 font-mono text-xl font-semibold"
              style={{ color: "var(--ink)" }}
            >
              {title || (runId ? `${runId.slice(0, 18)}...` : "Run")}
            </h1>
            {url || subtitle ? (
              <div className="mt-0.5 flex items-center gap-1.5">
                <p
                  className="max-w-xl truncate text-[12px]"
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
          {run?.final_status ? (
            <Badge tone={runStatusTone(run.final_status)} className="mt-1 shrink-0">
              {statusLabel(run.final_status)}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="px-4 py-4 pt-0">
        <RunMeta run={run} jobState={jobState} parallelism={parallelism} />
      </CardContent>
    </Card>
  );
}

export function RunDetailPage() {
  const { runId } = useParams();
  const [payload, setPayload] = useState(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("live");
  const [liveMetrics, setLiveMetrics] = useState(null);
  const [liveLlmCalls, setLiveLlmCalls] = useState(null);
  const { settings } = useRunViewSettings();

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
    if (!payload?.active_trace) return undefined;
    const id = setInterval(() => {
      apiFetch(`/ui/runs/${runId}`)
        .then((next) => {
          setPayload(next);
          if (!next?.active_trace) clearInterval(id);
        })
        .catch(() => {});
    }, 5000);
    return () => clearInterval(id);
  }, [payload?.active_trace, runId]);

  const isActiveTrace = Boolean(payload?.active_trace);
  const trace = isActiveTrace ? payload.active_trace : null;
  const snapshot = payload?.snapshot ?? EMPTY_OBJECT;
  const events = payload?.events ?? EMPTY_ARRAY;
  const persistedLlmCalls = payload?.llm_calls ?? EMPTY_ARRAY;
  const liveMetricsSafe = liveMetrics || trace?.metrics || EMPTY_OBJECT;
  const agentRuns = payload?.agent_runs ?? EMPTY_ARRAY;
  const traceEvents = trace?.events || EMPTY_ARRAY;
  const runEvents = isActiveTrace ? traceEvents : events;
  const runState = useMemo(() => summarizeRunState(runEvents), [runEvents]);
  const contextGroups = useMemo(
    () =>
      buildContextWindowGroups({
        events: runEvents,
        llmCalls: persistedLlmCalls,
        agentRuns,
        active: isActiveTrace,
      }),
    [agentRuns, isActiveTrace, persistedLlmCalls, runEvents],
  );

  const screenshots = useMemo(() => {
    const fromSnapshot = (snapshot.all_screenshots || []).filter(Boolean);
    const fromEvents = events
      .map(
        (event) =>
          event?.details?.screenshot_url ||
          event?.details?.result_full?.screenshot_url ||
          event?.details_json?.screenshot_url ||
          event?.details_json?.result_full?.screenshot_url,
      )
      .filter(Boolean);
    return [...new Set([...fromSnapshot, ...fromEvents])];
  }, [snapshot, events]);

  const llmCalls = useMemo(() => {
    if (isActiveTrace) {
      const synth = synthCallsFromModelUsage(liveMetricsSafe.model_usage);
      if (synth.length) return synth;
      if (Array.isArray(liveLlmCalls) && liveLlmCalls.length) return liveLlmCalls;
    }
    return persistedLlmCalls;
  }, [isActiveTrace, liveMetricsSafe, liveLlmCalls, persistedLlmCalls]);

  if (isLoading) {
    return (
      <div
        className="flex h-64 items-center justify-center gap-3"
        style={{ color: "var(--mute)" }}
      >
        <span
          className="owc-spinner owc-spinner-lg"
          style={{ color: "var(--signal)" }}
        />
        <span className="text-[13px]">Loading run...</span>
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div
        className="flex h-64 flex-col items-center justify-center gap-3"
        style={{ color: "var(--mute)" }}
      >
        <div className="text-[13px]" style={{ color: "var(--rose)" }}>
          {error || "Run not found"}
        </div>
        <Link
          href="/runs"
          className="text-[12px]"
          style={{ color: "var(--signal)" }}
        >
          Back to runs
        </Link>
      </div>
    );
  }

  const run = payload.run || EMPTY_OBJECT;
  const agentOutputs = payload.agent_outputs || EMPTY_ARRAY;
  const agentRollups = payload.agent_rollups || EMPTY_ARRAY;
  const stageRollups = payload.stage_rollups || EMPTY_ARRAY;
  const parallelism = payload.parallelism || {
    current_parallel_agents: 0,
    max_parallel_agents: 0,
  };
  const toolCalls = payload.tool_calls || EMPTY_ARRAY;
  const jobState = payload.job_state || payload.job || null;

  const llmCallCount = isActiveTrace
    ? Number(liveMetricsSafe.total_llm_calls || llmCalls.length || 0)
    : Number(run.total_llm_calls || llmCalls.length || 0);
  const toolCallCount = isActiveTrace
    ? Number(liveMetricsSafe.total_tool_calls || 0)
    : Number(run.total_tool_calls || toolCalls.length || 0);
  const tokensIn = isActiveTrace
    ? Number(liveMetricsSafe.total_tokens_in || 0)
    : Number(run.total_tokens_in || 0);
  const tokensOut = isActiveTrace
    ? Number(liveMetricsSafe.total_tokens_out || 0)
    : Number(run.total_tokens_out || 0);

  const kpis = [
    {
      label: "LLM Calls",
      value: formatNumber(llmCallCount),
      accent: "violet",
      description: "Model completions",
    },
    {
      label: "Tool Calls",
      value: formatNumber(toolCallCount),
      accent: "sky",
      description: "MCP tool calls",
    },
    {
      label: "Tokens",
      value: formatNumber(tokensIn + tokensOut),
      accent: "signal",
      description: `${formatNumber(tokensIn)} in / ${formatNumber(tokensOut)} out`,
    },
    {
      label: "Parallel",
      value: `${formatNumber(parallelism.current_parallel_agents || 0)} / ${formatNumber(parallelism.max_parallel_agents || 0)}`,
      accent: "signal",
      description: "Live / peak agents",
    },
    {
      label: "Screenshots",
      value: formatNumber(run.screenshot_count || screenshots.length || 0),
      accent: "sky",
      description: "Captures taken",
    },
    {
      label: "Streams",
      value: formatNumber(run.stream_count || 0),
      accent: "signal",
      description: "Stream URLs found",
    },
  ];

  return (
    <div className="space-y-5">
      <RunHeader
        runId={runId}
        url={run.url || trace?.metrics?.url}
        run={run}
        live={isActiveTrace}
        jobState={jobState}
        parallelism={parallelism}
        subtitle={isActiveTrace ? "Streaming from in-memory observer" : null}
      />

      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {kpis.map((kpi) => (
          <KpiCard key={kpi.label} {...kpi} />
        ))}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <ContextWindowMeter
          llmCalls={llmCalls}
          primaryModel={run.primary_model}
          primaryProvider={run.primary_provider}
          groups={contextGroups}
          focusKey={runState?.active?.stage || ""}
        />
        <CostEstimateCard llmCalls={llmCalls} />
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
          <TabsList className="h-auto flex-wrap justify-start gap-1 border-0 bg-transparent p-0 shadow-none">
            <TabsTrigger value="live">Live &amp; Graph</TabsTrigger>
            <TabsTrigger value="outputs">
              Outputs
              {agentRollups.length || agentOutputs.length ? (
                <Badge tone="signal" className="ml-1 px-1.5 py-0 text-[10px]">
                  {agentRollups.length || agentOutputs.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="data">
              Tables
              {agentRuns.length + toolCalls.length + persistedLlmCalls.length ? (
                <Badge tone="violet" className="ml-1 px-1.5 py-0 text-[10px]">
                  {agentRuns.length + toolCalls.length + persistedLlmCalls.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            {screenshots.length > 0 && settings.showScreenshots ? (
              <TabsTrigger value="screenshots">
                Screenshots
                <Badge tone="sky" className="ml-1 px-1.5 py-0 text-[10px]">
                  {screenshots.length}
                </Badge>
              </TabsTrigger>
            ) : null}
          </TabsList>
        </div>

        <TabsContent value="live" className="space-y-4">
          <div className="space-y-4">
            <RunDetailLive
              runId={runId}
              activeTrace={trace}
              persistedEvents={isActiveTrace ? traceEvents : events}
              defaultStreaming={isActiveTrace}
              rootActor={run.root_actor || trace?.root_actor || ""}
              onMetricsChange={(next) => {
                setLiveMetrics(next);
                if (Array.isArray(next?.llm_calls)) setLiveLlmCalls(next.llm_calls);
              }}
            />
            {!isActiveTrace && events.length > 2 ? (
              <TimelinePanel events={events} />
            ) : null}
            <LlmOutputPanel events={isActiveTrace ? traceEvents : events} />
          </div>
        </TabsContent>

        <TabsContent value="outputs">
          <AgentOutputPanel
            stageRollups={stageRollups}
            agentRollups={agentRollups}
            parallelism={parallelism}
            title={
              jobState?.job_type === "agent" ? "Agent output" : "Workflow outputs"
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
                title="LLM Calls"
                description="Prompt, token, and cost telemetry"
                columns={[
                  "seq",
                  "provider",
                  "model_name",
                  "input_tokens",
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
          </div>
        </TabsContent>

        <TabsContent value="screenshots">
          <ScreenshotGallery screenshots={screenshots} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
