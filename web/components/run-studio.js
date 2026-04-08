"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock,
  Cpu,
  DollarSign,
  Loader2,
  Play,
  Square,
  Terminal,
  Wrench,
  Zap,
} from "lucide-react";

import { apiUrl } from "@/lib/api";
import { cn, formatCurrency, formatNumber, safeJson } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/* ─── constants ─────────────────────────────────────────────────────────── */

const AGENTS = [
  { value: "classification", label: "Classification", description: "Detect page type" },
  { value: "landing",        label: "Landing",        description: "Find hosting URLs" },
  { value: "hosting",        label: "Hosting",        description: "Extract streams" },
  { value: "embedded",       label: "Embedded",       description: "Handle iframes" },
];

const EVENT_META = {
  agent_started:       { color: "text-signal",    label: "Agent started" },
  agent_finished:      { color: "text-surge",     label: "Agent finished" },
  agent_failed:        { color: "text-ember",     label: "Agent failed" },
  agent_loop_started:  { color: "text-signal",    label: "Loop" },
  agent_loop_finished: { color: "text-surge",     label: "Loop done" },
  tool_session_connecting: { color: "text-sky-400", label: "Tool session" },
  tool_session_ready:      { color: "text-surge",   label: "Tools ready" },
  tool_session_closed:     { color: "text-slate-400", label: "Tools closed" },
  tool_session_failed:     { color: "text-ember",   label: "Tools failed" },
  tool_call_started:   { color: "text-spark",     label: "Tool call" },
  tool_call_finished:  { color: "text-surge",     label: "Tool done" },
  llm_turn_started:    { color: "text-violet-300",label: "LLM call" },
  llm_response:        { color: "text-violet-400",label: "LLM" },
  llm_timeout:         { color: "text-ember",     label: "LLM timeout" },
  llm_rate_limited:    { color: "text-amber-400", label: "LLM quota" },
  llm_error:           { color: "text-ember",     label: "LLM error" },
  prompt_compiled:     { color: "text-slate-400", label: "Prompt" },
  budget_exhausted:    { color: "text-amber-400", label: "Budget" },
  pipeline_started:    { color: "text-signal",    label: "Pipeline" },
  pipeline_failed:     { color: "text-ember",     label: "Pipeline failed" },
  run_cancelled:       { color: "text-amber-400", label: "Cancelled" },
};

/* ─── agent selector ────────────────────────────────────────────────────── */

function AgentSelector({ value, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {AGENTS.map((a) => (
        <button
          key={a.value}
          onClick={() => onChange(a.value)}
          className={cn(
            "flex flex-col items-start rounded-lg border px-3 py-2 text-left transition-colors",
            value === a.value
              ? "border-signal/50 bg-signal/10 text-white"
              : "border-white/10 bg-white/[0.03] text-slate-400 hover:border-white/20 hover:text-slate-200"
          )}
        >
          <span className="text-sm font-medium">{a.label}</span>
          <span className="text-xs text-slate-600">{a.description}</span>
        </button>
      ))}
    </div>
  );
}

/* ─── metrics pill ──────────────────────────────────────────────────────── */

function Pill({ icon: Icon, label, value, danger }) {
  return (
    <div className={cn(
      "flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs",
      danger
        ? "border-ember/30 bg-ember/10 text-ember"
        : "border-white/8 bg-white/[0.03] text-slate-400"
    )}>
      {Icon && <Icon className="h-3 w-3 shrink-0 text-slate-600" />}
      <span className="text-slate-600">{label}</span>
      <span className="ml-0.5 font-mono font-semibold text-slate-200">{value}</span>
    </div>
  );
}

/* ─── reasoning feed blocks ─────────────────────────────────────────────── */

function ThinkingBlock({ event }) {
  const preview = event.details?.content_preview;
  const toolCount = event.details?.tool_calls || 0;
  const tokens = (event.details?.input_tokens || 0) + (event.details?.output_tokens || 0);
  const actor = event.actor ? event.actor.replace(/_/g, " ") : "agent";

  return (
    <div className="rounded-lg border border-violet-500/20 bg-violet-500/[0.06] p-3">
      <div className="mb-2 flex items-center gap-2">
        <Brain className="h-3.5 w-3.5 shrink-0 text-violet-400" />
        <span className="text-xs font-semibold uppercase tracking-wide text-violet-400">
          {actor}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {toolCount > 0 && (
            <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-xs text-violet-300">
              {toolCount} tool{toolCount !== 1 ? "s" : ""}
            </span>
          )}
          <span className="font-mono text-xs text-slate-600">{formatNumber(tokens)} tok</span>
        </div>
      </div>
      {preview ? (
        <p className="text-sm leading-relaxed text-slate-200 whitespace-pre-wrap">{preview}</p>
      ) : (
        <p className="text-xs italic text-slate-700">No content preview available</p>
      )}
    </div>
  );
}

function ToolBlock({ event }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = event.details?.tool_name;
  const args = event.details?.args;
  const resultPreview = event.details?.result_preview;
  const isStart = event.kind === "tool_call_started";
  const isError = event.status === "error";

  const color = isError ? "text-ember" : isStart ? "text-spark" : "text-surge";
  const border = isError ? "border-ember/20 bg-ember/5" : isStart ? "border-spark/20 bg-spark/5" : "border-surge/20 bg-surge/5";
  const verb = isStart ? "calling" : isError ? "failed" : "returned";

  return (
    <div className={cn("rounded-lg border p-2.5", border)}>
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        <Terminal className={cn("h-3.5 w-3.5 shrink-0", color)} />
        <span className={cn("text-xs font-semibold uppercase tracking-wide", color)}>{verb}</span>
        <span className="ml-1 rounded bg-black/30 px-1.5 py-0.5 font-mono text-xs text-slate-200">
          {toolName}
        </span>
        {(args || resultPreview) && (
          <ChevronDown className={cn("ml-auto h-3 w-3 shrink-0 text-slate-600 transition-transform", expanded && "rotate-180")} />
        )}
      </button>
      {expanded && (args || resultPreview) && (
        <div className="mt-2 space-y-1.5">
          {args && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-600">Args</div>
              <pre className="max-h-36 overflow-auto rounded bg-black/30 p-2 text-xs text-slate-300">
                {safeJson(args)}
              </pre>
            </div>
          )}
          {resultPreview && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-slate-600">Result</div>
              <pre className="max-h-36 overflow-auto rounded bg-black/30 p-2 text-xs text-slate-300">
                {typeof resultPreview === "string" ? resultPreview : safeJson(resultPreview)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusChip({ event }) {
  const meta = EVENT_META[event.kind] || { color: "text-slate-500", label: event.kind };
  const isError = event.status === "error";
  return (
    <div className={cn(
      "flex items-center gap-2 rounded-md border border-white/6 px-2.5 py-1.5 text-xs",
      isError && "border-ember/30 bg-ember/5"
    )}>
      <span className={cn("font-semibold", isError ? "text-ember" : meta.color)}>{meta.label}</span>
      {event.message && (
        <span className="truncate text-slate-500">{event.message}</span>
      )}
    </div>
  );
}

function ReasoningFeed({ events }) {
  const bottomRef = useRef(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const relevant = events.filter((e) =>
    e.kind === "tool_session_connecting" ||
    e.kind === "tool_session_ready" ||
    e.kind === "tool_session_closed" ||
    e.kind === "tool_session_failed" ||
    e.kind === "llm_turn_started" ||
    e.kind === "llm_response" ||
    e.kind === "llm_timeout" ||
    e.kind === "llm_rate_limited" ||
    e.kind === "llm_error" ||
    e.kind === "tool_call_started" ||
    e.kind === "tool_call_finished" ||
    e.kind === "agent_started" ||
    e.kind === "agent_finished" ||
    e.kind === "agent_failed" ||
    e.kind === "pipeline_started" ||
    e.kind === "pipeline_failed" ||
    e.kind === "run_cancelled" ||
    e.status === "error"
  );

  if (!relevant.length) {
    return (
      <div className="flex h-32 items-center justify-center text-xs text-slate-700">
        Agent reasoning will appear here live
      </div>
    );
  }

  return (
    <>
      {relevant.map((ev, i) => {
        if (ev.kind === "llm_response") return <ThinkingBlock key={`r-${ev.seq}-${i}`} event={ev} />;
        if (ev.kind === "tool_call_started" || ev.kind === "tool_call_finished") return <ToolBlock key={`r-${ev.seq}-${i}`} event={ev} />;
        return <StatusChip key={`r-${ev.seq}-${i}`} event={ev} />;
      })}
      <div ref={bottomRef} />
    </>
  );
}

/* ─── full event log ─────────────────────────────────────────────────────── */

function EventRow({ event }) {
  const [expanded, setExpanded] = useState(false);
  const meta = EVENT_META[event.kind] || { color: "text-slate-400", label: event.kind };
  const hasDetails = event.details && Object.keys(event.details).length > 0;
  const isError = event.status === "error";

  return (
    <div className={cn(
      "rounded-md border text-xs transition-colors",
      isError ? "border-ember/30 bg-ember/5" : "border-white/6 hover:bg-white/[0.04]"
    )}>
      <button
        onClick={() => hasDetails && setExpanded((v) => !v)}
        disabled={!hasDetails}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <div className={cn("h-1.5 w-1.5 shrink-0 rounded-full",
          isError ? "bg-ember" :
          event.kind === "llm_response" ? "bg-violet-400" :
          event.kind?.includes("tool") ? "bg-spark" :
          event.kind?.includes("finished") ? "bg-surge" :
          event.kind?.includes("failed") ? "bg-ember" :
          "bg-signal"
        )} />
        <span className={cn("shrink-0 font-medium", isError ? "text-ember" : meta.color)}>
          {meta.label}
        </span>
        <span className="flex-1 truncate text-slate-600">{event.message}</span>
        <span className="shrink-0 font-mono text-slate-700">#{event.seq}</span>
        {hasDetails && (
          <ChevronRight className={cn("h-3 w-3 shrink-0 text-slate-700 transition-transform", expanded && "rotate-90")} />
        )}
      </button>
      {expanded && hasDetails && (
        <div className="border-t border-white/6 px-2.5 pb-2 pt-1.5">
          <pre className="max-h-40 overflow-auto rounded bg-black/40 p-2 text-xs text-slate-300">
            {safeJson(event.details)}
          </pre>
        </div>
      )}
    </div>
  );
}

function EventLog({ events }) {
  const bottomRef = useRef(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  if (!events.length) {
    return (
      <div className="flex h-20 items-center justify-center text-xs text-slate-700">
        No events yet
      </div>
    );
  }

  return (
    <>
      {events.map((ev, i) => <EventRow key={`e-${ev.seq}-${i}`} event={ev} />)}
      <div ref={bottomRef} />
    </>
  );
}

/* ─── main ───────────────────────────────────────────────────────────────── */

export function RunStudio({ mode = "workflow" }) {
  const [url, setUrl]               = useState("");
  const [agent, setAgent]           = useState("classification");
  const [runId, setRunId]           = useState("");
  const [events, setEvents]         = useState([]);
  const [metrics, setMetrics]       = useState(null);
  const [tracePayload, setTrace]    = useState(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isRunning, setIsRunning]   = useState(false);

  useEffect(() => {
    if (!runId) return;
    setIsRunning(true);
    const source = new EventSource(apiUrl(`/ui/runs/${runId}/stream`));
    source.onmessage = (e) => {
      const payload = JSON.parse(e.data);
      setTrace(payload);
      setEvents((cur) => [...cur, ...(payload.events || [])]);
      if (payload.metrics) setMetrics(payload.metrics);
      if (payload.completed) { source.close(); setIsRunning(false); }
    };
    source.onerror = () => { source.close(); setIsRunning(false); };
    return () => source.close();
  }, [runId]);

  const toolCalls   = events.filter((e) => e.kind === "tool_call_started").length;
  const llmCalls    = events.filter((e) => e.kind === "llm_response").length;
  const errorCount  = events.filter((e) => e.status === "error").length;
  const totalTokens = (metrics?.total_tokens_in || 0) + (metrics?.total_tokens_out || 0);
  const duration    = metrics?.total_duration_seconds;
  const completed   = tracePayload?.completed;
  const succeeded   = completed && metrics?.success;
  const failed      = completed && !metrics?.success;

  async function startRun() {
    setIsStarting(true);
    setEvents([]);
    setMetrics(null);
    setTrace(null);
    setRunId("");
    try {
      const endpoint = mode === "workflow" ? "/ui/workflows/run" : "/ui/agents/test";
      const body = mode === "workflow" ? { url } : { url, agent };
      const res = await fetch(apiUrl(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      setRunId(payload.run_id || "");
    } finally {
      setIsStarting(false);
    }
  }

  async function cancelRun() {
    if (!runId) return;
    await fetch(apiUrl(`/ui/runs/${runId}/cancel`), { method: "POST" });
  }

  return (
    <div className="space-y-5">

      {/* ── page header ───────────────────────────────────────────────────── */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-spark">
          {mode === "workflow" ? "Workflow Studio" : "Agent Lab"}
        </p>
        <h1 className="mt-1 text-xl font-semibold text-white">
          {mode === "workflow" ? "Full pipeline run" : "Single-agent test"}
        </h1>
        <p className="mt-0.5 text-sm text-slate-500">
          {mode === "workflow"
            ? "Classify → extract → provider analysis → DMCA email. LLM reasoning streams live."
            : "Run one agent in isolation. Every thought, tool call, and token appears in real time."}
        </p>
      </div>

      {/* ── control card ──────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4 space-y-3">
        {mode === "agent" && (
          <div className="space-y-2">
            <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">
              Agent
            </label>
            <AgentSelector value={agent} onChange={setAgent} />
          </div>
        )}

        <div>
          <label className="text-[10px] font-semibold uppercase tracking-widest text-slate-600">
            Target URL
          </label>
          <div className="mt-1.5 flex gap-2">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && url && !isStarting && !isRunning && startRun()}
              placeholder="https://streaming-site.example.com/watch/123"
              className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-white placeholder:text-slate-700 focus:border-signal/50 focus:outline-none"
            />
            <Button
              variant="accent"
              onClick={startRun}
              disabled={!url || isStarting || isRunning}
              className="shrink-0"
            >
              {isStarting
                ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Starting</>
                : <><Play className="mr-1.5 h-3.5 w-3.5" />{mode === "workflow" ? "Run pipeline" : "Run agent"}</>}
            </Button>
            {isRunning && (
              <Button variant="ghost" onClick={cancelRun} className="shrink-0 border border-white/10">
                <Square className="mr-1.5 h-3.5 w-3.5" />Cancel
              </Button>
            )}
          </div>
        </div>

        {/* status bar */}
        {runId && (
          <div className="flex flex-wrap items-center gap-2 border-t border-white/6 pt-3">
            <span className="font-mono text-xs text-slate-700">{runId.slice(0, 12)}…</span>
            {isRunning && (
              <span className="flex items-center gap-1 text-xs text-signal">
                <Loader2 className="h-3 w-3 animate-spin" />streaming
              </span>
            )}
            {succeeded && (
              <span className="flex items-center gap-1 text-xs text-surge">
                <CheckCircle2 className="h-3 w-3" />completed
              </span>
            )}
            {failed && (
              <span className="flex items-center gap-1 text-xs text-ember">
                <AlertCircle className="h-3 w-3" />
                {tracePayload?.cancel_requested ? "cancelled" : `failed · ${metrics?.failure_mode || "unknown"}`}
              </span>
            )}
            <div className="ml-auto flex flex-wrap gap-1.5">
              <Pill icon={Wrench}     label="tools"  value={toolCalls} />
              <Pill icon={Cpu}        label="llm"    value={llmCalls} />
              <Pill icon={Zap}        label="tokens" value={formatNumber(totalTokens)} />
              <Pill icon={DollarSign} label="cost"   value={formatCurrency(metrics?.estimated_total_cost_usd || 0)} />
              {duration != null && <Pill icon={Clock} label="time" value={`${duration.toFixed(1)}s`} />}
              {errorCount > 0 && <Pill icon={AlertCircle} label="errors" value={errorCount} danger />}
            </div>
          </div>
        )}
      </div>

      {/* ── live panels ───────────────────────────────────────────────────── */}
      {(events.length > 0 || runId) && (
        <div className="grid gap-4 xl:grid-cols-[1fr_300px]">

          {/* reasoning panel */}
          <div className="rounded-xl border border-white/8 bg-white/[0.03] overflow-hidden">
            <div className="flex items-center gap-2 border-b border-white/6 px-4 py-3">
              <Brain className="h-3.5 w-3.5 text-violet-400" />
              <span className="text-xs font-semibold text-white">Agent Reasoning</span>
              {isRunning && <Loader2 className="h-3 w-3 animate-spin text-slate-600" />}
              <span className="ml-auto text-xs text-slate-600">
                {llmCalls} LLM turn{llmCalls !== 1 ? "s" : ""}
              </span>
            </div>
            <div className="max-h-[560px] overflow-y-auto space-y-2 p-4">
              <ReasoningFeed events={events} />
            </div>
          </div>

          {/* event log */}
          <div className="rounded-xl border border-white/8 bg-white/[0.03] overflow-hidden">
            <div className="flex items-center gap-2 border-b border-white/6 px-3 py-3">
              <span className="text-xs font-semibold text-white">Event Log</span>
              <span className="ml-auto text-xs text-slate-600">{events.length}</span>
            </div>
            <div className="max-h-[560px] overflow-y-auto space-y-1 p-2">
              <EventLog events={events} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
