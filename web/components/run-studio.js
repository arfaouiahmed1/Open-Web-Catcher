"use client";

import { useEffect, useMemo, useState } from "react";
import { Brain, Loader2, Play, Square } from "lucide-react";

import { apiUrl } from "@/lib/api";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { extractToolCalls, mergeTraceEvents, STAGE_LABELS } from "@/lib/run-trace";
import { BrowserLiveView } from "@/components/browser-live-view";
import { OrchestratorGraph } from "@/components/orchestrator-graph";
import { ToolCallFeed } from "@/components/tool-call-feed";
import { Button } from "@/components/ui/button";

const AGENTS = ["classification", "landing", "hosting", "embedded"];
const AGENT_PROMPT_FILES = {
  classification: "classification_v1.md",
  landing: "landing_page_v1.md",
  hosting: "hosting_page_v1.md",
  embedded: "embedded_page_v1.md",
};

function SelectorButton({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-[12px] border px-3 py-2 text-left text-[12px] font-medium transition-colors"
      style={{
        borderColor: active ? "color-mix(in oklch, var(--signal) 34%, transparent)" : "var(--line)",
        background: active ? "color-mix(in oklch, var(--signal) 12%, transparent)" : "var(--card)",
        color: active ? "var(--signal)" : "var(--ink-dim)",
      }}
    >
      {children}
    </button>
  );
}

function StatPill({ label, value, accent = "var(--ink-dim)" }) {
  return (
    <div
      className="rounded-full border px-3 py-1 text-[11px]"
      style={{ borderColor: "var(--line)", background: "var(--card)" }}
    >
      <span style={{ color: "var(--mute-2)" }}>{label}</span>
      <span className="ml-2 font-mono font-semibold" style={{ color: accent }}>{value}</span>
    </div>
  );
}

export function RunStudio({ mode = "workflow" }) {
  const [url, setUrl] = useState("");
  const [agent, setAgent] = useState("classification");
  const [runId, setRunId] = useState("");
  const [events, setEvents] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [tracePayload, setTracePayload] = useState(null);
  const [streamError, setStreamError] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [promptPreview, setPromptPreview] = useState("");
  const [showPromptPreview, setShowPromptPreview] = useState(false);

  useEffect(() => {
    if (mode !== "agent") return undefined;
    const promptFile = AGENT_PROMPT_FILES[agent] || `${agent}_v1.md`;
    fetch(apiUrl(`/ui/prompts/${promptFile}`), { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : { content: "" }))
      .then((payload) => setPromptPreview(payload?.content || ""))
      .catch(() => setPromptPreview(""));
    return undefined;
  }, [agent, mode]);

  useEffect(() => {
    if (!runId) return undefined;

    setIsRunning(true);
    setStreamError("");

    const source = new EventSource(apiUrl(`/ui/runs/${runId}/stream`));
    source.onmessage = (message) => {
      try {
        const payload = JSON.parse(message.data || "{}");
        if (!payload || typeof payload !== "object") return;

        const incomingEvents = Array.isArray(payload.events) ? payload.events : [];
        if (incomingEvents.length) {
          setEvents((current) => mergeTraceEvents(current, incomingEvents));
        }
        if (payload.metrics && typeof payload.metrics === "object") {
          setMetrics(payload.metrics);
        }
        setTracePayload(payload);
        if (payload.completed) {
          setIsRunning(false);
          source.close();
        }
        if (payload.error) {
          setStreamError(`Stream error: ${payload.error}`);
        }
      } catch (error) {
        setStreamError(error instanceof Error ? error.message : String(error || "Live stream failed"));
      }
    };

    source.onerror = () => {
      source.close();
      setIsRunning(false);
    };

    return () => source.close();
  }, [runId]);

  async function startRun() {
    setIsStarting(true);
    setEvents([]);
    setMetrics(null);
    setTracePayload(null);
    setStreamError("");
    setRunId("");
    try {
      const endpoint = mode === "workflow" ? "/ui/workflows/run" : "/ui/agents/test";
      const body = mode === "workflow" ? { url } : { url, agent };
      const response = await fetch(apiUrl(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail || `Start failed (${response.status})`);
      }
      setRunId(payload.run_id || "");
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : String(error || "Start failed"));
    } finally {
      setIsStarting(false);
    }
  }

  async function cancelRun() {
    if (!runId) return;
    try {
      await fetch(apiUrl(`/ui/runs/${runId}/cancel`), { method: "POST" });
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : String(error || "Cancel failed"));
    }
  }

  const toolCallRows = useMemo(() => extractToolCalls(events), [events]);
  const totalTokens = Number(metrics?.total_tokens_in || 0) + Number(metrics?.total_tokens_out || 0);
  const cachedInputTokens = Number(metrics?.total_cached_input_tokens || 0);
  const totalInputTokens = Number(metrics?.total_tokens_in || 0);
  const rootActor = tracePayload?.root_actor || (mode === "agent" ? agent : "orchestrator");

  return (
    <div className="space-y-5">
      <div>
        <span className="owc-eyebrow">{mode === "workflow" ? "workflow studio" : "agent studio"}</span>
        <h1 className="mt-2 text-3xl font-semibold text-[var(--ink)]">
          {mode === "workflow" ? "Live pipeline" : "Single-agent test"}
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          {mode === "workflow"
            ? "Run the full classify -> landing -> hosting -> embedded fallback flow and watch tool calls, screenshots, and costs update in place."
            : "Run one agent in isolation, inspect its tool calls, and compare what it actually saw in the browser."}
        </p>
      </div>

      <div
        className="space-y-4 rounded-[14px] border p-4"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        {mode === "agent" ? (
          <div className="space-y-2">
            <label className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--mute-2)" }}>
              Agent
            </label>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {AGENTS.map((value) => (
                <SelectorButton key={value} active={agent === value} onClick={() => setAgent(value)}>
                  <div>{STAGE_LABELS[value]}</div>
                  <div className="mt-1 text-[11px]" style={{ color: "var(--mute-2)" }}>
                    {value}
                  </div>
                </SelectorButton>
              ))}
            </div>

            <div className="overflow-hidden rounded-[12px] border" style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.12)" }}>
              <button
                type="button"
                onClick={() => setShowPromptPreview((value) => !value)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[11.5px]"
                style={{ color: "var(--mute)" }}
              >
                <Brain className="h-4 w-4" />
                Prompt preview
              </button>
              {showPromptPreview ? (
                <pre className="max-h-64 overflow-auto border-t px-3 py-3 text-[11px] whitespace-pre-wrap" style={{ borderColor: "var(--line)", color: "var(--ink-dim)" }}>
                  {promptPreview || "No prompt preview available."}
                </pre>
              ) : null}
            </div>
          </div>
        ) : null}

        <div>
          <label className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--mute-2)" }}>
            Target URL
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && url && !isStarting && !isRunning) startRun();
              }}
              placeholder="https://streaming-site.example.com/watch/123"
              className="min-w-[280px] flex-1 rounded-[12px] border px-3 py-2 text-[13px]"
              style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.12)", color: "var(--ink)" }}
            />
            <Button variant="accent" onClick={startRun} disabled={!url || isStarting || isRunning}>
              {isStarting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
              {isStarting ? "Starting" : mode === "workflow" ? "Run pipeline" : "Run agent"}
            </Button>
            {isRunning ? (
              <Button variant="ghost" onClick={cancelRun} className="border border-[var(--line)]">
                <Square className="mr-1.5 h-3.5 w-3.5" />
                Stop
              </Button>
            ) : null}
          </div>
        </div>

        {runId ? (
          <div className="flex flex-wrap items-center gap-2 border-t pt-3" style={{ borderColor: "var(--line)" }}>
            <span className="font-mono text-[11px]" style={{ color: "var(--mute-3)" }}>{runId.slice(0, 12)}...</span>
            {isRunning ? (
              <span className="font-mono text-[11px]" style={{ color: "var(--signal)" }}>streaming</span>
            ) : null}
            <div className="ml-auto flex flex-wrap gap-2">
              <StatPill label="tools" value={formatNumber(toolCallRows.length)} accent="var(--sky)" />
              <StatPill label="llm" value={formatNumber(metrics?.total_llm_calls || 0)} accent="var(--violet)" />
              <StatPill label="cached/input" value={`${formatNumber(cachedInputTokens)} / ${formatNumber(totalInputTokens)}`} accent="var(--violet)" />
              <StatPill label="tokens" value={formatNumber(totalTokens)} accent="var(--signal)" />
              <StatPill label="cost" value={formatCurrency(metrics?.total_cost_usd ?? metrics?.estimated_total_cost_usd ?? 0)} accent="var(--mint)" />
            </div>
          </div>
        ) : null}

        {streamError ? (
          <div
            className="rounded-[12px] border px-3 py-2 text-[12px]"
            style={{
              borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
              background: "color-mix(in oklch, var(--rose) 8%, transparent)",
              color: "var(--rose)",
            }}
          >
            {streamError}
          </div>
        ) : null}
      </div>

      {runId || events.length ? (
        <div className="space-y-4">
          <BrowserLiveView runId={runId} events={events} autoRefresh={isRunning} />
          <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
            <div className="space-y-4">
              <OrchestratorGraph events={events} rootActor={rootActor} />
            </div>
            <ToolCallFeed toolCalls={toolCallRows} title="Tool Calls" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
