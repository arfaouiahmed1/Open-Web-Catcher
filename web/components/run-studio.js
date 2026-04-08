"use client";

import { useEffect, useMemo, useState } from "react";

import { apiUrl } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent, safeJson } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { JsonViewer } from "@/components/json-viewer";
import { WorkflowCanvas } from "@/components/workflow-canvas";

const AGENTS = [
  { value: "classification", label: "Classification" },
  { value: "landing", label: "Landing" },
  { value: "hosting", label: "Hosting" },
  { value: "embedded", label: "Embedded" }
];

export function RunStudio({ mode = "workflow" }) {
  const [url, setUrl] = useState("");
  const [agent, setAgent] = useState("classification");
  const [runId, setRunId] = useState("");
  const [events, setEvents] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [tracePayload, setTracePayload] = useState(null);
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    if (!runId) {
      return undefined;
    }

    const source = new EventSource(apiUrl(`/ui/runs/${runId}/stream`));
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      setTracePayload(payload);
      setEvents((current) => [...current, ...(payload.events || [])]);
      if (payload.metrics) {
        setMetrics(payload.metrics);
      }
      if (payload.completed) {
        source.close();
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
  }, [runId]);

  const rootActor = tracePayload?.root_actor || (mode === "workflow" ? "orchestrator" : agent);

  const summaryItems = useMemo(
    () => [
      { label: "Tool Calls", value: formatNumber(metrics?.total_tool_calls || 0) },
      { label: "LLM Calls", value: formatNumber(metrics?.total_llm_calls || 0) },
      {
        label: "Tokens",
        value: formatNumber((metrics?.total_tokens_in || 0) + (metrics?.total_tokens_out || 0))
      },
      { label: "Estimated Cost", value: formatCurrency(metrics?.estimated_total_cost_usd || 0) },
      {
        label: "Duration",
        value: `${Number(metrics?.total_duration_seconds || 0).toFixed(2)}s`
      },
      {
        label: "Success",
        value: metrics ? (metrics.success ? formatPercent(1) : formatPercent(0)) : "0.0%"
      }
    ],
    [metrics]
  );

  async function startRun() {
    setIsStarting(true);
    setEvents([]);
    setMetrics(null);
    setTracePayload(null);
    try {
      const endpoint = mode === "workflow" ? "/ui/workflows/run" : "/ui/agents/test";
      const response = await fetch(apiUrl(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "workflow" ? { url } : { url, agent })
      });
      const payload = await response.json();
      setRunId(payload.run_id || "");
    } finally {
      setIsStarting(false);
    }
  }

  async function cancelRun() {
    if (!runId) {
      return;
    }
    await fetch(apiUrl(`/ui/runs/${runId}/cancel`), { method: "POST" });
  }

  return (
    <div className="space-y-6">
      <Card className="relative overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-signal to-transparent" />
        <CardHeader>
          <div>
            <Badge tone="signal">{mode === "workflow" ? "Workflow Studio" : "Agent Studio"}</Badge>
            <CardTitle className="mt-3 text-2xl">
              {mode === "workflow" ? "Orchestrator stream" : "Agent test stream"}
            </CardTitle>
            <CardDescription className="mt-2 max-w-3xl">
              Live operator feed with node graph, event rail, token usage, costs, and model/tool activity. This is intentionally structured and evidence-first.
            </CardDescription>
          </div>
          <div className="text-right text-sm text-slate-400">
            <div>Run ID</div>
            <div className="mt-2 rounded-2xl border border-white/10 bg-black/30 px-4 py-2 text-xs text-slate-200">
              {runId || "Not started"}
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[minmax(0,1fr)_240px]">
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/watch/123" />
          {mode === "workflow" ? null : (
            <Select value={agent} onChange={(event) => setAgent(event.target.value)}>
              {AGENTS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
          )}
          <div className="flex gap-3 md:col-span-2">
            <Button variant="accent" onClick={startRun} disabled={!url || isStarting}>
              {isStarting ? "Starting..." : mode === "workflow" ? "Run workflow" : "Run agent"}
            </Button>
            <Button variant="ghost" onClick={cancelRun} disabled={!runId}>
              Cancel run
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-6">
        {summaryItems.map((item) => (
          <Card key={item.label} className="p-4">
            <div className="text-xs uppercase tracking-[0.3em] text-slate-400">{item.label}</div>
            <div className="mt-3 text-2xl font-semibold">{item.value}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(340px,0.8fr)]">
        <WorkflowCanvas events={events} rootActor={rootActor} />
        <Card>
          <CardHeader>
            <CardTitle>Event Rail</CardTitle>
            <CardDescription>Every runtime event, ordered, without hidden chain-of-thought claims.</CardDescription>
          </CardHeader>
          <CardContent className="max-h-[560px] space-y-3 overflow-auto">
            {events.length ? (
              events.map((event) => (
                <div key={`${event.seq}-${event.kind}`} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium text-white">{event.actor}</div>
                    <Badge tone={event.status === "error" ? "danger" : event.status === "warning" ? "warning" : "signal"}>
                      {event.kind}
                    </Badge>
                  </div>
                  <div className="mt-2 text-sm text-slate-300">{event.message}</div>
                  {event.details?.content_preview ? (
                    <pre className="mt-3 overflow-auto rounded-2xl border border-white/10 bg-black/30 p-3 text-xs text-slate-200">
                      {event.details.content_preview}
                    </pre>
                  ) : null}
                  {event.details?.tool_name ? (
                    <div className="mt-3 text-xs uppercase tracking-[0.25em] text-slate-500">
                      Tool {event.details.tool_name}
                    </div>
                  ) : null}
                  {event.details?.result_preview ? (
                    <pre className="mt-3 overflow-auto rounded-2xl border border-white/10 bg-black/30 p-3 text-xs text-slate-200">
                      {event.details.result_preview}
                    </pre>
                  ) : null}
                  {event.details && !event.details.content_preview && !event.details.result_preview && !event.details.tool_name ? (
                    <pre className="mt-3 overflow-auto rounded-2xl border border-white/10 bg-black/30 p-3 text-xs text-slate-500">
                      {safeJson(event.details)}
                    </pre>
                  ) : null}
                  <div className="mt-2 text-xs text-slate-500">#{event.seq}</div>
                </div>
              ))
            ) : (
              <div className="rounded-2xl border border-dashed border-white/10 p-8 text-sm text-slate-500">
                Start a run to stream the live operator feed.
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <JsonViewer label="Latest Stream Payload" value={tracePayload || {}} />
        <JsonViewer label="Metrics Snapshot" value={metrics || {}} />
      </div>
    </div>
  );
}
