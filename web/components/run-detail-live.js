"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Loader2,
  PauseCircle,
  PlayCircle,
  Square,
  TimerReset,
  Wrench,
  XCircle,
} from "lucide-react";

import { apiUrl } from "@/lib/api";
import { extractToolCalls, summarizeRunState } from "@/lib/run-trace";
import { BrowserLiveView } from "@/components/console/run-detail/browser-live-view";
import { OrchestratorGraph } from "@/components/orchestrator-graph";
import { RuntimeEventsPanel } from "@/components/runtime-events-panel";
import { TimelinePanel } from "@/components/timeline-panel";
import { ToolCallFeed } from "@/components/tool-call-feed";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

function eventKey(event) {
  const seq = event?.seq;
  if (seq != null) return String(seq);
  return `${event?.timestamp ?? ""}-${event?.actor ?? ""}-${event?.kind ?? ""}-${event?.status ?? ""}`;
}

function seedMap(events) {
  const map = new Map();
  for (const event of events) map.set(eventKey(event), event);
  return map;
}

function ActivityBanner({ state }) {
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
    detail = recent.message;
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

      {recent && active?.type !== "failed" ? (
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
  activeTrace = null,
  persistedEvents = [],
  metrics = null,
  onMetricsChange = null,
  defaultStreaming = null,
  rootActor: rootActorOverride = "",
}) {
  const eventMapRef = useRef(null);
  const expectedCloseRef = useRef(false);
  const [eventVersion, setEventVersion] = useState(0);
  const [liveStream, setLiveStream] = useState(
    defaultStreaming != null ? defaultStreaming : Boolean(activeTrace),
  );
  const [replayMs, setReplayMs] = useState(80);
  const [isReplaying, setIsReplaying] = useState(false);
  const [tab, setTab] = useState("graph");
  const [isCancelling, setIsCancelling] = useState(false);
  const [actionError, setActionError] = useState("");
  const [streamError, setStreamError] = useState("");

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

    const source = new EventSource(apiUrl(`/ui/runs/${runId}/stream`));
    source.onmessage = (payload) => {
      try {
        const parsed = JSON.parse(payload.data || "{}");
        const incoming = Array.isArray(parsed?.events) ? parsed.events : [];
        if (incoming.length) {
          let changed = false;
          const map = eventMapRef.current;
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
      setStreamError("Stream connection lost");
      source.close();
    };
    return () => {
      expectedCloseRef.current = true;
      source.close();
    };
  }, [liveStream, runId, onMetricsChange]);

  async function replay() {
    if (!persistedEvents.length) return;
    setIsReplaying(true);
    eventMapRef.current = new Map();
    setEventVersion((v) => v + 1);
    for (const event of persistedEvents) {
      eventMapRef.current.set(eventKey(event), event);
      setEventVersion((v) => v + 1);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(20, replayMs)),
      );
    }
    setIsReplaying(false);
  }

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

  const events = useMemo(
    () =>
      [...(eventMapRef.current?.values() ?? [])].sort(
        (a, b) => (a.seq ?? 0) - (b.seq ?? 0),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventVersion],
  );

  const toolCallRows = useMemo(() => extractToolCalls(events), [events]);
  const runState = useMemo(() => summarizeRunState(events), [events]);
  const rootActor =
    rootActorOverride ||
    activeTrace?.root_actor ||
    events.find((event) => event?.actor)?.actor ||
    "orchestrator";
  const isLive = liveStream && !isReplaying;

  return (
    <Card className="overflow-hidden shadow-card">
      <CardHeader className="px-4 py-4">
        <div
        className="flex flex-wrap items-center gap-2 rounded-[12px] border px-3 py-2.5"
        style={{
          borderColor: "var(--line)",
          background: "var(--card)",
          boxShadow: "var(--shadow-card)",
        }}
        >
        <Button
          type="button"
          onClick={() => setLiveStream((value) => !value)}
          disabled={!runId}
          variant={liveStream ? "danger" : "outline"}
          size="sm"
        >
          {liveStream ? (
            <PauseCircle className="h-4 w-4" />
          ) : (
            <PlayCircle className="h-4 w-4" />
          )}
          {liveStream ? "Streaming" : "Paused"}
        </Button>

        <Button
          type="button"
          onClick={replay}
          disabled={isReplaying || !persistedEvents.length}
          variant="outline"
          size="sm"
        >
          {isReplaying ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <TimerReset className="h-4 w-4" />
          )}
          {isReplaying ? "Replaying" : "Replay"}
        </Button>

        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">
            Speed
          </span>
          <Input
            type="number"
            min="20"
            step="10"
            value={replayMs}
            onChange={(event) => setReplayMs(Number(event.target.value || 80))}
            className="w-20 text-right"
          />
          <span className="font-mono text-[10px] text-muted-foreground">
            ms
          </span>
        </div>

        {runId && isLive ? (
          <Button
            type="button"
            onClick={cancelRun}
            disabled={isCancelling}
            variant="danger"
            size="sm"
          >
            {isCancelling ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            Stop run
          </Button>
        ) : null}

        <Tabs className="ml-auto" value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="graph">Graph</TabsTrigger>
            <TabsTrigger value="tools">
              Tool calls
              {toolCallRows.length > 0 ? (
                <Badge tone="signal" className="ml-1 px-1.5 py-0 text-[10px]">
                  {toolCallRows.length}
                </Badge>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="events">
              Events
              {events.length > 0 ? (
                <Badge tone="violet" className="ml-1 px-1.5 py-0 text-[10px]">
                  {events.length}
                </Badge>
              ) : null}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4 pb-4 pt-0">
        <ActivityBanner state={runState} />

        {actionError || streamError ? (
          <div
            className="flex items-start gap-2 rounded-[12px] border px-3 py-2 text-[12px]"
            style={{
              borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
              background: "color-mix(in oklch, var(--rose) 8%, transparent)",
              color: "var(--rose)",
            }}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="font-mono text-[11.5px]">
              {actionError || streamError}
            </div>
          </div>
        ) : null}

        {!actionError && !streamError && runState?.failure?.message ? (
          <div
            className="flex items-start gap-2 rounded-[12px] border px-3 py-2 text-[12px]"
            style={{
              borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
              background: "color-mix(in oklch, var(--rose) 8%, transparent)",
              color: "var(--rose)",
            }}
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="font-mono text-[11.5px]">
              {runState.failure.message}
            </div>
          </div>
        ) : null}

        {runId ? (
          <BrowserLiveView runId={runId} events={events} autoRefresh={isLive} />
        ) : null}

        <TabsContent value="events">
          <RuntimeEventsPanel events={events} title="Event Stream" />
        </TabsContent>

        <TabsContent value="tools">
          <ToolCallFeed toolCalls={toolCallRows} title="Tool Calls" />
        </TabsContent>

        <TabsContent value="graph" className="space-y-4">
          {events.length > 2 && <TimelinePanel events={events} />}
          <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
            <OrchestratorGraph events={events} rootActor={rootActor} />
            <ToolCallFeed
              toolCalls={toolCallRows}
              title="Tool Calls"
              maxHeight={480}
            />
          </div>
        </TabsContent>
      </CardContent>
    </Card>
  );
}
