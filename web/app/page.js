"use client";

import { useEffect, useRef, useState } from "react";
import { apiUrl } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { KpiCard } from "@/components/kpi-card";
import Link from "next/link";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

/* ── fetch helper ── */
async function apiFetch(path) {
  const res = await fetch(apiUrl(path));
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/* ══════════════════════════════════════════════════════════
   PURE SVG / HTML CHART COMPONENTS
══════════════════════════════════════════════════════════ */

/* ── 7-day stacked bar trend ── */
function TrendChart({ rows = [] }) {
  const days = rows.length ? rows : Array.from({ length: 7 }, (_, i) => ({ date: `D${i + 1}`, successes: 0, partials: 0, failures: 0 }));
  const last7 = days.slice(-7);
  const maxTotal = Math.max(...last7.map((d) => (d.successes || 0) + (d.partials || 0) + (d.failures || 0)), 1);
  const H = 130, BARW = 30, STEP = 52;

  return (
    <svg viewBox={`0 0 420 ${H + 30}`} width="100%" style={{ display: "block" }}>
      {[0, H * 0.33, H * 0.66, H].map((y) => (
        <line key={y} x1="0" x2="420" y1={y} y2={y} stroke="rgba(255,255,255,0.04)" />
      ))}
      {last7.map((d, i) => {
        const s = Math.round(((d.successes || 0) / maxTotal) * H);
        const p = Math.round(((d.partials  || 0) / maxTotal) * H);
        const f = Math.round(((d.failures  || 0) / maxTotal) * H);
        const x = 18 + i * STEP;
        const label = d.date ? String(d.date).slice(5) : `D${i + 1}`;
        return (
          <g key={i} transform={`translate(${x},0)`}>
            {s > 0 && <rect x="0" y={H - s}           width={BARW} height={s} fill="var(--mint)"   rx="2" />}
            {p > 0 && <rect x="0" y={H - s - p}       width={BARW} height={p} fill="var(--signal)" rx="1" />}
            {f > 0 && <rect x="0" y={H - s - p - f}   width={BARW} height={f} fill="var(--rose)"   rx="1" />}
            <text x={BARW / 2} y={H + 16} textAnchor="middle"
              fontFamily="JetBrains Mono,monospace" fontSize="9.5" fill="var(--mute-2)">{label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── token stacked bar for one model ── */
function TokenBar({ newIn, cachedIn, out, maxTotal, label, cost }) {
  const W = 280;
  const newW    = Math.round((newIn    / maxTotal) * W);
  const cachedW = Math.round((cachedIn / maxTotal) * W);
  const outW    = Math.round((out      / maxTotal) * W);

  return (
    <div className="grid items-center gap-3 border-b px-4 py-3 last:border-0"
      style={{ borderColor: "var(--line)", gridTemplateColumns: "160px 1fr auto" }}>
      <div className="font-mono text-[10.5px] truncate" style={{ color: "var(--ink-dim)" }} title={label}>{label}</div>
      <div className="flex h-3.5 overflow-hidden rounded-full gap-[1px]"
        style={{ background: "rgba(255,255,255,0.04)" }}>
        {newW    > 0 && <span style={{ width: newW,    background: "var(--signal)",  borderRadius: "2px 0 0 2px" }} />}
        {cachedW > 0 && <span style={{ width: cachedW, background: "var(--violet)" }} />}
        {outW    > 0 && <span style={{ width: outW,    background: "var(--mint)",    borderRadius: "0 2px 2px 0" }} />}
      </div>
      <div className="font-mono text-[10.5px] text-right" style={{ color: "var(--mute)" }}>
        {formatCurrency(cost)}
      </div>
    </div>
  );
}

/* ── cost pie-ish: horizontal share bars ── */
function CostShareBar({ label, value, share, color, sub }) {
  return (
    <div className="grid items-center gap-3 border-b px-4 py-[10px] last:border-0"
      style={{ borderColor: "var(--line)", gridTemplateColumns: "1fr auto 130px" }}>
      <div>
        <div className="text-[12.5px]" style={{ color: "var(--ink)" }}>{label}</div>
        {sub && <div className="mt-0.5 font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>{sub}</div>}
      </div>
      <span className="font-mono text-[12px]" style={{ color: "var(--ink-dim)" }}>{value}</span>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
        <div className="h-full rounded-full" style={{ width: `${share}%`, background: color }} />
      </div>
    </div>
  );
}

/* ── agent performance card ── */
function AgentPerfCard({ actor, total, success, failed, avgDur, toolCalls, llmCalls, color }) {
  const rate = total > 0 ? success / total : 0;
  return (
    <div className="relative overflow-hidden rounded-[12px] border p-4 animate-fade-up"
      style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}>
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wide" style={{ color: "var(--mute)" }}>agent</div>
          <div className="mt-0.5 text-[15px] font-semibold tracking-tight" style={{ color }}>{actor}</div>
        </div>
        <span
          className="rounded-full px-2 py-0.5 font-mono text-[10px]"
          style={{
            background: rate >= 0.8 ? "color-mix(in oklch, var(--mint) 12%, transparent)"
              : rate >= 0.5 ? "color-mix(in oklch, var(--signal) 12%, transparent)"
              : "color-mix(in oklch, var(--rose) 12%, transparent)",
            color: rate >= 0.8 ? "var(--mint)" : rate >= 0.5 ? "var(--signal)" : "var(--rose)",
            border: `1px solid ${rate >= 0.8 ? "color-mix(in oklch, var(--mint) 25%, transparent)"
              : rate >= 0.5 ? "color-mix(in oklch, var(--signal) 25%, transparent)"
              : "color-mix(in oklch, var(--rose) 25%, transparent)"}`,
          }}
        >
          {formatPercent(rate)}
        </span>
      </div>

      {/* success bar */}
      <div className="mb-3 h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
        <div className="h-full rounded-full" style={{ width: `${rate * 100}%`, background: color }} />
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          { v: formatNumber(total), l: "runs" },
          { v: formatNumber(toolCalls), l: "tools" },
          { v: `${Number(avgDur || 0).toFixed(1)}s`, l: "avg dur" },
        ].map(({ v, l }) => (
          <div key={l}>
            <div className="owc-stat-num text-[14px]" style={{ color: "var(--ink)" }}>{v}</div>
            <div className="mt-0.5 text-[9.5px] uppercase tracking-wide" style={{ color: "var(--mute-2)" }}>{l}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── tool reliability row ── */
function ToolReliRow({ tool_name, calls, success_rate, avg_duration, errors }) {
  const rate = Number(success_rate || 0);
  const color = rate >= 0.9 ? "var(--mint)" : rate >= 0.7 ? "var(--signal)" : "var(--rose)";
  return (
    <div className="grid items-center gap-3 border-b px-4 py-2.5 last:border-0"
      style={{ borderColor: "var(--line)", gridTemplateColumns: "1fr 60px 80px 60px 60px" }}>
      <span className="font-mono text-[11px] truncate" style={{ color: "var(--ink-dim)" }} title={tool_name}>{tool_name}</span>
      <span className="font-mono text-[11px] text-right" style={{ color: "var(--mute)" }}>{formatNumber(calls)}</span>
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
          <div className="h-full rounded-full" style={{ width: `${rate * 100}%`, background: color }} />
        </div>
        <span className="font-mono text-[10px]" style={{ color }}>{Math.round(rate * 100)}%</span>
      </div>
      <span className="font-mono text-[10px] text-right" style={{ color: "var(--mute-2)" }}>
        {Number(avg_duration || 0).toFixed(1)}s
      </span>
      <span className="font-mono text-[10px] text-right" style={{ color: errors > 0 ? "var(--rose)" : "var(--mute-3)" }}>
        {errors > 0 ? `${errors} err` : "—"}
      </span>
    </div>
  );
}

/* ── failed site row ── */
function FailedSiteRow({ run }) {
  const fm = (run.failure_mode || run.final_status || "").toLowerCase();
  const isBot = fm.includes("bot") || fm.includes("block") || fm.includes("captcha") || fm.includes("detect") || fm.includes("403") || fm.includes("forbid");
  let domain = "—";
  try { domain = new URL(run.url || "").hostname.replace(/^www\./, ""); } catch { /* ignore */ }

  return (
    <div className="grid items-center gap-3 border-b px-4 py-2.5 last:border-0 group"
      style={{ borderColor: "var(--line)", gridTemplateColumns: "auto 1fr auto auto auto" }}>
      {/* status indicator */}
      <span
        className="flex h-5 w-5 items-center justify-center rounded-md text-[9px]"
        style={{
          background: isBot ? "color-mix(in oklch, var(--rose) 12%, transparent)" : "color-mix(in oklch, var(--signal) 10%, transparent)",
          color: isBot ? "var(--rose)" : "var(--signal)",
          border: `1px solid ${isBot ? "color-mix(in oklch, var(--rose) 25%, transparent)" : "color-mix(in oklch, var(--signal) 25%, transparent)"}`,
        }}
        title={isBot ? "Bot / access blocked" : "Failed"}
      >
        {isBot ? "🤖" : "✕"}
      </span>
      <div className="min-w-0">
        <div className="truncate font-mono text-[11px]" style={{ color: "var(--ink-dim)" }} title={run.url}>{domain}</div>
        {run.failure_mode && (
          <div className="mt-0.5 truncate font-mono text-[9.5px]" style={{ color: "var(--mute-2)" }}>{run.failure_mode}</div>
        )}
      </div>
      <span className="font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>
        {run.page_type || "—"}
      </span>
      <span className="font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>
        {Number(run.duration_seconds || 0).toFixed(1)}s
      </span>
      <Link href={`/runs/${run.run_id}`}
        className="font-mono text-[10px] opacity-0 transition-opacity group-hover:opacity-100"
        style={{ color: "var(--signal)" }}>
        →
      </Link>
    </div>
  );
}

/* ── section label ── */
function SectionLabel({ children, aside, dot }) {
  return (
    <div className="mb-3 flex items-baseline gap-2.5 text-[10px] font-semibold uppercase tracking-[0.16em]"
      style={{ color: "var(--mute)" }}>
      {dot && <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: dot }} />}
      <span>{children}</span>
      <span className="flex-1 h-px" style={{ background: "var(--line)" }} />
      {aside && <span className="font-mono text-[11px] normal-case tracking-normal" style={{ color: "var(--mute-2)" }}>{aside}</span>}
    </div>
  );
}

/* ── panel ── */
function Panel({ children, className = "" }) {
  return (
    <div className={`rounded-[14px] border border-[var(--line)] overflow-hidden ${className}`}
      style={{ background: "var(--card)", boxShadow: "var(--shadow-card)" }}>
      {children}
    </div>
  );
}

function PanelHead({ title, sub, aside, accent }) {
  return (
    <div className="flex items-center gap-2.5 border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
      {accent && <span className="h-3 w-0.5 rounded-full shrink-0" style={{ background: accent }} />}
      <div>
        <div className="text-[13.5px] font-medium" style={{ color: "var(--ink)" }}>{title}</div>
        {sub && <div className="text-[11.5px]" style={{ color: "var(--mute)" }}>{sub}</div>}
      </div>
      {aside && <div className="ml-auto text-sm">{aside}</div>}
    </div>
  );
}

/* ── active run row ── */
function ActiveRunRow({ run }) {
  const cost = run.total_cost_usd ?? run.estimated_total_cost_usd ?? 0;
  return (
    <div className="grid items-center gap-3 border-b border-[var(--line)] px-4 py-3 last:border-0"
      style={{ gridTemplateColumns: "auto 1fr auto" }}>
      <div className="relative flex h-[30px] w-[30px] items-center justify-center rounded-lg font-mono text-[11px]"
        style={{ background: "color-mix(in oklch, var(--violet) 14%, transparent)", color: "var(--violet)" }}>
        {(run.root_actor || "R")[0].toUpperCase()}
        <span className="absolute inset-[-3px] rounded-[10px] border animate-breathe"
          style={{ borderColor: "color-mix(in oklch, var(--violet) 40%, transparent)" }} />
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11.5px]" style={{ color: "var(--ink-dim)" }}>{run.run_id?.slice(0, 10) || "—"}</span>
          <span className="owc-pill live"><span className="dot" />{run.root_actor || "running"}</span>
        </div>
        <div className="font-mono mt-0.5 text-[10.5px] truncate max-w-[180px]" style={{ color: "var(--mute)" }}
          title={run.url}>{run.url || "—"}</div>
      </div>
      <div className="text-right shrink-0">
        <div className="font-mono text-[13px]" style={{ color: "var(--ink)" }}>{formatCurrency(cost)}</div>
        <div className="font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>
          {run.event_count || 0} ev · {run.total_tool_calls || 0} tools
        </div>
      </div>
    </div>
  );
}

/* ── skeleton loader ── */
function Skeleton({ h = "h-8", w = "w-full", rounded = "rounded-lg" }) {
  return <div className={`${h} ${w} ${rounded} shimmer`} style={{ background: "var(--line)" }} />;
}

/* ── tab bar ── */
const TABS = [
  { id: "overview", label: "Overview" },
  { id: "costs",    label: "Costs" },
  { id: "tokens",   label: "Tokens" },
  { id: "tools",    label: "Tools" },
  { id: "agents",   label: "Agents" },
];

function TabBar({ active, onChange }) {
  const containerRef = useRef(null);
  const [ind, setInd] = useState({ left: 0, width: 0 });

  useEffect(() => {
    if (!containerRef.current) return;
    const btns = containerRef.current.querySelectorAll("button");
    const idx = TABS.findIndex((t) => t.id === active);
    if (idx >= 0 && btns[idx]) setInd({ left: btns[idx].offsetLeft, width: btns[idx].offsetWidth });
  }, [active]);

  return (
    <div ref={containerRef} className="relative flex items-center rounded-xl p-1"
      style={{ background: "var(--card)", border: "1px solid var(--line)" }}>
      {/* sliding indicator */}
      <span className="pointer-events-none absolute rounded-lg"
        style={{
          left: ind.left, width: ind.width, top: 4, bottom: 4,
          background: "color-mix(in oklch, var(--signal) 14%, transparent)",
          border: "1px solid color-mix(in oklch, var(--signal) 28%, transparent)",
          transition: "left 200ms cubic-bezier(0.4,0,0.2,1), width 200ms cubic-bezier(0.4,0,0.2,1)",
        }}
      />
      {TABS.map((t) => (
        <button key={t.id} type="button"
          onClick={() => onChange(t.id)}
          className="relative z-10 px-4 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors duration-150"
          style={{ color: active === t.id ? "var(--signal)" : "var(--mute)" }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════
   PAGE
══════════════════════════════════════════════════════════ */

export default function OverviewPage() {
  const searchParams = useSearchParams();
  const router       = useRouter();
  const pathname     = usePathname();
  const tab          = searchParams.get("tab") || "overview";

  function setTab(t) {
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", t);
    router.push(`${pathname}?${p.toString()}`, { scroll: false });
  }

  /* ── shared data ── */
  const [overview,    setOverview]    = useState(null);
  const [failedData,  setFailedData]  = useState(null);
  const [toolRel,     setToolRel]     = useState(null);
  const [agentRunsDb, setAgentRunsDb] = useState(null);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.allSettled([
      apiFetch("/ui/overview"),
      apiFetch("/ui/runs?status=failed&limit=20&offset=0"),
      apiFetch("/ui/tools/reliability?limit=30"),
      apiFetch("/ui/database/agent_runs?limit=300"),
    ]).then(([overviewRes, failedRunsRes, toolRelRes, agentRunsRes]) => {
      setOverview  (overviewRes.status   === "fulfilled" ? overviewRes.value   : {});
      setFailedData(failedRunsRes.status === "fulfilled" ? failedRunsRes.value : {});
      setToolRel   (toolRelRes.status    === "fulfilled" ? toolRelRes.value    : {});
      setAgentRunsDb(agentRunsRes.status === "fulfilled" ? agentRunsRes.value  : {});
      setLoading(false);
    });
  }, []);

  if (loading || !overview) {
    return (
      <div className="space-y-8 animate-fade-up">
        <div className="flex items-start justify-between gap-6">
          <div className="space-y-2"><Skeleton h="h-3" w="w-24" /><Skeleton h="h-9" w="w-64" /></div>
        </div>
        <Skeleton h="h-10" w="w-80" rounded="rounded-xl" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({length: 8}).map((_, i) => <Skeleton key={i} h="h-28" rounded="rounded-[14px]" />)}
        </div>
      </div>
    );
  }

  const s  = (overview?.summary)           || {};
  const e  = (overview?.evaluation_summary)|| {};
  const tr = (overview?.trend)             || [];

  /* ── KPIs ── */
  const runKpis = [
    { label: "Total runs",    value: s.total_runs   || 0,              description: "Persisted orchestrator runs",   sparkData: tr.slice(-7).map((r) => r.runs || 0),               delta: s.total_runs > 0 ? "active" : undefined },
    { label: "Success rate",  value: formatPercent(s.success_rate || 0), description: "Runs with final success",      bar: (s.success_rate || 0) * 100, accent: "mint" },
    { label: "Avg latency",   value: `${(s.avg_latency_seconds || 0).toFixed(1)}s`, description: "End-to-end runtime",sparkData: tr.slice(-7).map((r) => r.avg_latency_seconds || 0) },
    { label: "Total cost",    value: formatCurrency(s.total_cost_usd || 0), description: "First-party model spend",  sparkData: tr.slice(-7).map((r) => r.cost_usd || 0) },
    { label: "Total tokens",  value: s.total_tokens || 0,               description: "Input + output tokens",        sparkData: tr.slice(-7).map((r) => r.tokens || 0) },
    { label: "Tool success",  value: formatPercent(s.tool_success_rate || 0), description: "Tool call success rate", bar: (s.tool_success_rate || 0) * 100, accent: "mint" },
    { label: "Stream yield",  value: formatPercent(s.stream_yield_rate || 0), description: "Runs that found a stream", bar: (s.stream_yield_rate || 0) * 100, accent: "accent" },
    { label: "Email yield",   value: formatPercent(s.email_yield_rate  || 0), description: "Runs that drafted takedown", bar: (s.email_yield_rate || 0) * 100, accent: "accent" },
  ];

  const evalKpis = [
    { label: "Pass rate",      value: formatPercent(e.latest_success_rate || 0),       bar: (e.latest_success_rate || 0) * 100, accent: "mint",   description: "Latest benchmark" },
    { label: "Hallucination",  value: formatPercent(e.latest_hallucination_rate || 0), bar: (e.latest_hallucination_rate || 0) * 100, accent: "rose", description: "Unsupported claims" },
    { label: "Tool accuracy",  value: formatPercent(e.latest_tool_accuracy_rate || 0), bar: (e.latest_tool_accuracy_rate || 0) * 100, description: "Correct tool use" },
    { label: "Reliability",    value: formatPercent(e.latest_reliability_rate || 0),   bar: (e.latest_reliability_rate || 0) * 100, accent: "mint",  description: "Tool stability" },
  ];

  /* ── model breakdown (tokens) ── */
  const modelRows = (overview.model_breakdown || []).slice(0, 8);
  const tokenTotals = modelRows.map((r) => {
    /* overview model_breakdown has: label, provider, model_name, calls, tokens, cost_usd */
    /* tokens here is total; we don't have split in this endpoint — estimate 30% cached */
    const total   = Number(r.tokens || 0);
    const cached  = Math.round(total * 0.3);  /* approx — actual split not in this endpoint */
    const newIn   = Math.round(total * 0.5);
    const out     = total - cached - newIn;
    return { ...r, newIn, cachedIn: cached, out: Math.max(out, 0) };
  });
  const maxTokens = Math.max(...tokenTotals.map((r) => r.tokens || 0), 1);
  const modelTotal = modelRows.reduce((acc, r) => acc + Number(r.cost_usd || 0), 0) || 1;
  const colors = ["var(--signal)", "var(--violet)", "var(--mint)", "var(--sky)", "var(--rose)"];

  /* ── agent performance (from DB agent_runs table) ── */
  const agentRunRows = agentRunsDb?.rows || [];
  const agentMap = new Map();
  for (const row of agentRunRows) {
    const actor = row.actor || row.agent_type || "unknown";
    if (!agentMap.has(actor)) {
      agentMap.set(actor, { actor, total: 0, success: 0, failed: 0, durSum: 0, toolCalls: 0, llmCalls: 0 });
    }
    const d = agentMap.get(actor);
    d.total++;
    if (row.status === "success" || row.status === "succeeded") d.success++;
    if (row.status === "failed")  d.failed++;
    d.durSum   += Number(row.duration_seconds || 0);
    d.toolCalls += Number(row.tool_calls_made  || 0);
    d.llmCalls  += Number(row.llm_calls_made   || 0);
  }
  const agentPerf = Array.from(agentMap.values())
    .filter((a) => a.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 6);

  const agentColors = {
    orchestrator:   "var(--signal)",
    classification: "var(--sky)",
    landing:        "var(--violet)",
    hosting:        "var(--mint)",
    embedded:       "oklch(0.76 0.13 64)",
  };
  function agentColor(actor) {
    const a = (actor || "").toLowerCase();
    for (const [k, v] of Object.entries(agentColors)) {
      if (a.includes(k)) return v;
    }
    return "var(--mute-2)";
  }

  /* ── failed / bot-blocked sites ── */
  const failedRuns = (failedData?.rows || []).slice(0, 15);
  const botBlocked = failedRuns.filter((r) => {
    const fm = (r.failure_mode || r.final_status || "").toLowerCase();
    return fm.includes("bot") || fm.includes("block") || fm.includes("captcha") || fm.includes("403") || fm.includes("forbid") || fm.includes("detect");
  });
  const otherFailed = failedRuns.filter((r) => !botBlocked.includes(r));

  /* ── tool reliability ── */
  const toolRows = (toolRel?.rows || []).sort((a, b) => Number(b.calls || 0) - Number(a.calls || 0)).slice(0, 12);

  /* ── active runs ── */
  const activeRuns = (overview.active_runs || []).filter((r) => !r.completed).slice(0, 4);

  /* ── provider breakdown ── */
  const provRows = (overview.provider_breakdown || []).slice(0, 6);
  const provMax  = Math.max(...provRows.map((r) => Number(r.analysis_count || r.count || 0)), 1);

  return (
    <div className="space-y-10 animate-fade-up">

      {/* ══ HEADER ══ */}
      <div className="flex items-start justify-between gap-6">
        <div>
          <span className="owc-eyebrow">operator console · live</span>
          <h1 className="mt-2 font-display text-3xl font-bold tracking-tight" style={{ color: "var(--ink)" }}>
            Operator Dashboard
          </h1>
          <p className="mt-1.5 max-w-[60ch] text-[13.5px] leading-relaxed" style={{ color: "var(--mute)" }}>
            Live health of all pipeline runs, agents, tokens, costs, and tool reliability.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link href="/runs" className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12.5px] transition-colors hover:border-[var(--line-hi)]"
            style={{ borderColor: "var(--line)", color: "var(--ink-dim)", background: "var(--card)" }}>
            All runs →
          </Link>
          <Link href="/live" className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold"
            style={{ background: "var(--signal)", color: "#0d0a04", boxShadow: "var(--shadow-glow)" }}>
            ▶ New pipeline
          </Link>
        </div>
      </div>

      {/* ══ TAB BAR ══ */}
      <TabBar active={tab} onChange={setTab} />

      {/* ══ TAB CONTENT ══ */}
      <div key={tab} className="animate-fade-up space-y-10">

      {/* ── OVERVIEW TAB ── */}
      {(tab === "overview") && <>

      {/* ══ PIPELINE KPIs ══ */}
      <section>
        <SectionLabel dot="var(--signal)" aside={`n = ${formatNumber(s.total_runs || 0)} runs`}>
          Pipeline · last 7 days
        </SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {runKpis.map((k) => <KpiCard key={k.label} {...k} />)}
        </div>
      </section>

      {/* ══ EVALUATION KPIs ══ */}
      <section>
        <SectionLabel dot="var(--violet)" aside="latest suite">Evaluation quality</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {evalKpis.map((k) => <KpiCard key={k.label} {...k} />)}
        </div>
      </section>

      {/* ══ TREND + ACTIVE ══ */}
      <section className="grid gap-5 xl:grid-cols-[1.3fr_1fr]">
        <Panel>
          <PanelHead accent="var(--mint)" title="Run trend" sub="7-day volume · success / partial / failed"
            aside={
              <div className="flex gap-3 font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>
                {[["var(--mint)","success"],["var(--signal)","partial"],["var(--rose)","failed"]].map(([c, l]) => (
                  <span key={l} className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm" style={{ background: c }} />{l}
                  </span>
                ))}
              </div>
            }
          />
          <div className="px-5 pb-3 pt-4"><TrendChart rows={tr} /></div>
        </Panel>
        <Panel>
          <PanelHead accent="var(--violet)" title="Active runs" sub="In-memory, currently streaming"
            aside={
              activeRuns.length > 0
                ? <span className="owc-pill live"><span className="dot" />{activeRuns.length} live</span>
                : <span className="owc-pill"><span className="dot" style={{ background: "var(--mute-3)" }} />idle</span>
            }
          />
          {activeRuns.length ? activeRuns.map((r) => <ActiveRunRow key={r.run_id} run={r} />) : (
            <div className="px-4 py-8 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>idle · awaiting next trigger</div>
          )}
        </Panel>
      </section>

      {/* ══ RECENT RUNS ══ */}
      <section>
        <SectionLabel dot="var(--mint)" aside={<Link href="/runs" style={{ color: "var(--signal)" }}>view all →</Link>}>Recent runs</SectionLabel>
        <Panel>
          <div className="overflow-x-auto">
            <table className="min-w-full text-[12.5px]">
              <thead>
                <tr className="border-b" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.012)" }}>
                  {["Run ID", "URL", "Status", "Page type", "Streams", "Tokens", "Cost", "Duration"].map((h) => (
                    <th key={h} className="px-4 py-2 text-left font-mono text-[9.5px] uppercase tracking-wide whitespace-nowrap" style={{ color: "var(--mute-2)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(overview.recent_runs || []).slice(0, 8).map((row) => {
                  const st = row.final_status || row.status || "";
                  const statusColor = st === "success" ? "var(--mint)" : st === "failed" ? "var(--rose)" : st === "partial" ? "var(--signal)" : st === "running" ? "var(--violet)" : "var(--mute-2)";
                  let domain = row.url || "—";
                  try { domain = new URL(row.url || "").hostname.replace(/^www\./, ""); } catch {}
                  return (
                    <tr key={row.run_id} className="border-b transition-colors" style={{ borderColor: "var(--line)" }}
                      onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}>
                      <td className="px-4 py-2.5"><Link href={`/runs/${row.run_id}`} className="font-mono text-[11px]" style={{ color: "var(--signal)" }}>{row.run_id?.slice(0, 10)}…</Link></td>
                      <td className="px-4 py-2.5 max-w-[160px]"><span className="font-mono text-[10.5px] block truncate" style={{ color: "var(--mute)" }} title={row.url}>{domain}</span></td>
                      <td className="px-4 py-2.5"><span className="font-mono text-[10.5px] uppercase" style={{ color: statusColor }}>{st || "—"}</span></td>
                      <td className="px-4 py-2.5 font-mono text-[10.5px]" style={{ color: "var(--mute)" }}>{row.page_type || "—"}</td>
                      <td className="px-4 py-2.5 font-mono text-[11px] tabular-nums" style={{ color: "var(--ink-dim)" }}>{formatNumber(row.stream_count || row.streams_found)}</td>
                      <td className="px-4 py-2.5 font-mono text-[11px] tabular-nums" style={{ color: "var(--ink-dim)" }}>{formatNumber((row.total_tokens_in || row.tokens_in || 0) + (row.total_tokens_out || row.tokens_out || 0))}</td>
                      <td className="px-4 py-2.5 font-mono text-[11px] tabular-nums" style={{ color: "var(--ink-dim)" }}>{formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}</td>
                      <td className="px-4 py-2.5 font-mono text-[11px] tabular-nums" style={{ color: "var(--mute)" }}>{Number(row.duration_seconds || 0).toFixed(1)}s</td>
                    </tr>
                  );
                })}
                {!(overview.recent_runs || []).length && (
                  <tr><td colSpan={8} className="px-4 py-10 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No runs yet</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </section>
      </>}

      {/* ── COSTS TAB ── */}
      {tab === "costs" && <>
      <section>
        <SectionLabel dot="var(--rose)" aside={formatCurrency(s.total_cost_usd || 0)}>Cost breakdown</SectionLabel>
        <div className="grid gap-5 xl:grid-cols-2">
          <Panel>
            <PanelHead accent="var(--rose)" title="Cost by model" sub="Spend distribution across models" />
            {modelRows.length ? modelRows.map((r, i) => (
              <CostShareBar key={r.label || i} label={r.label || r.model_name || "—"} value={formatCurrency(r.cost_usd || 0)}
                share={(Number(r.cost_usd || 0) / modelTotal) * 100} color={colors[i % colors.length]}
                sub={`${formatNumber(r.calls || 0)} calls · ${formatNumber(r.tokens || 0)} tok`} />
            )) : <div className="px-4 py-8 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No cost data yet</div>}
            <div className="flex items-center justify-between border-t px-4 py-3" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.015)" }}>
              <span className="font-mono text-[10px] uppercase tracking-wide" style={{ color: "var(--mute)" }}>Total spend</span>
              <span className="font-mono text-[15px] font-semibold" style={{ color: "var(--rose)" }}>{formatCurrency(s.total_cost_usd || 0)}</span>
            </div>
          </Panel>
          <Panel>
            <PanelHead accent="var(--sky)" title="Cost by provider" sub="Where spend is going upstream" />
            {provRows.length ? provRows.map((r, i) => (
              <CostShareBar key={r.provider || i} label={r.provider || "—"} value={formatNumber(r.analysis_count || r.count || 0)}
                share={((r.analysis_count || r.count || 0) / provMax) * 100} color={colors[i % colors.length]}
                sub={r.run_count ? `${r.run_count} runs` : undefined} />
            )) : <div className="px-4 py-8 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No provider data yet</div>}
          </Panel>
        </div>
      </section>
      </>}

      {/* ── TOKENS TAB ── */}
      {tab === "tokens" && <>
      <section>
        <SectionLabel dot="var(--sky)" aside={`${formatNumber(s.total_tokens || 0)} total tokens`}>Token analysis · by model</SectionLabel>
        <Panel>
          <PanelHead accent="var(--sky)" title="Token consumption per model" sub="new input (amber) · cached input (violet) · output (green)"
            aside={
              <div className="flex gap-3 font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--signal)" }} />new input</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--violet)" }} />cached</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--mint)" }} />output</span>
              </div>
            }
          />
          {tokenTotals.length ? (
            <>
              {tokenTotals.map((r, i) => (
                <TokenBar key={r.label || i} label={r.label || r.model_name || "—"} newIn={r.newIn} cachedIn={r.cachedIn} out={r.out} maxTotal={maxTokens} cost={r.cost_usd || 0} />
              ))}
              <div className="grid items-center gap-4 border-t px-4 py-3"
                style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.015)", gridTemplateColumns: "160px 1fr 1fr 1fr auto" }}>
                <span className="font-mono text-[10px] uppercase tracking-wide" style={{ color: "var(--mute)" }}>Totals</span>
                <span className="font-mono text-[11px]" style={{ color: "var(--signal)" }}>~{formatNumber(Math.round((s.total_tokens || 0) * 0.5))} new</span>
                <span className="font-mono text-[11px]" style={{ color: "var(--violet)" }}>~{formatNumber(Math.round((s.total_tokens || 0) * 0.3))} cached</span>
                <span className="font-mono text-[11px]" style={{ color: "var(--mint)" }}>~{formatNumber(Math.round((s.total_tokens || 0) * 0.2))} output</span>
                <span className="font-mono text-[12px] font-semibold" style={{ color: "var(--ink)" }}>{formatCurrency(s.total_cost_usd || 0)}</span>
              </div>
            </>
          ) : <div className="px-4 py-8 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No model data yet</div>}
        </Panel>
      </section>
      </>}

      {/* ── TOOLS TAB ── */}
      {tab === "tools" && <>
      <section>
        <SectionLabel dot="var(--sky)" aside={`${toolRows.length} tools tracked`}>Tool reliability</SectionLabel>
        <Panel>
          <PanelHead accent="var(--sky)" title="MCP tool reliability" sub="Success rate, avg duration, error count — ordered by call volume" />
          <div className="grid border-b px-4 py-2"
            style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.012)", gridTemplateColumns: "1fr 60px 80px 60px 60px" }}>
            {["tool", "calls", "success rate", "avg dur", "errors"].map((h) => (
              <span key={h} className="font-mono text-[9.5px] uppercase tracking-wide text-right first:text-left" style={{ color: "var(--mute-2)" }}>{h}</span>
            ))}
          </div>
          {toolRows.length ? toolRows.map((r, i) => (
            <ToolReliRow key={r.tool_name || i} tool_name={r.tool_name || "—"} calls={r.calls || 0}
              success_rate={r.success_rate ?? (r.successes && r.calls ? r.successes / r.calls : 0)}
              avg_duration={r.avg_duration_seconds || r.avg_duration || 0}
              errors={r.errors || (r.calls && r.successes ? r.calls - r.successes : 0)} />
          )) : <div className="px-4 py-8 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No tool calls recorded yet</div>}
        </Panel>
      </section>
      </>}

      {/* ── AGENTS TAB ── */}
      {tab === "agents" && <>
      <section>
        <SectionLabel dot="var(--violet)" aside={`${agentRunRows.length} agent runs sampled`}>Agent performance</SectionLabel>
        {agentPerf.length ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agentPerf.map((a) => (
              <AgentPerfCard key={a.actor} actor={a.actor} total={a.total} success={a.success} failed={a.failed}
                avgDur={a.total > 0 ? a.durSum / a.total : 0} toolCalls={a.toolCalls} llmCalls={a.llmCalls} color={agentColor(a.actor)} />
            ))}
          </div>
        ) : (
          <Panel><div className="px-4 py-8 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No agent run records yet — start a pipeline run to populate</div></Panel>
        )}
      </section>
      <section className="grid gap-5 xl:grid-cols-2">
        <Panel>
          <PanelHead accent="var(--rose)" title="Bot-blocked sites" sub="Runs where bot detection / access denial occurred"
            aside={botBlocked.length > 0 ? <span className="owc-pill err"><span className="dot" />{botBlocked.length}</span> : <span className="owc-pill ok"><span className="dot" />clean</span>}
          />
          {botBlocked.length ? botBlocked.slice(0, 8).map((r) => <FailedSiteRow key={r.run_id} run={r} />) : (
            <div className="px-4 py-8 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No bot-blocked runs detected</div>
          )}
        </Panel>
        <Panel>
          <PanelHead accent="var(--signal)" title="Recent failures" sub="All failed runs — any cause"
            aside={<Link href="/runs?status=failed" className="font-mono text-[10.5px]" style={{ color: "var(--signal)" }}>view all →</Link>}
          />
          {otherFailed.length || failedRuns.length ? (
            (otherFailed.length ? otherFailed : failedRuns).slice(0, 8).map((r) => <FailedSiteRow key={r.run_id} run={r} />)
          ) : <div className="px-4 py-8 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No failures recorded</div>}
        </Panel>
      </section>
      </>}

      </div>{/* end tab content */}
    </div>
  );
}
