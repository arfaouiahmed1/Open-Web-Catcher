import { apiFetch } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { KpiCard } from "@/components/kpi-card";
import { DataTable } from "@/components/data-table";
import Link from "next/link";

/* ── stacked bar trend chart ─────────────────────────────────────────────── */

function TrendChart({ rows = [] }) {
  const days = rows.length ? rows : [
    { date: "—", successes: 0, partials: 0, failures: 0 },
  ];
  const maxTotal = Math.max(...days.map((d) => (d.successes || 0) + (d.partials || 0) + (d.failures || 0)), 1);

  return (
    <svg viewBox="0 0 420 170" width="100%" style={{ display: "block" }}>
      {/* grid lines */}
      {[0, 35, 70, 105, 140].map((y) => (
        <line key={y} x1="10" x2="420" y1={y} y2={y} stroke="rgba(255,255,255,0.04)" />
      ))}
      {days.slice(-7).map((d, i) => {
        const s = Math.round(((d.successes || 0) / maxTotal) * 140);
        const p = Math.round(((d.partials  || 0) / maxTotal) * 140);
        const f = Math.round(((d.failures  || 0) / maxTotal) * 140);
        const x = 20 + i * 56;
        const label = d.date ? String(d.date).slice(5) : `D${i + 1}`;
        return (
          <g key={i} transform={`translate(${x},0)`}>
            <rect x="0" y={140 - s}     width="30" height={s} fill="var(--mint)"   rx="2" />
            <rect x="0" y={140 - s - p} width="30" height={p} fill="var(--signal)" rx="1" />
            <rect x="0" y={140 - s - p - f} width="30" height={f} fill="var(--rose)" rx="1" />
            <text x="15" y="158" textAnchor="middle" fontFamily="JetBrains Mono" fontSize="10" fill="var(--mute-2)">{label}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ── active run avatar ───────────────────────────────────────────────────── */

function ActiveRunRow({ run }) {
  const initial = (run.root_actor || "R")[0].toUpperCase();
  const ev    = run.event_count   || 0;
  const tools = run.total_tool_calls || 0;
  const cost  = run.total_cost_usd ?? run.estimated_total_cost_usd ?? 0;

  return (
    <div
      className="grid items-center gap-3 border-b border-[var(--line)] px-4 py-3 last:border-0"
      style={{ gridTemplateColumns: "auto 1fr auto" }}
    >
      <div
        className="relative flex h-[30px] w-[30px] items-center justify-center rounded-lg font-mono text-[11px]"
        style={{
          background: "color-mix(in oklch, var(--violet) 14%, transparent)",
          color: "var(--violet)",
        }}
      >
        {initial}
        <span
          className="absolute inset-[-3px] rounded-[10px] border animate-breathe"
          style={{ borderColor: "color-mix(in oklch, var(--violet) 40%, transparent)" }}
        />
      </div>
      <div>
        <div className="flex items-center gap-2">
          <span className="mono text-[11.5px] text-[var(--ink-dim)]">{run.run_id?.slice(0, 10) || "—"}</span>
          <span className="owc-pill live"><span className="dot" />{run.root_actor || "running"}</span>
        </div>
        <div className="mono mt-0.5 text-[11px] text-[var(--mute)]">{run.root_actor || "actor"}</div>
      </div>
      <div className="text-right">
        <div className="font-mono text-[13px] text-[var(--ink)]">{formatCurrency(cost)}</div>
        <div className="mono text-[10.5px] text-[var(--mute-2)]">{ev} ev · {tools} tools</div>
      </div>
    </div>
  );
}

/* ── share bar row ───────────────────────────────────────────────────────── */

function ShareBar({ label, value, share, color = "var(--signal)" }) {
  return (
    <div className="grid items-center gap-3 px-4 py-[11px] text-sm border-b border-[var(--line)] last:border-0" style={{ gridTemplateColumns: "1fr auto 140px" }}>
      <span style={{ color: "var(--ink)" }}>{label}</span>
      <span className="mono text-right text-[12px]" style={{ color: "var(--mute)" }}>{value}</span>
      <div className="h-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
        <div className="h-full rounded-full" style={{ width: `${share}%`, background: color }} />
      </div>
    </div>
  );
}

/* ── section header ──────────────────────────────────────────────────────── */

function SectionLabel({ children, aside }) {
  return (
    <div className="mb-3 flex items-baseline gap-2.5 text-[10px] font-semibold uppercase tracking-[0.16em]" style={{ color: "var(--mute)" }}>
      <span>{children}</span>
      <span className="flex-1 h-px" style={{ background: "var(--line)" }} />
      {aside && <span className="mono text-[11px] normal-case tracking-normal" style={{ color: "var(--mute-2)" }}>{aside}</span>}
    </div>
  );
}

/* ── panel wrapper ───────────────────────────────────────────────────────── */

function Panel({ children, className = "" }) {
  return (
    <div
      className={`rounded-[14px] border border-[var(--line)] ${className}`}
      style={{ background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      {children}
    </div>
  );
}

function PanelHead({ title, sub, aside }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-[var(--line)] px-[18px] py-3.5">
      <div>
        <div className="text-[13.5px] font-medium text-[var(--ink)]">{title}</div>
        {sub && <div className="text-[12px] text-[var(--mute)]">{sub}</div>}
      </div>
      {aside && <div className="ml-auto">{aside}</div>}
    </div>
  );
}

/* ── page ────────────────────────────────────────────────────────────────── */

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  let overview = {
    summary: {}, trend: [], model_breakdown: [],
    provider_breakdown: [], recent_runs: [],
    evaluation_summary: {}, active_runs: [], top_tools: [],
  };
  try { overview = await apiFetch("/ui/overview"); } catch { /* backend may not be ready */ }

  const s  = overview.summary || {};
  const e  = overview.evaluation_summary || {};
  const tr = overview.trend || [];

  /* KPI data */
  const runKpis = [
    { label: "Total runs",   value: formatNumber(s.total_runs   || 0), description: "Persisted orchestrator runs", sparkData: tr.slice(-7).map((r) => r.runs || 0), delta: "+8.2%"  },
    { label: "Success rate", value: formatPercent(s.success_rate || 0), description: "Runs with final success",      bar: (s.success_rate || 0) * 100, accent: "mint" },
    { label: "Avg latency",  value: `${(s.avg_latency_seconds || 0).toFixed(1)}s`, description: "End-to-end runtime", sparkData: tr.slice(-7).map((r) => r.avg_latency_seconds || 0) },
    { label: "Total cost",   value: formatCurrency(s.total_cost_usd || 0), description: "First-party model spend",   sparkData: tr.slice(-7).map((r) => r.cost_usd || 0) },
    { label: "Total tokens", value: formatNumber(s.total_tokens || 0), description: "Prompt + completion",           sparkData: tr.slice(-7).map((r) => r.tokens || 0) },
    { label: "Tool success", value: formatPercent(s.tool_success_rate || 0), description: "Observed tool call success", bar: (s.tool_success_rate || 0) * 100, accent: "mint" },
    { label: "Stream yield", value: formatPercent(s.stream_yield_rate || 0), description: "Runs that extracted a stream", bar: (s.stream_yield_rate || 0) * 100, accent: "accent" },
    { label: "Email yield",  value: formatPercent(s.email_yield_rate  || 0), description: "Runs that drafted a takedown",  bar: (s.email_yield_rate  || 0) * 100, accent: "accent" },
  ];

  const evalKpis = [
    { label: "Eval pass rate",   value: formatPercent(e.latest_success_rate || 0), description: "Latest benchmark pass",   bar: (e.latest_success_rate || 0) * 100, accent: "mint" },
    { label: "Hallucination",    value: formatPercent(e.latest_hallucination_rate || 0), description: "Unsupported-claim rate", bar: (e.latest_hallucination_rate || 0) * 100, accent: "rose" },
    { label: "Tool accuracy",    value: formatPercent(e.latest_tool_accuracy_rate || 0), description: "Required tool discipline", bar: (e.latest_tool_accuracy_rate || 0) * 100 },
    { label: "Reliability",      value: formatPercent(e.latest_reliability_rate || 0), description: "Tool stability during eval", bar: (e.latest_reliability_rate || 0) * 100, accent: "mint" },
  ];

  /* Model breakdown for share bars */
  const modelRows = (overview.model_breakdown || []).slice(0, 5);
  const modelTotal = modelRows.reduce((s, r) => s + Number(r.cost_usd || 0), 0) || 1;
  const colors = ["var(--signal)", "var(--violet)", "var(--mint)", "var(--sky)"];

  /* Provider breakdown for share bars */
  const provRows = (overview.provider_breakdown || []).slice(0, 5);
  const provMax  = Math.max(...provRows.map((r) => Number(r.analysis_count || r.count || 0)), 1);

  /* Top tools */
  const toolRows = (overview.top_tools || []).slice(0, 6);
  const toolMax  = Math.max(...toolRows.map((r) => Number(r.calls || 0)), 1);

  /* Active runs */
  const activeRuns = (overview.active_runs || []).filter((r) => !r.completed).slice(0, 4);

  return (
    <div className="space-y-8">

      {/* ── header ── */}
      <div className="flex items-start justify-between gap-6">
        <div>
          <span className="owc-eyebrow">overview · live</span>
          <h1 className="mt-2 font-['Inter_Tight',sans-serif] text-3xl font-medium tracking-tight text-[var(--ink)]">
            Operator dashboard
          </h1>
          <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
            Health of every persisted run, agent, tool, and evaluation suite, drawn from the internal Postgres store. Updated every 6 seconds.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Link
            href="/runs"
            className="flex items-center gap-2 rounded-lg border border-[var(--line)] px-3 py-1.5 text-[12.5px] text-[var(--ink-dim)] transition-colors hover:border-[var(--line-hi)] hover:text-[var(--ink)]"
            style={{ background: "var(--card)" }}
          >
            View runs →
          </Link>
          <Link
            href="/live"
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-medium"
            style={{ background: "var(--signal)", color: "#0d0a04", boxShadow: "var(--shadow-glow)" }}
          >
            ▶ New pipeline
          </Link>
        </div>
      </div>

      {/* ── pipeline KPIs ── */}
      <section>
        <SectionLabel aside={`n = ${formatNumber(s.total_runs || 0)} runs`}>Pipeline · last 7 days</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {runKpis.map((k) => <KpiCard key={k.label} {...k} />)}
        </div>
      </section>

      {/* ── evaluation KPIs ── */}
      <section>
        <SectionLabel aside="latest suite">Evaluation</SectionLabel>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {evalKpis.map((k) => <KpiCard key={k.label} {...k} />)}
        </div>
      </section>

      {/* ── trend chart + active runs ── */}
      <section className="grid gap-5 xl:grid-cols-[1.25fr_1fr]">
        <Panel>
          <PanelHead
            title="Run trend"
            sub="7-day volume & status mix"
            aside={
              <div className="flex gap-3 font-mono text-[11px]" style={{ color: "var(--mute-2)" }}>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--mint)" }} />success</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--signal)" }} />partial</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--rose)" }} />failed</span>
              </div>
            }
          />
          <div className="px-5 pb-3.5 pt-4">
            <TrendChart rows={tr} />
          </div>
        </Panel>

        <Panel>
          <PanelHead
            title="Active runs"
            sub="In-memory, still streaming"
            aside={
              activeRuns.length > 0
                ? <span className="owc-pill live"><span className="dot" />{activeRuns.length} live</span>
                : <span className="owc-pill"><span className="dot" style={{ background: "var(--mute-3)" }} />idle</span>
            }
          />
          <div>
            {activeRuns.length ? (
              activeRuns.map((r) => <ActiveRunRow key={r.run_id} run={r} />)
            ) : (
              <div className="px-4 py-8 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>
                idle · awaiting next trigger
              </div>
            )}
          </div>
        </Panel>
      </section>

      {/* ── recent runs + model breakdown ── */}
      <section className="grid gap-5 xl:grid-cols-2">
        <Panel>
          <PanelHead
            title="Recent runs"
            sub="Latest persisted orchestrator runs"
            aside={<Link href="/runs" className="text-[11px]" style={{ color: "var(--signal)" }}>view all →</Link>}
          />
          <DataTable
            columns={["run_id", "url", "final_status", "stream_count", "total_cost_usd", "duration_seconds"]}
            rows={overview.recent_runs || []}
            className="rounded-none border-0 shadow-none"
          />
        </Panel>

        <Panel>
          <PanelHead title="Model breakdown" sub="Usage and cost, by model" />
          {modelRows.length ? (
            modelRows.map((r, i) => (
              <ShareBar
                key={r.label || i}
                label={r.label || r.model_name || "—"}
                value={formatCurrency(r.cost_usd || 0)}
                share={(Number(r.cost_usd || 0) / modelTotal) * 100}
                color={colors[i] || "var(--signal)"}
              />
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--mute-3)" }}>No data</div>
          )}
        </Panel>
      </section>

      {/* ── providers + tools ── */}
      <section className="grid gap-5 xl:grid-cols-2">
        <Panel>
          <PanelHead title="Top providers" sub="Where streams are hosted" />
          {provRows.length ? (
            provRows.map((r, i) => (
              <ShareBar
                key={r.provider || i}
                label={r.provider || "—"}
                value={formatNumber(r.analysis_count || r.count || 0)}
                share={((r.analysis_count || r.count || 0) / provMax) * 80}
                color={i === 0 ? "var(--signal)" : i === 1 ? "var(--signal)" : i === 4 ? "var(--rose)" : "var(--mute)"}
              />
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--mute-3)" }}>No data</div>
          )}
        </Panel>

        <Panel>
          <PanelHead title="Top tools" sub="Most-called MCP tools" />
          {toolRows.length ? (
            toolRows.map((r, i) => (
              <div key={r.tool_name || i} className="grid items-center gap-3 border-b border-[var(--line)] px-4 py-[11px] last:border-0" style={{ gridTemplateColumns: "1fr auto 100px auto" }}>
                <span className="mono text-[12px]" style={{ color: "var(--ink)" }}>{r.tool_name}</span>
                <span className="mono text-right text-[11px]" style={{ color: "var(--mute)" }}>{formatNumber(r.calls || 0)}</span>
                <div className="flex items-center gap-2">
                  <div className="flex-1 h-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
                    <div className="h-full rounded-full" style={{ width: `${((r.calls || 0) / toolMax) * 100}%`, background: "var(--mint)" }} />
                  </div>
                </div>
                <span className="mono text-[11px]" style={{ color: "var(--mute)" }}>
                  {Number(r.avg_duration_seconds || 0).toFixed(1)}s
                </span>
              </div>
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm" style={{ color: "var(--mute-3)" }}>No data</div>
          )}
        </Panel>
      </section>

      <div className="mono text-center text-[10px]" style={{ color: "var(--mute-3)" }}>
        source: /ui/overview · rendered {new Date().toISOString()} · dynamic=force-dynamic
      </div>
    </div>
  );
}
