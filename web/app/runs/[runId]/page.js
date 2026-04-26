"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ChevronLeft, ExternalLink } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { KpiCard } from "@/components/kpi-card";
import { RunDetailLive } from "@/components/run-detail-live";
import { ScreenshotGallery } from "@/components/browser-live-view";
import { useRunViewSettings } from "@/components/run-view-settings";
import { Badge } from "@/components/ui/badge";

const EMPTY_OBJECT = {};
const EMPTY_ARRAY = [];

/* ── helpers ──────────────────────────────────────────────────────────────── */
function statusTone(s) {
  if (s === "running")   return "signal";
  if (s === "cancelled") return "warning";
  if (s === "success")   return "success";
  if (s === "partial")   return "warning";
  return "danger";
}

function fmt(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function dur(s) {
  const n = Number(s || 0);
  if (n < 60) return `${n.toFixed(1)}s`;
  return `${Math.floor(n / 60)}m ${(n % 60).toFixed(0)}s`;
}

/* ── Stat pill row ────────────────────────────────────────────────────────── */
function RunMeta({ run }) {
  const items = [
    { label: "Status",     value: <Badge tone={statusTone(run.final_status)}>{run.final_status || "unknown"}</Badge> },
    { label: "Page type",  value: run.page_type || "—" },
    { label: "Duration",   value: dur(run.duration_seconds) },
    { label: "Started",    value: fmt(run.created_at) },
  ];
  if (run.primary_model) {
    items.push({ label: "Model", value: `${run.primary_provider || ""} ${run.primary_model}`.trim() });
  }
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-2">
      {items.map(({ label, value }) => (
        <div key={label}>
          <dt className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>{label}</dt>
          <dd className="mt-0.5 text-[12.5px]" style={{ color: "var(--ink-dim)" }}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ── Expandable DataTable wrapper ─────────────────────────────────────────── */
function ExpandableTable({ title, description, columns, rows, defaultExpand = false, expand }) {
  const showAll = expand ?? defaultExpand;
  const displayed = showAll ? rows : rows.slice(0, 8);
  return (
    <div>
      <DataTable
        title={title}
        description={description ? `${description}${!showAll && rows.length > 8 ? ` · ${rows.length - 8} more hidden` : ""}` : undefined}
        columns={columns}
        rows={displayed}
      />
    </div>
  );
}

/* ── Tab button ───────────────────────────────────────────────────────────── */
function Tab({ active, onClick, children, count }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-all"
      style={{
        background: active ? "color-mix(in oklch, var(--signal) 14%, transparent)" : "transparent",
        border: active ? "1px solid color-mix(in oklch, var(--signal) 28%, transparent)" : "1px solid transparent",
        color: active ? "var(--signal)" : "var(--mute-2)",
      }}
    >
      {children}
      {count != null && (
        <span
          className="rounded-full px-1.5 py-0.5 font-mono text-[9.5px]"
          style={{
            background: active ? "color-mix(in oklch, var(--signal) 20%, transparent)" : "rgba(255,255,255,0.06)",
            color: active ? "var(--signal)" : "var(--mute-3)",
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/* ── Main page ────────────────────────────────────────────────────────────── */
export default function RunDetailPage() {
  const { runId } = useParams();
  const [payload, setPayload] = useState(null);
  const [isLoading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("live");
  const { settings } = useRunViewSettings();

  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    apiFetch(`/ui/runs/${runId}`)
      .then(setPayload)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [runId]);

  // Hooks must be called unconditionally before any early returns
  const snapshot = payload?.snapshot ?? EMPTY_OBJECT;
  const events   = payload?.events ?? EMPTY_ARRAY;
  const screenshots = useMemo(() => {
    const fromSnapshot = (snapshot.all_screenshots || []).filter(Boolean);
    const fromEvents = events
      .filter((e) => e?.details?.screenshot_url || e?.details?.result_full?.screenshot_url || e?.details_json?.screenshot_url || e?.details_json?.result_full?.screenshot_url)
      .map((e) => e?.details?.screenshot_url || e?.details?.result_full?.screenshot_url || e?.details_json?.screenshot_url || e?.details_json?.result_full?.screenshot_url)
      .filter(Boolean);
    return [...new Set([...fromSnapshot, ...fromEvents])];
  }, [snapshot, events]);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-3" style={{ color: "var(--mute)" }}>
        <span className="owc-spinner owc-spinner-lg" style={{ color: "var(--signal)" }} />
        <span className="text-[13px]">Loading run…</span>
      </div>
    );
  }

  if (error || !payload) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3" style={{ color: "var(--mute)" }}>
        <div className="text-[13px]" style={{ color: "var(--rose)" }}>{error || "Run not found"}</div>
        <Link href="/runs" className="text-[12px]" style={{ color: "var(--signal)" }}>← Back to runs</Link>
      </div>
    );
  }

  const isActiveTrace = Boolean(payload.active_trace);
  const trace   = isActiveTrace ? payload.active_trace : null;
  const metrics = trace?.metrics || {};

  /* ── persisted run data ── */
  const run       = payload.run || {};
  const agentRuns = payload.agent_runs || [];
  const llmCalls  = payload.llm_calls || [];
  const toolCalls = payload.tool_calls || [];

  /* ── active in-memory run ── */
  if (isActiveTrace && trace) {
    return (
      <div className="space-y-5">
        <RunHeader runId={runId} title="Live Run" subtitle="Streaming from in-memory store" live />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <KpiCard label="Tokens"     value={formatNumber((metrics.total_tokens_in || 0) + (metrics.total_tokens_out || 0))} accent="signal" />
          <KpiCard label="LLM Calls"  value={formatNumber(metrics.total_llm_calls || 0)} accent="violet" />
          <KpiCard label="Tool Calls" value={formatNumber(metrics.total_tool_calls || 0)} accent="sky" />
          <KpiCard label="Est. Cost"  value={formatCurrency(metrics.total_cost_usd ?? metrics.estimated_total_cost_usd ?? 0)} accent="mint" />
        </div>
        <RunDetailLive runId={runId} activeTrace={trace} persistedEvents={trace.events || []} metrics={metrics} />
      </div>
    );
  }

  const kpis = [
    { label: "Streams",     value: formatNumber(run.stream_count    || 0), accent: "signal", description: "Stream URLs found" },
    { label: "Screenshots", value: formatNumber(run.screenshot_count || 0), accent: "sky",    description: "Captures taken" },
    { label: "Emails",      value: formatNumber(run.email_count      || 0), accent: "violet", description: "Abuse contacts" },
    { label: "LLM Calls",  value: formatNumber(run.total_llm_calls  || 0), accent: "violet", description: "Model completions" },
    { label: "Tool Calls", value: formatNumber(run.total_tool_calls || 0), accent: "sky",    description: "MCP tool calls" },
    { label: "Total Cost", value: formatCurrency(run.total_cost_usd ?? run.estimated_total_cost_usd ?? 0), accent: "mint", description: "Estimated USD" },
  ];

  return (
    <div className="space-y-5">

      {/* header */}
      <RunHeader runId={runId} url={run.url} run={run} />

      {/* meta row */}
      <RunMeta run={run} />

      {/* kpis */}
      <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => <KpiCard key={k.label} {...k} />)}
      </div>

      {/* tab nav */}
      <div
        className="flex flex-wrap items-center gap-1.5 rounded-[12px] border px-3 py-2"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        <Tab active={tab === "live"}       onClick={() => setTab("live")}>Live &amp; Graph</Tab>
        <Tab active={tab === "data"}       onClick={() => setTab("data")} count={agentRuns.length + toolCalls.length + llmCalls.length}>Tables</Tab>
        {screenshots.length > 0 && settings.showScreenshots && (
          <Tab active={tab === "screenshots"} onClick={() => setTab("screenshots")} count={screenshots.length}>Screenshots</Tab>
        )}
        {settings.showJsonViewers && (
          <Tab active={tab === "raw"} onClick={() => setTab("raw")}>Raw</Tab>
        )}
      </div>

      {/* ── Live & Graph tab ── */}
      {tab === "live" && (
        <RunDetailLive runId={runId} persistedEvents={events} metrics={snapshot?.metrics || run || null} />
      )}

      {/* ── Data Tables tab ── */}
      {tab === "data" && (
        <div className="space-y-5">
          <div className="grid gap-5 xl:grid-cols-2">
            <ExpandableTable
              title="Agent Runs"
              description="Per-agent normalized execution records"
              columns={["actor", "agent_type", "status", "tool_calls_made", "llm_calls_made", "duration_seconds"]}
              rows={agentRuns}
              expand={settings.expandTables}
            />
            <ExpandableTable
              title="Tool Calls"
              description="Tool usage and reliability trail"
              columns={["seq", "tool_name", "status", "duration_seconds", "target_summary"]}
              rows={toolCalls}
              expand={settings.expandTables}
            />
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            <ExpandableTable
              title="LLM Calls"
              description="Prompt, token, and cost telemetry"
              columns={["seq", "provider", "model_name", "input_tokens", "output_tokens", "total_cost_usd", "cost_source"]}
              rows={llmCalls}
              expand={settings.expandTables}
            />
          </div>
        </div>
      )}

      {/* ── Screenshots tab ── */}
      {tab === "screenshots" && (
        <ScreenshotGallery screenshots={screenshots} />
      )}

      {/* ── Raw JSON tab ── */}
      {tab === "raw" && (
        <div className="grid gap-5 xl:grid-cols-2">
          <JsonViewer label="Snapshot" value={snapshot} />
          <JsonViewer label="Run Payload" value={run} />
        </div>
      )}
    </div>
  );
}

/* ── Run header ───────────────────────────────────────────────────────────── */
function RunHeader({ runId, url, run, title, subtitle, live }) {
  return (
    <div>
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
            {live && (
              <span
                className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[9.5px] font-semibold uppercase tracking-wide"
                style={{
                  background: "color-mix(in oklch, var(--rose) 14%, transparent)",
                  border: "1px solid color-mix(in oklch, var(--rose) 30%, transparent)",
                  color: "var(--rose)",
                }}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--rose)", animation: "breathe 1.2s ease-in-out infinite" }} />
                LIVE
              </span>
            )}
          </div>
          <span className="owc-eyebrow mt-1">run detail · {live ? "in-memory" : "persisted"}</span>
          <h1 className="mt-1 font-mono text-xl font-semibold" style={{ color: "var(--ink)" }}>
            {title || (runId ? runId.slice(0, 18) + "…" : "Run")}
          </h1>
          {(url || subtitle) && (
            <div className="mt-0.5 flex items-center gap-1.5">
              <p
                className="max-w-xl truncate text-[12px]"
                style={{ color: "var(--mute)" }}
                title={url}
              >
                {subtitle || url}
              </p>
              {url && (
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0"
                  style={{ color: "var(--mute-3)" }}
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}
        </div>
        {run?.final_status && (
          <Badge tone={statusTone(run.final_status)} className="mt-1 shrink-0">
            {run.final_status}
          </Badge>
        )}
      </div>
    </div>
  );
}
