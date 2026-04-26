"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { apiUrl } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { KpiCard } from "@/components/kpi-card";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "costs", label: "Costs" },
  { id: "tokens", label: "Tokens" },
  { id: "tools", label: "Tools" },
  { id: "agents", label: "Agents" },
];

const EMPTY_OBJECT = {};
const EMPTY_ARRAY = [];

async function apiFetch(path) {
  const response = await fetch(apiUrl(path), { cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.json();
}

function Panel({ children, className = "" }) {
  return (
    <div
      className={`overflow-hidden rounded-[14px] border ${className}`}
      style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      {children}
    </div>
  );
}

function PanelHead({ title, sub, aside, accent = "var(--signal)" }) {
  return (
    <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: "var(--line)" }}>
      <span className="h-3 w-0.5 rounded-full" style={{ background: accent }} />
      <div>
        <div className="text-[13px] font-semibold" style={{ color: "var(--ink)" }}>{title}</div>
        {sub ? <div className="text-[11px]" style={{ color: "var(--mute)" }}>{sub}</div> : null}
      </div>
      {aside ? <div className="ml-auto">{aside}</div> : null}
    </div>
  );
}

function TabBar({ active, onChange }) {
  return (
    <div className="flex flex-wrap gap-2 rounded-[14px] border p-1" style={{ borderColor: "var(--line)", background: "var(--card)" }}>
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          onClick={() => onChange(tab.id)}
          className="rounded-[10px] px-3 py-1.5 text-[12px] font-medium transition-colors"
          style={{
            background: active === tab.id ? "color-mix(in oklch, var(--signal) 14%, transparent)" : "transparent",
            border: active === tab.id ? "1px solid color-mix(in oklch, var(--signal) 28%, transparent)" : "1px solid transparent",
            color: active === tab.id ? "var(--signal)" : "var(--mute)",
          }}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

function ShareRow({ label, value, share, color, sub }) {
  return (
    <div className="grid items-center gap-3 border-b px-4 py-3 last:border-0" style={{ borderColor: "var(--line)", gridTemplateColumns: "1fr auto 140px" }}>
      <div className="min-w-0">
        <div className="truncate text-[12px]" style={{ color: "var(--ink)" }} title={label}>{label}</div>
        {sub ? <div className="mt-0.5 font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>{sub}</div> : null}
      </div>
      <div className="font-mono text-[11px]" style={{ color: "var(--ink-dim)" }}>{value}</div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(share, 0)}%`, background: color }} />
      </div>
    </div>
  );
}

function TokenRow({ row, maxTotal }) {
  const total = Math.max(row.newIn + row.cachedIn + row.out, 1);
  const width = 300;
  const newWidth = Math.round((row.newIn / maxTotal) * width);
  const cachedWidth = Math.round((row.cachedIn / maxTotal) * width);
  const outWidth = Math.round((row.out / maxTotal) * width);

  return (
    <div className="grid items-center gap-3 border-b px-4 py-3 last:border-0" style={{ borderColor: "var(--line)", gridTemplateColumns: "190px 1fr auto" }}>
      <div className="min-w-0">
        <div className="truncate font-mono text-[10.5px]" style={{ color: "var(--ink-dim)" }} title={row.label}>{row.label}</div>
        <div className="mt-0.5 font-mono text-[10px]" style={{ color: "var(--mute-3)" }}>
          {formatNumber(total)} tok
        </div>
      </div>
      <div className="flex h-3.5 overflow-hidden rounded-full gap-[1px]" style={{ background: "rgba(255,255,255,0.04)" }}>
        {newWidth > 0 ? <span style={{ width: newWidth, background: "var(--signal)" }} /> : null}
        {cachedWidth > 0 ? <span style={{ width: cachedWidth, background: "var(--violet)" }} /> : null}
        {outWidth > 0 ? <span style={{ width: outWidth, background: "var(--mint)" }} /> : null}
      </div>
      <div className="font-mono text-[11px]" style={{ color: "var(--ink-dim)" }}>
        {formatCurrency(row.cost_usd || 0)}
      </div>
    </div>
  );
}

function ActiveRunRow({ run }) {
  return (
    <div className="grid items-center gap-3 border-b px-4 py-3 last:border-0" style={{ borderColor: "var(--line)", gridTemplateColumns: "1fr auto" }}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link href={`/runs/${run.run_id}`} className="font-mono text-[11px]" style={{ color: "var(--signal)" }}>
            {run.run_id?.slice(0, 12) || "run"}
          </Link>
          <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ background: "color-mix(in oklch, var(--violet) 14%, transparent)", color: "var(--violet)" }}>
            {run.root_actor || "running"}
          </span>
        </div>
        <div className="mt-1 truncate font-mono text-[10px]" style={{ color: "var(--mute)" }} title={run.url}>
          {run.url || "-"}
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono text-[12px]" style={{ color: "var(--ink)" }}>
          {formatCurrency(run.total_cost_usd ?? run.estimated_total_cost_usd ?? 0)}
        </div>
        <div className="font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>
          {formatNumber(run.total_llm_calls || 0)} llm / {formatNumber(run.total_tool_calls || 0)} tools
        </div>
      </div>
    </div>
  );
}

function ToolReliabilityRow({ row }) {
  const rate = Number(row.success_rate || 0);
  const color = rate >= 0.9 ? "var(--mint)" : rate >= 0.7 ? "var(--signal)" : "var(--rose)";
  return (
    <div className="grid items-center gap-3 border-b px-4 py-2.5 last:border-0" style={{ borderColor: "var(--line)", gridTemplateColumns: "1fr 72px 90px 72px" }}>
      <div className="min-w-0 font-mono text-[11px] truncate" style={{ color: "var(--ink-dim)" }} title={row.tool_name}>{row.tool_name}</div>
      <div className="font-mono text-[11px] text-right" style={{ color: "var(--mute)" }}>{formatNumber(row.calls || 0)}</div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
          <div className="h-full rounded-full" style={{ width: `${rate * 100}%`, background: color }} />
        </div>
        <span className="font-mono text-[10px]" style={{ color }}>{Math.round(rate * 100)}%</span>
      </div>
      <div className="font-mono text-[10px] text-right" style={{ color: "var(--mute-2)" }}>{Number(row.avg_duration_seconds || 0).toFixed(1)}s</div>
    </div>
  );
}

function AgentCard({ row }) {
  const successRate = row.total ? row.success / row.total : 0;
  return (
    <Panel>
      <PanelHead title={row.actor} sub={`${formatNumber(row.total)} runs`} accent="var(--violet)" />
      <div className="space-y-3 p-4">
        <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.05)" }}>
          <div className="h-full rounded-full" style={{ width: `${successRate * 100}%`, background: successRate >= 0.8 ? "var(--mint)" : successRate >= 0.5 ? "var(--signal)" : "var(--rose)" }} />
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="font-mono text-[14px]" style={{ color: "var(--ink)" }}>{formatPercent(successRate)}</div>
            <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>success</div>
          </div>
          <div>
            <div className="font-mono text-[14px]" style={{ color: "var(--ink)" }}>{formatNumber(row.toolCalls)}</div>
            <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>tools</div>
          </div>
          <div>
            <div className="font-mono text-[14px]" style={{ color: "var(--ink)" }}>{Number(row.avgDuration || 0).toFixed(1)}s</div>
            <div className="text-[9px] uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>avg</div>
          </div>
        </div>
      </div>
    </Panel>
  );
}

function FailedRunRow({ row }) {
  return (
    <div className="grid items-center gap-3 border-b px-4 py-2.5 last:border-0" style={{ borderColor: "var(--line)", gridTemplateColumns: "1fr auto auto" }}>
      <div className="min-w-0">
        <div className="truncate font-mono text-[11px]" style={{ color: "var(--ink-dim)" }} title={row.url}>{row.url}</div>
        <div className="mt-0.5 truncate font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>{row.failure_mode || row.final_status || "failed"}</div>
      </div>
      <div className="font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>{row.page_type || "-"}</div>
      <Link href={`/runs/${row.run_id}`} className="font-mono text-[10px]" style={{ color: "var(--signal)" }}>open</Link>
    </div>
  );
}

function OverviewPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = searchParams.get("tab") || "overview";

  const [overview, setOverview] = useState(null);
  const [toolRel, setToolRel] = useState(null);
  const [agentRunsDb, setAgentRunsDb] = useState(null);
  const [failedData, setFailedData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    Promise.allSettled([
      apiFetch("/ui/overview"),
      apiFetch("/ui/tools/reliability?limit=20"),
      apiFetch("/ui/database/agent_runs?limit=300"),
      apiFetch("/ui/runs?status=failed&limit=12&offset=0"),
    ])
      .then(([overviewRes, toolRes, agentRes, failedRes]) => {
        if (!mounted) return;
        setOverview(overviewRes.status === "fulfilled" ? overviewRes.value : {});
        setToolRel(toolRes.status === "fulfilled" ? toolRes.value : {});
        setAgentRunsDb(agentRes.status === "fulfilled" ? agentRes.value : {});
        setFailedData(failedRes.status === "fulfilled" ? failedRes.value : {});
        if (overviewRes.status !== "fulfilled") {
          setError("Could not load overview data.");
        }
      })
      .catch(() => {
        if (mounted) setError("Could not load dashboard data.");
      });
    return () => {
      mounted = false;
    };
  }, []);

  function setTab(nextTab) {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", nextTab);
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  }

  const summary = overview?.summary ?? EMPTY_OBJECT;
  const trend = overview?.trend ?? EMPTY_ARRAY;
  const modelRows = overview?.model_breakdown ?? EMPTY_ARRAY;
  const toolRows = toolRel?.rows ?? overview?.top_tools ?? EMPTY_ARRAY;
  const activeRuns = (overview?.active_runs ?? EMPTY_ARRAY).filter((row) => !row.completed);
  const recentRuns = overview?.recent_runs ?? EMPTY_ARRAY;
  const failedRuns = failedData?.rows ?? EMPTY_ARRAY;

  const tokenRows = useMemo(() => (
    modelRows.map((row) => {
      const inputTokens = Number(row.input_tokens || 0);
      const cachedIn = Number(row.cached_input_tokens || 0);
      const newIn = Number(row.new_input_tokens || Math.max(inputTokens - cachedIn, 0));
      const out = Number(row.output_tokens || 0);
      return {
        ...row,
        newIn,
        cachedIn,
        out,
        label: row.label || `${row.provider || "unknown"}::${row.model_name || "unknown"}`,
      };
    })
  ), [modelRows]);

  const maxTokenTotal = Math.max(...tokenRows.map((row) => row.newIn + row.cachedIn + row.out), 1);
  const totalModelCost = modelRows.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0) || 1;
  const providerCostRows = useMemo(() => (
    Object.values(
      modelRows.reduce((acc, row) => {
        const key = String(row.provider || "unknown");
        if (!acc[key]) {
          acc[key] = { provider: key, cost_usd: 0, calls: 0, tokens: 0 };
        }
        acc[key].cost_usd += Number(row.cost_usd || 0);
        acc[key].calls += Number(row.calls || 0);
        acc[key].tokens += Number(row.tokens || 0);
        return acc;
      }, {})
    ).sort((a, b) => b.cost_usd - a.cost_usd)
  ), [modelRows]);
  const totalProviderCost = providerCostRows.reduce((sum, row) => sum + Number(row.cost_usd || 0), 0) || 1;

  const agentSummary = useMemo(() => {
    const rows = agentRunsDb?.rows ?? EMPTY_ARRAY;
    const grouped = new Map();
    for (const row of rows) {
      const actor = row.actor || row.agent_type || "unknown";
      if (!grouped.has(actor)) {
        grouped.set(actor, { actor, total: 0, success: 0, toolCalls: 0, llmCalls: 0, duration: 0 });
      }
      const entry = grouped.get(actor);
      entry.total += 1;
      if (row.status === "success" || row.status === "succeeded") entry.success += 1;
      entry.toolCalls += Number(row.tool_calls_made || 0);
      entry.llmCalls += Number(row.llm_calls_made || 0);
      entry.duration += Number(row.duration_seconds || 0);
    }
    return Array.from(grouped.values())
      .map((row) => ({ ...row, avgDuration: row.total ? row.duration / row.total : 0 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  }, [agentRunsDb]);

  const kpis = [
    { label: "Total runs", value: formatNumber(summary.total_runs || 0), description: "Persisted orchestrator runs", sparkData: trend.map((row) => row.runs || 0) },
    { label: "Success rate", value: formatPercent(summary.success_rate || 0), description: "Terminal successes", bar: (summary.success_rate || 0) * 100, accent: "mint" },
    { label: "Avg latency", value: `${Number(summary.avg_latency_seconds || 0).toFixed(1)}s`, description: "End-to-end runtime", sparkData: trend.map((row) => row.avg_latency_seconds || 0) },
    { label: "Total cost", value: formatCurrency(summary.total_cost_usd || 0), description: "Recorded model spend", sparkData: trend.map((row) => row.cost_usd || 0) },
    { label: "Total tokens", value: formatNumber(summary.total_tokens || 0), description: "Input + output", sparkData: trend.map((row) => row.tokens || 0) },
    { label: "Cached input", value: formatNumber(summary.total_cached_input_tokens || 0), description: "Prompt cache tokens" },
    { label: "Tool success", value: formatPercent(summary.tool_success_rate || 0), description: "Observed tool call success", bar: (summary.tool_success_rate || 0) * 100, accent: "mint" },
    { label: "Active runs", value: formatNumber(activeRuns.length), description: "Currently streaming" },
  ];

  const colors = ["var(--signal)", "var(--violet)", "var(--mint)", "var(--sky)", "var(--rose)"];

  if (!overview) {
    return (
      <div className="space-y-6">
        <div>
          <span className="owc-eyebrow">operator console</span>
          <h1 className="mt-2 text-3xl font-semibold" style={{ color: "var(--ink)" }}>Operator Dashboard</h1>
        </div>
        <Panel>
          <div className="px-4 py-10 text-center text-[13px]" style={{ color: "var(--mute)" }}>Loading overview...</div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="owc-eyebrow">operator console · live</span>
          <h1 className="mt-2 text-3xl font-semibold" style={{ color: "var(--ink)" }}>Operator Dashboard</h1>
          <p className="mt-1.5 max-w-[62ch] text-[13px] leading-relaxed" style={{ color: "var(--mute)" }}>
            Real run, tool, token, and model-cost telemetry from the pipeline database and active traces.
          </p>
        </div>
        <div className="flex gap-2">
          <Link
            href="/runs"
            className="rounded-[10px] border px-3 py-1.5 text-[12px]"
            style={{ borderColor: "var(--line)", background: "var(--card)", color: "var(--ink-dim)" }}
          >
            All runs
          </Link>
          <Link
            href="/live"
            className="rounded-[10px] px-3 py-1.5 text-[12px] font-semibold"
            style={{ background: "var(--signal)", color: "#0d0a04", boxShadow: "var(--shadow-glow)" }}
          >
            New pipeline
          </Link>
        </div>
      </div>

      {error ? (
        <Panel>
          <div className="px-4 py-3 text-[12px]" style={{ color: "var(--rose)" }}>{error}</div>
        </Panel>
      ) : null}

      <TabBar active={tab} onChange={setTab} />

      {tab === "overview" ? (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {kpis.map((kpi) => <KpiCard key={kpi.label} {...kpi} />)}
          </div>

          <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
            <Panel>
              <PanelHead
                title="Active runs"
                sub="Live traces still streaming"
                accent="var(--violet)"
                aside={<span className="font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>{formatNumber(activeRuns.length)} live</span>}
              />
              {activeRuns.length ? activeRuns.slice(0, 6).map((row) => <ActiveRunRow key={row.run_id} run={row} />) : (
                <div className="px-4 py-10 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No active runs</div>
              )}
            </Panel>

            <Panel>
              <PanelHead title="Recent runs" sub="Latest persisted pipeline runs" accent="var(--mint)" />
              <div className="overflow-x-auto">
                <table className="min-w-full text-[12px]">
                  <thead>
                    <tr className="border-b" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.015)" }}>
                      {["Run", "Status", "Streams", "Tokens", "Cost", "Duration"].map((header) => (
                        <th key={header} className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--mute-2)" }}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {recentRuns.length ? recentRuns.slice(0, 8).map((row) => (
                      <tr key={row.run_id} className="border-b" style={{ borderColor: "var(--line)" }}>
                        <td className="px-4 py-2.5">
                          <Link href={`/runs/${row.run_id}`} className="font-mono text-[11px]" style={{ color: "var(--signal)" }}>
                            {row.run_id?.slice(0, 12)}
                          </Link>
                        </td>
                        <td className="px-4 py-2.5 font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>{row.final_status || "-"}</td>
                        <td className="px-4 py-2.5 font-mono text-[11px]" style={{ color: "var(--ink-dim)" }}>{formatNumber(row.stream_count || 0)}</td>
                        <td className="px-4 py-2.5 font-mono text-[11px]" style={{ color: "var(--ink-dim)" }}>{formatNumber((row.total_tokens_in || 0) + (row.total_tokens_out || 0))}</td>
                        <td className="px-4 py-2.5 font-mono text-[11px]" style={{ color: "var(--ink-dim)" }}>{formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}</td>
                        <td className="px-4 py-2.5 font-mono text-[11px]" style={{ color: "var(--mute)" }}>{Number(row.duration_seconds || 0).toFixed(1)}s</td>
                      </tr>
                    )) : (
                      <tr>
                        <td colSpan={6} className="px-4 py-10 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>
                          No runs yet
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>
        </div>
      ) : null}

      {tab === "costs" ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <Panel>
            <PanelHead title="Cost by model" sub="Rolled up from recorded model usage" accent="var(--rose)" />
            {modelRows.length ? modelRows.map((row, index) => (
              <ShareRow
                key={`${row.provider}-${row.model_name}-${index}`}
                label={row.label || `${row.provider}::${row.model_name}`}
                value={formatCurrency(row.cost_usd || 0)}
                share={(Number(row.cost_usd || 0) / totalModelCost) * 100}
                color={colors[index % colors.length]}
                sub={`${formatNumber(row.calls || 0)} calls / ${formatNumber(row.tokens || 0)} tok`}
              />
            )) : (
              <div className="px-4 py-10 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No model cost data yet</div>
            )}
          </Panel>

          <Panel>
            <PanelHead title="Cost by provider" sub="Aggregated from model rows, not estimates" accent="var(--sky)" />
            {providerCostRows.length ? providerCostRows.map((row, index) => (
              <ShareRow
                key={`${row.provider}-${index}`}
                label={row.provider}
                value={formatCurrency(row.cost_usd || 0)}
                share={(Number(row.cost_usd || 0) / totalProviderCost) * 100}
                color={colors[index % colors.length]}
                sub={`${formatNumber(row.calls || 0)} calls / ${formatNumber(row.tokens || 0)} tok`}
              />
            )) : (
              <div className="px-4 py-10 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No provider cost data yet</div>
            )}
          </Panel>
        </div>
      ) : null}

      {tab === "tokens" ? (
        <Panel>
          <PanelHead
            title="Token usage by model"
            sub="New input, cached input, and output are taken from recorded usage"
            accent="var(--sky)"
            aside={
              <div className="flex gap-3 font-mono text-[10px]" style={{ color: "var(--mute-2)" }}>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--signal)" }} />new</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--violet)" }} />cached</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-sm" style={{ background: "var(--mint)" }} />output</span>
              </div>
            }
          />
          {tokenRows.length ? (
            <>
              {tokenRows.map((row) => <TokenRow key={row.label} row={row} maxTotal={maxTokenTotal} />)}
              <div className="grid items-center gap-3 border-t px-4 py-3" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.015)", gridTemplateColumns: "1fr 1fr 1fr 1fr auto" }}>
                <span className="font-mono text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--mute)" }}>Totals</span>
                <span className="font-mono text-[11px]" style={{ color: "var(--signal)" }}>{formatNumber(summary.total_new_input_tokens || 0)} new</span>
                <span className="font-mono text-[11px]" style={{ color: "var(--violet)" }}>{formatNumber(summary.total_cached_input_tokens || 0)} cached</span>
                <span className="font-mono text-[11px]" style={{ color: "var(--mint)" }}>{formatNumber(summary.total_tokens_out || 0)} output</span>
                <span className="font-mono text-[11px]" style={{ color: "var(--ink-dim)" }}>{formatCurrency(summary.total_cost_usd || 0)}</span>
              </div>
            </>
          ) : (
            <div className="px-4 py-10 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No token usage yet</div>
          )}
        </Panel>
      ) : null}

      {tab === "tools" ? (
        <Panel>
          <PanelHead title="Tool reliability" sub="Success rate and average duration from recorded tool calls" accent="var(--sky)" />
          <div className="grid border-b px-4 py-2" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.015)", gridTemplateColumns: "1fr 72px 90px 72px" }}>
            {["tool", "calls", "success", "avg"].map((header) => (
              <div key={header} className="font-mono text-[10px] uppercase tracking-[0.12em] first:text-left text-right" style={{ color: "var(--mute-2)" }}>{header}</div>
            ))}
          </div>
          {toolRows.length ? toolRows.slice(0, 14).map((row) => <ToolReliabilityRow key={row.tool_name} row={row} />) : (
            <div className="px-4 py-10 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No tool calls recorded yet</div>
          )}
        </Panel>
      ) : null}

      {tab === "agents" ? (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {agentSummary.length ? agentSummary.map((row) => <AgentCard key={row.actor} row={row} />) : (
              <Panel className="sm:col-span-2 xl:col-span-3">
                <div className="px-4 py-10 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No agent runs recorded yet</div>
              </Panel>
            )}
          </div>

          <Panel>
            <PanelHead title="Recent failures" sub="Latest failed pipeline runs" accent="var(--rose)" />
            {failedRuns.length ? failedRuns.map((row) => <FailedRunRow key={row.run_id} row={row} />) : (
              <div className="px-4 py-10 text-center font-mono text-[12px]" style={{ color: "var(--mute-3)" }}>No failed runs recorded</div>
            )}
          </Panel>
        </div>
      ) : null}
    </div>
  );
}

export default function OverviewPage() {
  return (
    <Suspense
      fallback={
        <Panel>
          <div className="px-4 py-10 text-center text-[13px]" style={{ color: "var(--mute)" }}>Loading dashboard...</div>
        </Panel>
      }
    >
      <OverviewPageContent />
    </Suspense>
  );
}
