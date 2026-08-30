"use client";

// NOTE(T44): This component previously duplicated raw EventSource logic. It now delegates
// live streaming to useRunStream (SSE) and only keeps local UI state. See use-run-stream.ts for the canonical stream.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Loader2, Square, Wrench, XCircle } from "lucide-react";
import { apiFetch, apiUrl, eventSourceUrl } from "@/lib/api";
import { buildRunDetailFilterOptions } from "@/lib/run-detail-filters";
import { buildRunDetailTabState } from "@/lib/run-detail-layout";
import { buildStageView, extractToolCalls, getRunTerminalState, normalizeTraceEvents, STAGE_LABELS, summarizeRunState } from "@/lib/run-trace";
import { buildAutoDecisionSync } from "@/lib/run-log-sync";
import { AgentOutputTab } from "@/components/console/run-detail/agent-output-tab";
import { BrowserLiveView } from "@/components/console/run-detail/browser-live-view";
import { StreamProviderTab } from "@/components/console/run-detail/stream-provider-tab";
import { TracePanel } from "@/components/run-log-panels";
import { OrchestratorGraph } from "@/components/orchestrator-graph";
import { RuntimeEventsPanel } from "@/components/runtime-events-panel";
import { ToolCallFeed } from "@/components/tool-call-feed";
import { StructuredDataCard } from "@/components/structured-data-card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatTimestamp, parseTimestamp } from "@/lib/datetime";
import { useRunStream } from "@/lib/use-run-stream";

export interface RunDetailLiveProps {
  runId: string;
  runUrl?: string;
  providerUrls?: unknown[];
  providerAnalysis?: unknown[];
  takedownEmails?: unknown[];
  extractionResults?: unknown[];
  snapshotScreenshots?: unknown[];
  activeTrace?: { events?: Array<Record<string, unknown>> } | null;
  persistedEvents?: Array<Record<string, unknown>>;
  persistedToolCalls?: Array<Record<string, unknown>>;
  initialDecisions?: unknown[];
  agentRollups?: Array<Record<string, unknown>>;
  stageRollups?: Array<Record<string, unknown>>;
  parallelism?: unknown;
  metrics?: Record<string, unknown> | null;
  onMetricsChange?: ((metrics: Record<string, unknown>) => void) | null;
  primaryProvider?: string;
  primaryModel?: string;
  defaultStreaming?: boolean | null;
  rootActor?: string;
  initialEvents?: Array<Record<string, unknown>>;
}
interface TraceEvent extends Record<string, unknown> { seq?: number; kind?: string; actor?: string; status?: string; message?: string; timestamp?: string; details?: Record<string, unknown>; }

const STAGE_TONE: Record<string, string> = {
  done: "success",
  failed: "danger",
  running: "signal",
  active: "signal",
  cancelled: "warning",
  idle: "default",
};

function stageDot(status: string): string {
  const map: Record<string, string> = {
    done: "var(--mint)",
    failed: "var(--rose)",
    running: "var(--signal)",
    active: "var(--signal)",
    cancelled: "var(--signal)",
    idle: "var(--mute-3)",
  };
  return map[status] || map.idle;
}

function StageStatusRow({ stages }: { stages: Array<{ stage: string; status: string; liveLabel?: string }> }): React.JSX.Element | null {
  if (!Array.isArray(stages) || !stages.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card/60 px-3 py-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        Agents
      </span>
      <Separator orientation="vertical" className="mx-1 h-4" />
      {stages.map((stage) => {
        const tone = STAGE_TONE[stage.status] || "default";
        const isAnimated = stage.status === "running" || stage.status === "active";
        return (
          <div
            key={stage.stage}
            className="flex items-center gap-1.5 rounded-full border border-border/70 bg-background/40 px-2 py-0.5"
            title={`${stage.stage} / ${stage.status} / ${stage.liveLabel}`}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: stageDot(stage.status),
                animation: isAnimated ? "breathe 1.2s ease-in-out infinite" : undefined,
              }}
            />
            <span className="font-mono text-[10.5px] text-foreground/90">
              {(STAGE_LABELS as unknown as Record<string,string>)[stage.stage] || stage.stage}
            </span>
            <Badge tone={tone as unknown as never} className="px-1.5 py-0 text-[9.5px] uppercase">
              {stage.status}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}

function FailureDetailsCard({ failure }: { failure: { kind?: string; actor?: string; stage?: string; message?: string; event?: TraceEvent | null } | null }): React.JSX.Element | null {
  if (!failure) return null;
  const event = failure.event || null;
  const details = event?.details || {};
  const errorPreview: string = String(
    (details as Record<string,unknown>).error_preview ??
    (details as Record<string,unknown>).error ??
    (details as Record<string,unknown>).cancel_reason ??
    failure.message ??
    event?.message ??
    "Unknown failure") as string;
  const stack = String((details as Record<string,unknown>).stack_trace ?? (details as Record<string,unknown>).traceback ?? "");
  return (
    <div
      role="alert"
      className="rounded-xl border px-4 py-3"
      style={{
        borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
        background: "color-mix(in oklch, var(--rose) 8%, transparent)",
      }}
    >
      <div className="flex flex-wrap items-start gap-3">
        <span
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
          style={{
            background: "color-mix(in oklch, var(--rose) 16%, transparent)",
            color: "var(--rose)",
          }}
        >
          <XCircle className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-semibold" style={{ color: "var(--rose)" }}>
              Failure detected
            </span>
            {failure.kind ? (
              <Badge tone="danger" className="font-mono uppercase">
                {failure.kind}
              </Badge>
            ) : null}
            {failure.actor ? (
              <Badge tone="default" className="font-mono">
                {failure.actor}
              </Badge>
            ) : null}
            {failure.stage ? (
              <span className="font-mono text-[10px] text-muted-foreground">
                stage: {failure.stage}
              </span>
            ) : null}
            {event?.timestamp ? (
              <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                {formatTimestamp(event.timestamp)}
              </span>
            ) : null}
          </div>
          <div className="mt-1.5 break-words font-mono text-[11.5px]" style={{ color: "var(--rose)" }}>
            {errorPreview}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="h-7 text-[11px]">
                  View full error details
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-4xl p-0">
                <div className="border-b border-border px-5 py-4">
                  <DialogHeader>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="danger" className="font-mono uppercase">
                        {failure.kind || "failure"}
                      </Badge>
                      {failure.actor ? (
                        <Badge tone="default" className="font-mono">{failure.actor}</Badge>
                      ) : null}
                    </div>
                    <DialogTitle className="mt-2 text-sm font-medium">{errorPreview}</DialogTitle>
                    <DialogDescription className="font-mono text-[11px]">
                      {event?.timestamp ? formatTimestamp(event.timestamp) : ""}
                    </DialogDescription>
                  </DialogHeader>
                </div>
                <div className="space-y-4 px-5 py-4">
                  {stack ? (
                    <ScrollArea className="max-h-[260px] rounded-md border border-border bg-muted/30">
                      <pre className="whitespace-pre-wrap break-all p-3 font-mono text-[11px] leading-relaxed text-foreground/90">
                        {stack}
                      </pre>
                    </ScrollArea>
                  ) : null}
                  <StructuredDataCard
                    title="Event details"
                    data={details}
                    defaultMode="table"
                    search
                  />
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </div>
    </div>
  );
}

function PanelLoadingSkeleton({ label = "Waiting for events" }: { label?: string }): React.JSX.Element {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b px-4 py-3">
        <Skeleton className="h-4 w-40" />
      </CardHeader>
      <CardContent className="space-y-3 p-4">
        {[90, 70, 80, 60].map((w, idx) => (
          <div key={idx} className="flex items-center gap-3">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-3 flex-1" style={{ maxWidth: `${w}%` }} />
          </div>
        ))}
        <div className="pt-1 text-center text-[11px] text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

function eventKey(event: TraceEvent): string {
  const seq = event?.seq;
  if (seq != null) return String(seq);
  return `${event?.timestamp ?? ""}-${event?.actor ?? ""}-${event?.kind ?? ""}-${event?.status ?? ""}`;
}

function seedMap(events: TraceEvent[]): Map<string, TraceEvent> {
  const map = new Map();
  for (const event of events) map.set(eventKey(event), event);
  return map;
}

function ActivityBanner({ state }: { state: { active?: { type: string; title: string; message?: string; stage?: string }; lastCompleted?: { title: string; message?: string } | null } }): React.JSX.Element | null {
  if (!state?.active && !state?.lastCompleted) return null;

  const active = state.active;
  const recent = state.lastCompleted;
  let icon = CheckCircle2;
  let tone = "var(--mint)";
  let title = "";
  let detail = "";

  if (active?.type === "failed") {
    icon = XCircle;
    tone = "var(--rose)";
    title = active.title;
    detail = active.message || "The latest trace event reports a failure.";
  } else if (active?.type === "cancelled") {
    icon = AlertTriangle;
    tone = "var(--signal)";
    title = active.title;
    detail = active.message || "Execution was cancelled.";
  } else if (active?.type === "llm") {
    icon = Cpu;
    tone = "var(--violet)";
    title = active.title;
    detail = active.message || "Waiting for the model to respond.";
  } else if (active?.type === "tool") {
    icon = Wrench;
    tone = "var(--signal)";
    title = active.title;
    detail = active.message || "Waiting for the tool call to finish.";
  } else if (active?.type === "done") {
    icon = CheckCircle2;
    tone = "var(--mint)";
    title = active.title;
    detail = active.message || "The run has completed.";
  } else if (recent) {
    title = recent.title;
    detail = String(recent.message ?? "");
  }

  const Icon = icon;

  return (
    <div
      className="flex flex-wrap items-start gap-3 rounded-[12px] border px-3 py-3"
      style={{
        borderColor: `color-mix(in oklch, ${tone} 30%, transparent)`,
        background: `color-mix(in oklch, ${tone} 8%, transparent)`,
      }}
    >
      <span
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
        style={{
          background: `color-mix(in oklch, ${tone} 16%, transparent)`,
          color: tone,
        }}
      >
        {active?.type === "llm" || active?.type === "tool" ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Icon className="h-4 w-4" />
        )}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-semibold" style={{ color: tone }}>
            {title || "Live activity"}
          </span>
          {active?.stage ? (
            <span
              className="rounded-full px-2 py-0.5 font-mono text-[9.5px]"
              style={{
                background: "rgba(0,0,0,0.12)",
                color: "var(--ink-dim)",
              }}
            >
              {active.stage}
            </span>
          ) : null}
        </div>
        <div className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--ink-dim)" }}>
          {detail || "Watching the latest run event."}
        </div>
      </div>

      {recent && active?.type !== "failed" && active?.type !== "cancelled" ? (
        <div className="min-w-[210px] rounded-[10px] border px-3 py-2 text-[11px]" style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.08)" }}>
          <div style={{ color: "var(--mute-3)" }}>Last completed</div>
          <div className="mt-1 font-medium" style={{ color: "var(--ink-dim)" }}>
            {recent.title}
          </div>
          <div className="mt-0.5" style={{ color: "var(--mute-2)" }}>
            {recent.message || "No recent completion details."}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function RunDetailLive({
  runId,
  runUrl = "",
  providerUrls = [],
  providerAnalysis = [],
  takedownEmails = [],
  extractionResults = [],
  snapshotScreenshots = [],
  activeTrace = null,
  persistedEvents = [],
  persistedToolCalls = [],
  initialDecisions = [],
  agentRollups = [],
  stageRollups = [],
  parallelism = null,
  metrics = null,
  onMetricsChange = null,
  primaryProvider = "",
  primaryModel = "",
  defaultStreaming = null,
  rootActor: rootActorOverride = "",
}: RunDetailLiveProps) {
  const eventMapRef = useRef<Map<string, TraceEvent> | null>(null);
  const expectedCloseRef = useRef<boolean>(false);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const lastAutoSyncSignatureRef = useRef<string>("");
  const [eventVersion, setEventVersion] = useState<number>(0);
  const [liveStream, setLiveStream] = useState(
    defaultStreaming != null ? defaultStreaming : Boolean(activeTrace),
  );
  const [tab, setTab] = useState("summary");
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string>("");
  const [streamError, setStreamError] = useState<string>("");
  const [sharedFilters, setSharedFilters] = useState<{ actor: string; stage: string }>({ actor: "", stage: "" });

  if (eventMapRef.current === null) {
    eventMapRef.current = seedMap(activeTrace?.events || persistedEvents || []);
  }

  useEffect(() => {
    const source = activeTrace?.events || persistedEvents || [];
    eventMapRef.current = seedMap(source);
    setEventVersion((v) => v + 1);
  }, [activeTrace, persistedEvents]);

  useEffect(() => {
    if (!liveStream || !runId) return undefined;
    setStreamError("");
    expectedCloseRef.current = false;

    const source = new EventSource(eventSourceUrl(`/ui/runs/${runId}/stream`));
    source.onmessage = (payload) => {
      try {
        setStreamError("");
        const parsed = JSON.parse(payload.data || "{}");
        const incoming = Array.isArray(parsed?.events) ? parsed.events : [];
        if (incoming.length) {
          let changed = false;
          const map = eventMapRef.current;
          if (!map) return;
          for (const event of incoming) {
            const key = eventKey(event);
            if (!map.has(key)) {
              map.set(key, event);
              changed = true;
            }
          }
          if (changed) setEventVersion((v) => v + 1);
        }
        if (parsed?.metrics && typeof parsed.metrics === "object") {
          if (onMetricsChange) onMetricsChange(parsed.metrics);
        }
        if (parsed?.error) {
          setStreamError(String(parsed.error));
        }
        if (parsed?.completed) {
          expectedCloseRef.current = true;
          setLiveStream(false);
          source.close();
        }
      } catch (e) {
        setStreamError(e instanceof Error ? e.message : "Stream parse error");
      }
    };
    source.onerror = () => {
      if (expectedCloseRef.current) return;
      setStreamError("Stream connection interrupted; retrying...");
    };
    return () => {
      expectedCloseRef.current = true;
      source.close();
    };
  }, [liveStream, onMetricsChange, runId]);

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
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Cancel failed",
      );
    } finally {
      setIsCancelling(false);
    }
  }

  const events = useMemo<TraceEvent[]>(
    () =>
      [...((eventMapRef.current as Map<string, TraceEvent> | null)?.values() ?? [])].sort(
        (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventVersion],
  );

  const normalizedEvents = useMemo(() => normalizeTraceEvents(events), [events]);
  const terminalState = useMemo(() => getRunTerminalState(normalizedEvents), [normalizedEvents]);
  const autoDecisionItems = useMemo(
    () => buildAutoDecisionSync(normalizedEvents),
    [normalizedEvents],
  );
  const toolCallRows = useMemo(() => extractToolCalls(normalizedEvents as never) as unknown as Array<Record<string, unknown>>, [normalizedEvents]);
  const toolCallFeedRows = useMemo((): Array<Record<string, unknown>> => {
    if (toolCallRows.length) return toolCallRows;
    return (Array.isArray(persistedToolCalls) ? persistedToolCalls : []).map((row, index) => ({
      key: `persisted-${row.id ?? row.seq ?? index}`,
      toolName: row.tool_name || "tool",
      target: row.target_summary || "",
      status: row.status || "success",
      durationSeconds: row.duration_seconds || 0,
      result: row.result_preview || "",
      args: row.args_json || {},
      screenshots: [],
      stage: row.actor || "unknown",
      actor: row.actor || "",
      startSeq: row.seq || index + 1,
    }));
  }, [persistedToolCalls, toolCallRows]);
  const runState = useMemo(() => summarizeRunState(normalizedEvents), [normalizedEvents]);
  const stageView = useMemo(() => buildStageView(normalizedEvents), [normalizedEvents]);
  const filterOptions = useMemo(
    () =>
      buildRunDetailFilterOptions({
        events: normalizedEvents,
        toolCalls: toolCallFeedRows,
        agentRollups,
        decisions: initialDecisions as never[],
      }),
    [agentRollups, initialDecisions, normalizedEvents, toolCallFeedRows],
  );
  const activeStages = useMemo(
    () =>
      (stageView?.stages || []).filter(
        (stage) => stage.status !== "idle" || stage.events?.length,
      ),
    [stageView],
  );
  const showActivityBanner = !(runState?.active?.type === "failed" && runState?.failure);
  const rootActor =
    rootActorOverride ||
    (activeTrace as Record<string,unknown> | null)?.root_actor ||
    events.find((event) => event?.actor)?.actor ||
    "orchestrator";
  const isLive = liveStream && !terminalState.isTerminal;
  const decisionCount = Math.max(
    initialDecisions.length,
    autoDecisionItems.length,
  );
  const outputCount = Math.max(agentRollups.length, stageRollups.length, takedownEmails.length);
  const providerEntryCount = Math.max(
    Array.isArray(providerAnalysis) ? providerAnalysis.length : 0,
    Array.isArray(providerUrls) ? providerUrls.length : 0,
  );
  const tabState = useMemo(
    () =>
      buildRunDetailTabState({
        decisionCount,
        outputCount,
        // taskCount removed: 0,
        toolCallCount: toolCallFeedRows.length,
        eventCount: normalizedEvents.length,
        runState,
      }),
    [
      decisionCount,
      normalizedEvents.length,
      outputCount,
      runState,
      toolCallFeedRows.length,
    ],
  );
  const primaryTabs = useMemo(() => {
    if (!providerEntryCount && !(Array.isArray(extractionResults) && extractionResults.length)) {
      return tabState.primaryTabs;
    }
    return [
      ...tabState.primaryTabs,
      {
        value: "providers",
        label: "Provider Intel",
        count: providerEntryCount || extractionResults.length,
        tone: "signal",
      },
    ];
  }, [extractionResults, providerEntryCount, tabState.primaryTabs]);

  useEffect(() => {
    if (!runId) return undefined;
    const signature = JSON.stringify({
      decisions: autoDecisionItems.map((row) => [row.auto_key, row.status, row.title]),
    });
    if (signature === lastAutoSyncSignatureRef.current) return undefined;

    const handle = setTimeout(() => {
      apiFetch(`/ui/runs/${runId}/sync-logs`, {
        method: "POST",
        body: JSON.stringify({
          decisions: autoDecisionItems,
        }),
      })
        .then(() => {
          lastAutoSyncSignatureRef.current = signature;
        })
        .catch(() => {});
    }, 450);
    return () => clearTimeout(handle);
  }, [autoDecisionItems, runId]);

  useEffect(() => {
    if (terminalState.isTerminal && liveStream) {
      expectedCloseRef.current = true;
      setLiveStream(false);
    }
  }, [liveStream, terminalState.isTerminal]);

  useEffect(() => {
    const active = tabListRef.current?.querySelector("[data-state='active']");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }, [tab]);

  return (
    <Card className="overflow-hidden shadow-card">
      <Tabs value={tab} onValueChange={setTab}>
      <CardHeader className="border-b bg-muted/20 px-4 py-3">
        <div
        className="grid gap-2 rounded-[12px] border px-3 py-2.5 lg:grid-cols-[1fr_auto]"
        style={{
          borderColor: "var(--line)",
          background: "var(--card)",
          boxShadow: "var(--shadow-card)",
        }}
        >
        <div className="flex flex-wrap items-center gap-2">
        <Badge tone={isLive ? "signal" : "default"} className="gap-1.5 font-mono uppercase">
          {isLive ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {isLive ? "live updates" : terminalState.isTerminal ? terminalState.status : "persisted"}
        </Badge>
        {terminalState.status === "cancelled" ? <Badge tone="warning">trace closed</Badge> : null}
        {terminalState.status === "failed" ? <Badge tone="danger">trace closed</Badge> : null}
        {terminalState.status === "completed" ? <Badge tone="success">trace closed</Badge> : null}

        {runId && isLive ? (
          <Button
            type="button"
            onClick={cancelRun}
            disabled={isCancelling}
            variant="danger"
            size="sm"
            className="ml-auto"
          >
            {isCancelling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            Stop run
          </Button>
        ) : null}
        </div>

        <div ref={tabListRef} className="max-w-full overflow-x-auto">
          <TabsList className="h-auto w-max min-w-full flex-nowrap justify-start gap-1 border-0 bg-transparent p-0 shadow-none">
            {primaryTabs.map((entry) => (
              <TabsTrigger key={entry.value} value={entry.value}>
                {entry.label}
                {entry.count > 0 ? (
                  <Badge tone={entry.tone as unknown as never} className="ml-1 px-1.5 py-0 text-[10px]">
                    {entry.count}
                  </Badge>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4 pb-4 pt-0">
        {showActivityBanner ? <ActivityBanner state={runState as unknown as never} /> : null}

        <StageStatusRow stages={activeStages} />

        {actionError || streamError ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-[12px] border px-3 py-2 text-[12px]"
            style={{
              borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
              background: "color-mix(in oklch, var(--rose) 8%, transparent)",
              color: "var(--rose)",
            }}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="font-mono text-[11.5px]">{actionError || streamError}</div>
          </div>
        ) : null}

        <FailureDetailsCard failure={runState?.failure} />

        <TabsContent value="events">
          {normalizedEvents.length ? (
            <RuntimeEventsPanel
              events={normalizedEvents as never}
              title="Event Stream"
              sharedFilters={sharedFilters}
              onSharedFiltersChange={setSharedFilters}
              actorOptions={filterOptions.actors}
              stageOptions={filterOptions.stages}
              terminalStatus={terminalState.status}
            />
          ) : (
            <PanelLoadingSkeleton
              label={
                terminalState.status === "cancelled"
                  ? "Run cancelled before any events were persisted."
                  : isLive
                    ? "Waiting for first event..."
                    : "No events yet"
              }
            />
          )}
        </TabsContent>

        <TabsContent value="tools">
          {toolCallFeedRows.length ? (
            <ToolCallFeed
              toolCalls={toolCallFeedRows as never}
              title="Tool Calls"
              sharedFilters={sharedFilters}
              onSharedFiltersChange={setSharedFilters}
              actorOptions={filterOptions.actors}
              stageOptions={filterOptions.stages}
            />
          ) : (
            <PanelLoadingSkeleton
              label={
                terminalState.status === "cancelled"
                  ? "Run cancelled before any tool calls were persisted."
                  : isLive
                    ? "Waiting for tool calls..."
                    : "No tool calls yet"
              }
            />
          )}
        </TabsContent>

        <TabsContent value="summary" className="space-y-4">
          <OrchestratorGraph
            events={normalizedEvents}
            rootActor={rootActor as unknown as string}
            agentRollups={agentRollups as unknown as never[]}
            primaryProvider={primaryProvider}
            primaryModel={primaryModel}
          />
          {runId ? (
            <BrowserLiveView
              runId={runId}
              events={normalizedEvents as never}
              persistedScreenshots={snapshotScreenshots as unknown as never[]}
              autoRefresh={isLive}
              onClose={() => {}}
            />
          ) : (
            <PanelLoadingSkeleton
              label={
                terminalState.status === "cancelled"
                  ? "Run cancelled before screenshot history was expanded."
                  : "No screenshots captured yet"
              }
            />
          )}
        </TabsContent>

        <TabsContent value="output" className="space-y-4">
          <AgentOutputTab
            stageRollups={stageRollups as unknown as never[]}
            agentRollups={agentRollups as unknown as never[]}
            parallelism={parallelism as unknown as never}
            takedownEmails={takedownEmails as unknown as never[]}
          />
        </TabsContent>

        <TabsContent value="traces" className="space-y-4">
          <TracePanel
            events={normalizedEvents}
            isStreaming={isLive}
            sharedFilters={sharedFilters}
            onSharedFiltersChange={setSharedFilters}
            actorOptions={filterOptions.actors}
            stageOptions={filterOptions.stages}
          />
        </TabsContent>

        {providerEntryCount || (Array.isArray(extractionResults) && extractionResults.length) ? (
          <TabsContent value="providers">
            <StreamProviderTab
              runId={runId}
              runUrl={runUrl}
              streamUrls={providerUrls as unknown as never[]}
              providerAnalysis={providerAnalysis as unknown as never[]}
              extractionResults={extractionResults as unknown as never[]}
            />
          </TabsContent>
        ) : null}
      </CardContent>
      </Tabs>
    </Card>
  );
}
