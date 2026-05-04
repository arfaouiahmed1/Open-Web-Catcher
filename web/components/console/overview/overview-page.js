"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot, CircleDollarSign, Coins, Cpu, LayoutGrid, Loader2 } from "lucide-react";

import { apiUrl } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { KpiCard } from "@/components/kpi-card";
import { DashboardPersistencePanel } from "@/components/dashboard";
import { RuntimeEventsPanel } from "@/components/runtime-events-panel";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/* ─── tabs ────────────────────────────────────────────────────────────────── */
const TABS = [
  { id: "overview", label: "Overview", Icon: LayoutGrid },
  { id: "costs", label: "Costs", Icon: CircleDollarSign },
  { id: "tokens", label: "Tokens", Icon: Coins },
  { id: "tools", label: "Tools", Icon: Cpu },
  { id: "agents", label: "Agents", Icon: Bot },
];

const EMPTY_OBJECT = {};
const EMPTY_ARRAY = [];

const PALETTE = [
  "var(--signal)",
  "var(--violet)",
  "var(--mint)",
  "var(--sky)",
  "var(--rose)",
];

async function apiFetch(path) {
  const res = await fetch(apiUrl(path), { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHART PRIMITIVES
═══════════════════════════════════════════════════════════════════════════ */

/** Smooth bezier area + line chart. `data` = array of numbers. */
function AreaLine({ data = [], color = "var(--signal)", height = 72 }) {
  const gid = useRef(`al${Math.random().toString(36).slice(2)}`).current;
  if (!data || data.length < 2) return <div style={{ height }} />;
  const W = 480,
    H = height,
    pd = { t: 6, b: 6, l: 2, r: 2 };
  const vals = data.map((v) => Number(v) || 0);
  const mx = Math.max(...vals, 0.001);
  const mn = 0;
  const rng = mx - mn || 1;
  const cw = W - pd.l - pd.r;
  const ch = H - pd.t - pd.b;
  const pts = vals.map((v, i) => [
    pd.l + (i / (vals.length - 1)) * cw,
    pd.t + ch - ((v - mn) / rng) * ch,
  ]);
  const line = pts.reduce((acc, [x, y], i) => {
    if (i === 0) return `M${x.toFixed(1)},${y.toFixed(1)}`;
    const [px, py] = pts[i - 1];
    const cx1 = (px + x) / 2;
    return `${acc} C${cx1.toFixed(1)},${py.toFixed(1)} ${cx1.toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
  }, "");
  const area = `${line} L${pts.at(-1)[0].toFixed(1)},${(pd.t + ch).toFixed(1)} L${pts[0][0].toFixed(1)},${(pd.t + ch).toFixed(1)} Z`;
  return (
    <svg
      width="100%"
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="90%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Progressive vertical bar chart. */
function TrendBars({
  data = [],
  valueKey,
  rawValues,
  color = "var(--signal)",
  height = 56,
}) {
  const vals = rawValues
    ? rawValues
    : data.map((d) => Number(d[valueKey] || 0));
  if (!vals || vals.length < 2) return <div style={{ height }} />;
  const mx = Math.max(...vals, 0.001);
  return (
    <div className="flex items-end gap-[2px]" style={{ height }} aria-hidden>
      {vals.map((v, i) => (
        <div
          key={i}
          className="flex-1 min-w-[3px] rounded-t-[2px]"
          style={{
            height: `${Math.max((v / mx) * 100, 3)}%`,
            background: color,
            opacity: 0.25 + 0.75 * ((i + 1) / vals.length),
          }}
        />
      ))}
    </div>
  );
}

/** Donut / ring chart. segments = [{ label, value, color }] */
function DonutChart({
  segments = [],
  size = 128,
  thickness = 18,
  label,
  sublabel,
}) {
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const total = segments.reduce((s, g) => s + Math.max(0, g.value), 0) || 1;

  let dashOffset = circ * 0.25; // start at top
  const arcs = segments.map((seg) => {
    const pct = Math.max(0, seg.value) / total;
    const dash = pct * circ;
    const arc = { ...seg, dash, gap: circ - dash, offset: -dashOffset };
    dashOffset -= dash;
    return arc;
  });

  return (
    <div
      className="relative flex-shrink-0"
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ transform: "rotate(-90deg)" }}
        aria-hidden
      >
        {/* track */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--line)"
          strokeWidth={thickness}
        />
        {/* segments */}
        {arcs.map(
          (arc, i) =>
            arc.dash > 0.5 && (
              <circle
                key={i}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={arc.color}
                strokeWidth={thickness}
                strokeDasharray={`${arc.dash} ${circ - arc.dash}`}
                strokeDashoffset={arc.offset}
                strokeLinecap="butt"
              />
            ),
        )}
      </svg>
      {label && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">
          <div
            className="font-mono text-[15px] font-bold leading-none"
            style={{ color: "var(--ink)" }}
          >
            {label}
          </div>
          {sublabel && (
            <div
              className="mt-0.5 text-[9px] uppercase tracking-[0.14em]"
              style={{ color: "var(--mute-2)" }}
            >
              {sublabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Half-arc radial gauge. value and max are numbers. */
function RadialGauge({
  value = 0,
  max = 100,
  color = "var(--signal)",
  size = 80,
}) {
  const sw = 10;
  const r = (size - sw) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const pct = Math.min(1, Math.max(0, value / (max || 1)));
  const toR = (deg) => (deg * Math.PI) / 180;
  const arc = (cx, cy, r, a1, a2) => {
    const s = { x: cx + r * Math.cos(toR(a1)), y: cy + r * Math.sin(toR(a1)) };
    const e = { x: cx + r * Math.cos(toR(a2)), y: cy + r * Math.sin(toR(a2)) };
    return `M${s.x.toFixed(2)},${s.y.toFixed(2)} A${r},${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${e.x.toFixed(2)},${e.y.toFixed(2)}`;
  };
  const sweep = -180 + pct * 180;
  return (
    <svg
      width={size}
      height={size / 2 + 6}
      viewBox={`0 0 ${size} ${size / 2 + 6}`}
      aria-hidden
    >
      <path
        d={arc(cx, cy, r, -180, 0)}
        fill="none"
        stroke="var(--line)"
        strokeWidth={sw}
        strokeLinecap="round"
      />
      {pct > 0.01 && (
        <path
          d={arc(cx, cy, r, -180, sweep)}
          fill="none"
          stroke={color}
          strokeWidth={sw}
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function AreaTrendCard({ title, description, data = [], series = [], height = 220 }) {
  const config = Object.fromEntries(
    series.map((item) => [item.key, { label: item.label, color: item.color }]),
  );

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-5">
        <ChartContainer config={config} className="w-full" style={{ height }}>
          <AreaChart data={data} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
            <defs>
              {series.map((item) => (
                <linearGradient key={item.key} id={`fill-${item.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={`var(--color-${item.key})`} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={`var(--color-${item.key})`} stopOpacity={0.04} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} />
            <YAxis tickLine={false} axisLine={false} width={34} />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <ChartLegend content={<ChartLegendContent />} />
            {series.map((item) => (
              <Area
                key={item.key}
                dataKey={item.key}
                type="natural"
                fill={`url(#fill-${item.key})`}
                stroke={`var(--color-${item.key})`}
                strokeWidth={2}
                stackId={item.stackId}
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   LAYOUT PRIMITIVES
═══════════════════════════════════════════════════════════════════════════ */

function Panel({ children, className = "" }) {
  return (
    <Card className={`overflow-hidden ${className}`}>
      {children}
    </Card>
  );
}

function PanelHead({ title, sub, aside, accent = "var(--signal)" }) {
  return (
    <CardHeader className="flex-row items-center gap-3 space-y-0 border-b px-4 py-3">
      <span className="h-3 w-0.5 rounded-full shrink-0" style={{ background: accent }} />
      <div className="flex-1 min-w-0">
        <CardTitle className="text-[13px] font-semibold">{title}</CardTitle>
        {sub && <CardDescription className="text-[11px]">{sub}</CardDescription>}
      </div>
      {aside && <div className="ml-auto shrink-0">{aside}</div>}
    </CardHeader>
  );
}

/** Shadcn tab bar with icons. */
function TabBar({ active, onChange }) {
  return (
    <Tabs value={active} onValueChange={onChange}>
      <TabsList className="h-auto w-full justify-start gap-1 p-1">
        {TABS.map(({ id, label, Icon }) => (
          <TabsTrigger
            key={id}
            value={id}
            className="flex-1 gap-1.5 text-[12px]"
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">{label}</span>
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** Legend row for a donut chart. */
function DonutLegend({ segments }) {
  return (
    <div className="space-y-1.5">
      {segments.map((seg) => (
        <div key={seg.label} className="flex items-center gap-2 text-[11px]">
          <span
            className="h-2 w-2 shrink-0 rounded-sm"
            style={{ background: seg.color }}
          />
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {seg.label}
          </span>
          <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
            {seg.formatted || formatPercent(seg.pct || 0)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Horizontal bar row used across tabs. */
function HBarRow({ label, value, share, color, sub, rank }) {
  return (
    <div className="border-b px-4 py-2.5 last:border-0">
      <div className="flex items-center gap-2">
        {rank != null && (
          <span className="w-4 shrink-0 font-mono text-[10px] text-right text-muted-foreground/50">
            {rank}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-[12px] text-foreground" title={label}>
              {label}
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/70">
              {value}
            </span>
          </div>
          {sub && (
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/60">
              {sub}
            </div>
          )}
          <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${Math.max(share, 0)}%`, background: color }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/* Mini section label */
function SectionLabel({ children }) {
  return (
    <p className="text-[9.5px] font-semibold uppercase tracking-[0.16em] mb-3 text-muted-foreground/60">
      {children}
    </p>
  );
}

/** System live-status pills strip. */
function StatusStrip({ summary, activeRuns }) {
  const items = [
    {
      label: "Active",
      value: activeRuns,
      color: activeRuns > 0 ? "var(--signal)" : "var(--mute-3)",
      live: activeRuns > 0,
    },
    { label: "Queued", value: summary.queued_jobs || 0, color: "var(--mute)" },
    {
      label: "Running",
      value: (summary.running_jobs || 0) + (summary.running_workflows || 0),
      color: "var(--sky)",
    },
    {
      label: "Agents",
      value: summary.running_agent_invocations || 0,
      color: "var(--violet)",
    },
    {
      label: "Peak ∥",
      value: summary.recent_max_parallelism || 0,
      color: "var(--mint)",
    },
    {
      label: "Streams",
      value: summary.total_streams || 0,
      color: "var(--sky)",
    },
    {
      label: "Emails",
      value: summary.total_emails || 0,
      color: "var(--violet)",
    },
    {
      label: "Failed 24h",
      value: summary.failed_run_window_24h || 0,
      color:
        (summary.failed_run_window_24h || 0) > 0
          ? "var(--rose)"
          : "var(--mute-3)",
    },
  ];
  return (
    <div className="flex flex-wrap gap-2">
      {items.map(({ label, value, color, live }) => (
        <div
          key={label}
          className="flex items-center gap-2 rounded-lg border bg-card px-3 py-1.5"
        >
          {live && (
            <span className="relative flex h-[6px] w-[6px] shrink-0">
              <span
                className="absolute inset-0 rounded-full opacity-50"
                style={{ background: color, animation: "ping 1.6s ease-in-out infinite" }}
              />
              <span className="relative h-[6px] w-[6px] rounded-full" style={{ background: color }} />
            </span>
          )}
          <span className="font-mono text-[14px] font-semibold tabular-nums" style={{ color }}>
            {formatNumber(value)}
          </span>
          <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
            {label}
          </span>
        </div>
      ))}
    </div>
  );
}

function ActiveRunRow({ run }) {
  return (
    <div className="grid items-center gap-3 border-b px-4 py-3 last:border-0"
      style={{ gridTemplateColumns: "1fr auto" }}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Link href={`/runs/${run.run_id}`} className="font-mono text-[11px] text-primary hover:underline">
            {run.run_id?.slice(0, 12) || "run"}
          </Link>
          <Badge tone="violet" className="text-[9px] px-1.5 py-0">
            {run.root_actor || "running"}
          </Badge>
        </div>
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={run.url}>
          {run.url || "-"}
        </div>
      </div>
      <div className="text-right">
        <div className="font-mono text-[12px] text-foreground">
          {formatCurrency(run.total_cost_usd ?? run.estimated_total_cost_usd ?? 0)}
        </div>
        <div className="font-mono text-[10px] text-muted-foreground/60">
          {formatNumber(run.total_llm_calls || 0)} llm / {formatNumber(run.total_tool_calls || 0)} tools
        </div>
      </div>
    </div>
  );
}

function FailedRunRow({ row }) {
  return (
    <div className="grid items-center gap-3 border-b px-4 py-2.5 last:border-0"
      style={{ gridTemplateColumns: "1fr auto auto" }}>
      <div className="min-w-0">
        <div className="truncate font-mono text-[11px] text-foreground/80" title={row.url}>
          {row.url}
        </div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/60">
          {row.failure_mode || row.final_status || "failed"}
        </div>
      </div>
      <div className="font-mono text-[10px] text-muted-foreground/60">
        {row.page_type || "-"}
      </div>
      <Link href={`/runs/${row.run_id}`} className="font-mono text-[10px] text-primary hover:underline">
        open
      </Link>
    </div>
  );
}

function ToolReliabilityRow({ row }) {
  const rate = Number(row.success_rate || 0);
  const color =
    rate >= 0.9 ? "var(--mint)" : rate >= 0.7 ? "var(--signal)" : "var(--rose)";
  return (
    <div
      className="grid items-center gap-3 border-b px-4 py-2.5 last:border-0"
      style={{ gridTemplateColumns: "1fr 68px 100px 64px" }}
    >
      <div className="min-w-0 font-mono text-[11px] truncate text-foreground/80" title={row.tool_name}>
        {row.tool_name}
      </div>
      <div className="font-mono text-[11px] text-right text-muted-foreground">
        {formatNumber(row.calls || 0)}
      </div>
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
          <div className="h-full rounded-full" style={{ width: `${rate * 100}%`, background: color }} />
        </div>
        <span
          className="font-mono text-[10px] w-8 text-right"
          style={{ color }}
        >
          {Math.round(rate * 100)}%
        </span>
      </div>
      <div
        className="font-mono text-[10px] text-right"
        style={{ color: "var(--mute-2)" }}
      >
        {Number(row.avg_duration_seconds || 0).toFixed(1)}s
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════════════════════════════════════ */

function OverviewPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = searchParams.get("tab") || "overview";

  const [overview, setOverview] = useState(null);
  const [toolRel, setToolRel] = useState(null);
  const [agentRunsDb, setAgentRunsDb] = useState(null);
  const [failedData, setFailedData] = useState(null);
  const [runtimeEvents, setRuntimeEvents] = useState([]);
  const [dbTables, setDbTables] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    Promise.allSettled([
      apiFetch("/ui/overview"),
      apiFetch("/ui/tools/reliability?limit=20"),
      apiFetch("/ui/database/agent_runs?limit=300"),
      apiFetch("/ui/runs?status=failed&limit=12&offset=0"),
      apiFetch("/ui/events/recent?limit=30"),
      apiFetch("/ui/database/tables"),
    ])
      .then(
        ([
          overviewRes,
          toolRes,
          agentRes,
          failedRes,
          eventsRes,
          dbTablesRes,
        ]) => {
          if (!mounted) return;
          setOverview(
            overviewRes.status === "fulfilled" ? overviewRes.value : {},
          );
          setToolRel(toolRes.status === "fulfilled" ? toolRes.value : {});
          setAgentRunsDb(agentRes.status === "fulfilled" ? agentRes.value : {});
          setFailedData(
            failedRes.status === "fulfilled" ? failedRes.value : {},
          );
          setRuntimeEvents(
            eventsRes.status === "fulfilled"
              ? eventsRes.value?.events || []
              : [],
          );
          setDbTables(
            dbTablesRes.status === "fulfilled"
              ? dbTablesRes.value?.entries || []
              : [],
          );
          if (overviewRes.status !== "fulfilled")
            setError("Could not load overview data.");
        },
      )
      .catch(() => {
        if (mounted) setError("Could not load dashboard data.");
      });
    return () => {
      mounted = false;
    };
  }, []);

  function setTab(next) {
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", next);
    router.push(`${pathname}?${p.toString()}`, { scroll: false });
  }

  /* ── derived data ────────────────────────────────────────────────────── */
  const summary = overview?.summary ?? EMPTY_OBJECT;
  const trend = overview?.trend ?? EMPTY_ARRAY;
  const modelRows = overview?.model_breakdown ?? EMPTY_ARRAY;
  const toolRows = toolRel?.rows ?? overview?.top_tools ?? EMPTY_ARRAY;
  const activeRuns = (overview?.active_runs ?? EMPTY_ARRAY).filter(
    (r) => !r.completed,
  );
  const recentRuns = overview?.recent_runs ?? EMPTY_ARRAY;
  const failedRuns = failedData?.rows ?? EMPTY_ARRAY;

  const tokenRows = useMemo(
    () =>
      modelRows.map((row) => {
        const inp = Number(row.input_tokens || 0);
        const cached = Number(row.cached_input_tokens || 0);
        const newIn = Number(row.new_input_tokens || Math.max(inp - cached, 0));
        const out = Number(row.output_tokens || 0);
        return {
          ...row,
          newIn,
          cachedIn: cached,
          out,
          label:
            row.label || `${row.provider || "?"}::${row.model_name || "?"}`,
        };
      }),
    [modelRows],
  );

  const totalModelCost =
    modelRows.reduce((s, r) => s + Number(r.cost_usd || 0), 0) || 1;
  const totalTokensAll = Number(summary.total_tokens || 0) || 1;
  const newInTotal = Number(summary.total_new_input_tokens || 0);
  const cachedInTotal = Number(summary.total_cached_input_tokens || 0);
  const outTotal = Number(summary.total_tokens_out || 0);
  const totalToolCalls =
    Number(summary.observed_tool_calls || summary.total_tool_calls || 0) || 1;
  const successToolCalls = Number(summary.successful_tool_calls || 0);
  const failedToolCalls = Number(summary.failed_tool_calls || 0);

  const providerCostRows = useMemo(
    () =>
      Object.values(
        modelRows.reduce((acc, row) => {
          const k = String(row.provider || "unknown");
          if (!acc[k])
            acc[k] = { provider: k, cost_usd: 0, calls: 0, tokens: 0 };
          acc[k].cost_usd += Number(row.cost_usd || 0);
          acc[k].calls += Number(row.calls || 0);
          acc[k].tokens += Number(row.tokens || 0);
          return acc;
        }, {}),
      ).sort((a, b) => b.cost_usd - a.cost_usd),
    [modelRows],
  );

  const totalProviderCost =
    providerCostRows.reduce((s, r) => s + Number(r.cost_usd || 0), 0) || 1;

  const agentSummary = useMemo(() => {
    const rows = agentRunsDb?.rows ?? EMPTY_ARRAY;
    const grouped = new Map();
    for (const row of rows) {
      const actor = row.actor || row.agent_type || "unknown";
      if (!grouped.has(actor))
        grouped.set(actor, {
          actor,
          total: 0,
          success: 0,
          toolCalls: 0,
          llmCalls: 0,
          duration: 0,
        });
      const e = grouped.get(actor);
      e.total++;
      if (row.status === "success" || row.status === "succeeded") e.success++;
      e.toolCalls += Number(row.tool_calls_made || 0);
      e.llmCalls += Number(row.llm_calls_made || 0);
      e.duration += Number(row.duration_seconds || 0);
    }
    return Array.from(grouped.values())
      .map((r) => ({ ...r, avgDuration: r.total ? r.duration / r.total : 0 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  }, [agentRunsDb]);

  const totalAgentRuns = agentSummary.reduce((s, r) => s + r.total, 0);

  /* Loading skeleton */
  if (!overview) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Loading pipeline telemetry…</p>
        </div>
        <Card>
          <CardContent className="flex items-center justify-center gap-3 py-16">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">Loading overview…</span>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ── Overview KPI sets ───────────────────────────────────────────────── */
  const overviewKpisRow1 = [
    {
      label: "Total runs",
      value: formatNumber(summary.total_runs || 0),
      description: "Persisted orchestrator runs",
      sparkData: trend.map((r) => r.runs || 0),
    },
    {
      label: "Success rate",
      value: formatPercent(summary.success_rate || 0),
      description: "Terminal successes",
      bar: (summary.success_rate || 0) * 100,
      accent: "mint",
    },
    {
      label: "Avg latency",
      value: `${Number(summary.avg_latency_seconds || 0).toFixed(1)}s`,
      description: "End-to-end wall-clock",
      sparkData: trend.map((r) => r.avg_latency_seconds || 0),
    },
    {
      label: "Total cost",
      value: formatCurrency(summary.total_cost_usd || 0),
      description: "Recorded model spend",
      sparkData: trend.map((r) => r.cost_usd || 0),
      accent: "signal",
    },
  ];
  const overviewKpisRow2 = [
    {
      label: "Total tokens",
      value: formatNumber(summary.total_tokens || 0),
      description: "Input + output tokens",
      sparkData: trend.map((r) => r.tokens || 0),
      accent: "sky",
    },
    {
      label: "Active runs",
      value: formatNumber(activeRuns.length),
      description: "Currently streaming",
      live: activeRuns.length > 0,
      accent: activeRuns.length > 0 ? "violet" : undefined,
    },
    {
      label: "Failed 24 h",
      value: formatNumber(summary.failed_run_window_24h || 0),
      description: "Failed runs in last 24 hrs",
      accent: (summary.failed_run_window_24h || 0) > 0 ? "rose" : undefined,
    },
    {
      label: "Tool success",
      value: formatPercent(summary.tool_success_rate || 0),
      description: "Observed tool call success",
      bar: (summary.tool_success_rate || 0) * 100,
      accent: "mint",
    },
  ];
  const overviewKpisRow3 = [
    {
      label: "LLM calls",
      value: formatNumber(summary.total_llm_calls || 0),
      description: "Total model completions",
      accent: "violet",
    },
    {
      label: "Stream yield",
      value: formatPercent(summary.stream_yield_rate || 0),
      description: "Runs that found streams",
      bar: (summary.stream_yield_rate || 0) * 100,
      accent: "sky",
    },
    {
      label: "Cached tokens",
      value: formatNumber(summary.total_cached_input_tokens || 0),
      description: "Prompt cache savings",
      accent: "violet",
    },
    {
      label: "Peak ∥",
      value: formatNumber(summary.recent_max_parallelism || 0),
      description: "Max concurrent agents",
      accent: "mint",
    },
  ];

  /* ── Costs KPI set ───────────────────────────────────────────────────── */
  const costsKpis = [
    {
      label: "Total cost",
      value: formatCurrency(summary.total_cost_usd || 0),
      description: "All recorded model spend",
      sparkData: trend.map((r) => r.cost_usd || 0),
      accent: "signal",
    },
    {
      label: "Avg cost / run",
      value: formatCurrency(summary.avg_cost_usd || 0),
      description: "Per persisted run",
      accent: "signal",
    },
    {
      label: "LLM calls",
      value: formatNumber(summary.total_llm_calls || 0),
      description: "Total model invocations",
      accent: "violet",
    },
    {
      label: "Providers",
      value: formatNumber(summary.unique_providers || 0),
      description: "Distinct provider names",
    },
    {
      label: "Cost / 1k tok",
      value: summary.total_tokens
        ? formatCurrency(
            (summary.total_cost_usd || 0) / (summary.total_tokens / 1000),
          )
        : "$0.000",
      description: "Blended rate",
      accent: "mint",
    },
    {
      label: "Avg LLM / run",
      value: summary.total_runs
        ? formatNumber(
            Math.round((summary.total_llm_calls || 0) / summary.total_runs),
          )
        : "0",
      description: "LLM calls per run",
      accent: "sky",
    },
  ];

  /* ── Tokens KPI set ──────────────────────────────────────────────────── */
  const tokensKpis = [
    {
      label: "Total tokens",
      value: formatNumber(summary.total_tokens || 0),
      description: "Input + output all time",
      sparkData: trend.map((r) => r.tokens || 0),
      accent: "sky",
    },
    {
      label: "New input",
      value: formatNumber(newInTotal),
      description: "Non-cached input tokens",
      accent: "signal",
    },
    {
      label: "Cached input",
      value: formatNumber(cachedInTotal),
      description: "Prompt cache hits",
      accent: "violet",
    },
    {
      label: "Output",
      value: formatNumber(outTotal),
      description: "Generated tokens",
      accent: "mint",
    },
    {
      label: "Cache hit %",
      value: formatPercent(
        cachedInTotal + newInTotal > 0
          ? cachedInTotal / (cachedInTotal + newInTotal)
          : 0,
      ),
      description: "Of total input tokens",
      bar:
        cachedInTotal + newInTotal > 0
          ? (cachedInTotal / (cachedInTotal + newInTotal)) * 100
          : 0,
      accent: "violet",
    },
    {
      label: "Avg tok / run",
      value: summary.total_runs
        ? formatNumber(
            Math.round((summary.total_tokens || 0) / summary.total_runs),
          )
        : "0",
      description: "Per persisted run",
      accent: "sky",
    },
  ];

  /* ── Tools KPI set ───────────────────────────────────────────────────── */
  const toolsKpis = [
    {
      label: "Total calls",
      value: formatNumber(totalToolCalls - 1 === 0 ? 0 : totalToolCalls),
      description: "Observed tool invocations",
      accent: "sky",
    },
    {
      label: "Success rate",
      value: formatPercent(summary.tool_success_rate || 0),
      description: "Successful calls",
      bar: (summary.tool_success_rate || 0) * 100,
      accent: "mint",
    },
    {
      label: "Failed calls",
      value: formatNumber(failedToolCalls),
      description: "Error / failed outcomes",
      accent: failedToolCalls > 0 ? "rose" : undefined,
    },
    {
      label: "Avg duration",
      value: `${Number(summary.avg_tool_duration_seconds || 0).toFixed(2)}s`,
      description: "Average tool call time",
      accent: "signal",
    },
    {
      label: "Unique tools",
      value: formatNumber(toolRows.length),
      description: "Distinct tools observed",
      accent: "violet",
    },
    {
      label: "Calls / run",
      value: summary.total_runs
        ? formatNumber(
            Math.round(
              Number(summary.total_tool_calls || 0) / summary.total_runs,
            ),
          )
        : "0",
      description: "Avg per pipeline run",
      accent: "sky",
    },
  ];

  /* ── Agents KPI set ──────────────────────────────────────────────────── */
  const agentsKpis = [
    {
      label: "Agent runs",
      value: formatNumber(totalAgentRuns),
      description: "Across all agent types",
      accent: "violet",
    },
    {
      label: "Agent types",
      value: formatNumber(agentSummary.length),
      description: "Distinct agent actors",
    },
    {
      label: "LLM calls",
      value: formatNumber(agentSummary.reduce((s, r) => s + r.llmCalls, 0)),
      description: "Total across agents",
      accent: "signal",
    },
    {
      label: "Tool calls",
      value: formatNumber(agentSummary.reduce((s, r) => s + r.toolCalls, 0)),
      description: "Total across agents",
      accent: "sky",
    },
  ];

  /* ── donut segment builders ──────────────────────────────────────────── */
  const providerDonutSegs = providerCostRows.slice(0, 5).map((row, i) => ({
    label: row.provider,
    value: Number(row.cost_usd || 0),
    color: PALETTE[i % PALETTE.length],
    pct: Number(row.cost_usd || 0) / totalProviderCost,
    formatted: formatCurrency(row.cost_usd || 0),
  }));

  const tokenDonutSegs = [
    {
      label: "New input",
      value: newInTotal,
      color: "var(--signal)",
      pct: newInTotal / totalTokensAll,
      formatted: formatNumber(newInTotal),
    },
    {
      label: "Cached in",
      value: cachedInTotal,
      color: "var(--violet)",
      pct: cachedInTotal / totalTokensAll,
      formatted: formatNumber(cachedInTotal),
    },
    {
      label: "Output",
      value: outTotal,
      color: "var(--mint)",
      pct: outTotal / totalTokensAll,
      formatted: formatNumber(outTotal),
    },
  ];

  const toolHealthSegs = [
    {
      label: "Success",
      value: successToolCalls,
      color: "var(--mint)",
      pct: successToolCalls / totalToolCalls,
      formatted: formatNumber(successToolCalls),
    },
    {
      label: "Failed",
      value: failedToolCalls,
      color: "var(--rose)",
      pct: failedToolCalls / totalToolCalls,
      formatted: formatNumber(failedToolCalls),
    },
    {
      label: "Other",
      value: Math.max(0, totalToolCalls - successToolCalls - failedToolCalls),
      color: "var(--mute-3)",
      pct:
        Math.max(0, totalToolCalls - successToolCalls - failedToolCalls) /
        totalToolCalls,
      formatted: formatNumber(
        Math.max(0, totalToolCalls - successToolCalls - failedToolCalls),
      ),
    },
  ].filter((s) => s.value > 0);

  const agentDonutSegs = agentSummary.slice(0, 5).map((row, i) => ({
    label: row.actor,
    value: row.total,
    color: PALETTE[i % PALETTE.length],
    pct: row.total / (totalAgentRuns || 1),
    formatted: formatNumber(row.total),
  }));

  /* ── render ──────────────────────────────────────────────────────────── */
  return (
    <div className="space-y-6">
      {/* ── page header ── */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Real-time run, tool, token and cost telemetry from the pipeline database.
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/runs">All runs</Link>
          </Button>
          <Button variant="accent" size="sm" asChild>
            <Link href="/live">New pipeline</Link>
          </Button>
        </div>
      </div>

      {error && (
        <Card>
          <CardContent className="py-3 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <TabBar active={tab} onChange={setTab} />

      {/* ════════════════════════════════════════════════════════════════════
          OVERVIEW TAB
      ════════════════════════════════════════════════════════════════════ */}
      {tab === "overview" && (
        <div className="space-y-6">
          {/* 3 rows × 4 KPIs */}
          <div className="space-y-3">
            <SectionLabel>Core metrics</SectionLabel>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {overviewKpisRow1.map((kpi) => (
                <KpiCard key={kpi.label} {...kpi} />
              ))}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {overviewKpisRow2.map((kpi) => (
              <KpiCard key={kpi.label} {...kpi} />
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {overviewKpisRow3.map((kpi) => (
              <KpiCard key={kpi.label} {...kpi} />
            ))}
          </div>

          {/* Live status strip */}
          <StatusStrip summary={summary} activeRuns={activeRuns.length} />

          {/* Activity trend — 3 area lines */}
          {trend.length > 2 && (
            <Panel>
              <PanelHead
                title="Activity trend"
                sub="7-day window — runs, cost, tokens"
                accent="var(--sky)"
              />
              <div
                className="grid gap-0 divide-x sm:grid-cols-3"
                style={{ divideColor: "var(--line)" }}
              >
                {[
                  {
                    key: "runs",
                    label: "Runs",
                    color: "var(--signal)",
                    fmt: formatNumber,
                  },
                  {
                    key: "cost_usd",
                    label: "Cost",
                    color: "var(--mint)",
                    fmt: formatCurrency,
                  },
                  {
                    key: "avg_latency_seconds",
                    label: "Latency",
                    color: "var(--violet)",
                    fmt: (v) => `${Number(v || 0).toFixed(1)}s`,
                  },
                ].map(({ key, label, color, fmt }) => {
                  const vals = trend.map((r) => Number(r[key] || 0));
                  const last = vals.at(-1) ?? 0;
                  return (
                    <div key={key} className="p-4">
                      <div className="flex items-center justify-between mb-2">
                        <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/50">
                          {label}
                        </div>
                        <div className="font-mono text-[12px] font-semibold" style={{ color }}>
                          {fmt(last)}
                        </div>
                      </div>
                      <AreaLine data={vals} color={color} height={68} />
                    </div>
                  );
                })}
              </div>
            </Panel>
          )}

          {trend.length > 2 && (
            <AreaTrendCard
              title="Run throughput and LLM load"
              description="Overlay of total runs and LLM calls across the same periods."
              data={trend.map((r) => ({
                date: r.date || "",
                runs: Number(r.runs || 0),
                llm_calls: Number(r.llm_calls || 0),
              }))}
              series={[
                { key: "runs", label: "Runs", color: "var(--chart-1)" },
                { key: "llm_calls", label: "LLM Calls", color: "var(--chart-2)" },
              ]}
              height={210}
            />
          )}

          {/* Active + recent runs */}
          <div className="grid gap-5 xl:grid-cols-[340px_1fr]">
            <Panel>
              <PanelHead
                title="Active runs"
                sub="Live traces still streaming"
                accent="var(--violet)"
                aside={
                  <span
                    className="font-mono text-[10px] text-muted-foreground/60"
                  >
                    {formatNumber(activeRuns.length)} live
                  </span>
                }
              />
              {activeRuns.length ? (
                activeRuns
                  .slice(0, 6)
                  .map((row) => <ActiveRunRow key={row.run_id} run={row} />)
              ) : (
                <div className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40">
                  No active runs
                </div>
              )}
            </Panel>

            <Panel>
              <PanelHead
                title="Recent runs"
                sub="Latest persisted pipeline runs"
                accent="var(--mint)"
              />
              <Table className="min-w-full text-[12px]">
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    {["Run", "Status", "Streams", "Tokens", "Cost", "Duration"].map((h) => (
                      <TableHead key={h} className="px-4 py-2 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                        {h}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentRuns.length ? (
                    recentRuns.slice(0, 8).map((row) => (
                      <TableRow key={row.run_id}>
                        <TableCell className="px-4 py-2.5">
                          <Link href={`/runs/${row.run_id}`} className="font-mono text-[11px] text-primary hover:underline">
                            {row.run_id?.slice(0, 12)}
                          </Link>
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground">
                          {row.final_status || "-"}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px] text-foreground/70">
                          {formatNumber(row.stream_count || 0)}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px] text-foreground/70">
                          {formatNumber((row.total_tokens_in || 0) + (row.total_tokens_out || 0))}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px] text-foreground/70">
                          {formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
                          {Number(row.duration_seconds || 0).toFixed(1)}s
                        </TableCell>
                      </TableRow>
                    ))
                  ) : (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40">
                        No runs yet
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </Panel>
          </div>

          <DashboardPersistencePanel entries={dbTables} />
          <RuntimeEventsPanel events={runtimeEvents} title="Recent events" />
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          COSTS TAB
      ════════════════════════════════════════════════════════════════════ */}
      {tab === "costs" && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {costsKpis.map((kpi) => (
              <KpiCard key={kpi.label} {...kpi} />
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            {/* Provider cost donut */}
            <Panel>
              <PanelHead
                title="Cost by provider"
                sub="Aggregated from model usage rows"
                accent="var(--signal)"
              />
              <div className="flex items-center gap-6 p-5">
                <DonutChart
                  segments={providerDonutSegs}
                  size={148}
                  thickness={22}
                  label={formatCurrency(summary.total_cost_usd || 0)}
                  sublabel="total"
                />
                <div className="flex-1">
                  <DonutLegend segments={providerDonutSegs} />
                </div>
              </div>
              {providerDonutSegs.length === 0 && (
                <div
                  className="px-4 pb-6 text-center font-mono text-[12px] text-muted-foreground/40"
                >
                  No cost data yet
                </div>
              )}
            </Panel>

            {/* Model cost bars */}
            <Panel>
              <PanelHead
                title="Cost by model"
                sub="Top models by recorded spend"
                accent="var(--violet)"
              />
              {modelRows.length ? (
                modelRows
                  .slice(0, 8)
                  .map((row, i) => (
                    <HBarRow
                      key={`${row.provider}-${row.model_name}-${i}`}
                      rank={i + 1}
                      label={row.label || `${row.provider}::${row.model_name}`}
                      value={formatCurrency(row.cost_usd || 0)}
                      share={(Number(row.cost_usd || 0) / totalModelCost) * 100}
                      color={PALETTE[i % PALETTE.length]}
                      sub={`${formatNumber(row.calls || 0)} calls · ${formatNumber(row.tokens || 0)} tok`}
                    />
                  ))
              ) : (
                <div
                  className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40"
                >
                  No model cost data
                </div>
              )}
            </Panel>
          </div>

          {trend.length > 2 && (
            <AreaTrendCard
              title="Cost trend"
              description="Daily cost over the last 7 periods."
              data={trend.map((r) => ({
                date: r.date || "",
                cost_usd: Number(r.cost_usd || 0),
              }))}
              series={[{ key: "cost_usd", label: "Cost", color: "var(--chart-1)" }]}
              height={180}
            />
          )}

          {/* Legacy cost area (hidden) */}
          {false && (
            <Panel>
              <PanelHead
                title="Cost trend"
                sub="Daily cost over the last 7 periods"
                accent="var(--mint)"
              />
              <div className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-[11px] text-muted-foreground">
                    {trend.length} periods
                  </div>
                  <div
                    className="font-mono text-[13px] font-semibold text-primary"
                  >
                    {formatCurrency(summary.total_cost_usd || 0)} total
                  </div>
                </div>
                <AreaLine
                  data={trend.map((r) => Number(r.cost_usd || 0))}
                  color="var(--signal)"
                  height={96}
                />
                <div
                  className="mt-3 flex justify-between font-mono text-[9.5px] text-muted-foreground/40"
                >
                  <span>{trend.at(0)?.date || "oldest"}</span>
                  <span>{trend.at(-1)?.date || "latest"}</span>
                </div>
              </div>
            </Panel>
          )}

          {trend.length > 2 && (
            <AreaTrendCard
              title="LLM calls over time"
              description="Volume of model invocations per period."
              data={trend.map((r) => ({
                date: r.date || "",
                llm_calls: Number(r.llm_calls || 0),
              }))}
              series={[{ key: "llm_calls", label: "LLM Calls", color: "var(--chart-2)" }]}
              height={180}
            />
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          TOKENS TAB
      ════════════════════════════════════════════════════════════════════ */}
      {tab === "tokens" && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {tokensKpis.map((kpi) => (
              <KpiCard key={kpi.label} {...kpi} />
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            {/* Token type donut */}
            <Panel>
              <PanelHead
                title="Token type breakdown"
                sub="New input vs cached vs output"
                accent="var(--sky)"
              />
              <div className="flex items-center gap-6 p-5">
                <DonutChart
                  segments={tokenDonutSegs}
                  size={148}
                  thickness={22}
                  label={formatNumber(summary.total_tokens || 0)}
                  sublabel="total tok"
                />
                <div className="flex-1 space-y-4">
                  <DonutLegend segments={tokenDonutSegs} />
                  {/* Cache hit rate gauge */}
                  <div
                    className="border-t pt-3"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span
                        className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/40"
                      >
                        Cache hit rate
                      </span>
                      <span
                        className="font-mono text-[12px] font-semibold"
                        style={{ color: "var(--violet)" }}
                      >
                        {formatPercent(
                          cachedInTotal + newInTotal > 0
                            ? cachedInTotal / (cachedInTotal + newInTotal)
                            : 0,
                        )}
                      </span>
                    </div>
                    <RadialGauge
                      value={cachedInTotal}
                      max={cachedInTotal + newInTotal || 1}
                      color="var(--violet)"
                      size={80}
                    />
                  </div>
                </div>
              </div>
            </Panel>

            {/* Tokens by model stacked bars */}
            <Panel>
              <PanelHead
                title="Tokens by model"
                sub="New input · cached · output breakdown"
                accent="var(--sky)"
                aside={
                  <div
                    className="flex gap-3 font-mono text-[10px] text-muted-foreground/60"
                  >
                    <span className="flex items-center gap-1">
                      <span
                        className="h-2 w-2 rounded-sm"
                        style={{ background: "var(--signal)" }}
                      />
                      new
                    </span>
                    <span className="flex items-center gap-1">
                      <span
                        className="h-2 w-2 rounded-sm"
                        style={{ background: "var(--violet)" }}
                      />
                      cached
                    </span>
                    <span className="flex items-center gap-1">
                      <span
                        className="h-2 w-2 rounded-sm"
                        style={{ background: "var(--mint)" }}
                      />
                      out
                    </span>
                  </div>
                }
              />
              {tokenRows.length ? (
                tokenRows.map((row) => {
                  const total = Math.max(row.newIn + row.cachedIn + row.out, 1);
                  const maxTotal = Math.max(
                    ...tokenRows.map((r) => r.newIn + r.cachedIn + r.out),
                    1,
                  );
                  const nw = Math.round((row.newIn / maxTotal) * 260);
                  const cw = Math.round((row.cachedIn / maxTotal) * 260);
                  const ow = Math.round((row.out / maxTotal) * 260);
                  return (
                    <div
                      key={row.label}
                      className="grid items-center gap-3 border-b px-4 py-3 last:border-0"
                      style={{
                        borderColor: "var(--line)",
                        gridTemplateColumns: "180px 1fr auto",
                      }}
                    >
                      <div className="min-w-0">
                        <div
                          className="truncate font-mono text-[10.5px] text-foreground/80"
                          title={row.label}
                        >
                          {row.label}
                        </div>
                        <div
                          className="font-mono text-[10px] text-muted-foreground/40"
                        >
                          {formatNumber(total)} tok
                        </div>
                      </div>
                      <div
                        className="flex h-3.5 overflow-hidden rounded-full gap-[1px]"
                        style={{ background: "var(--line)" }}
                      >
                        {nw > 0 && (
                          <span
                            style={{ width: nw, background: "var(--signal)" }}
                          />
                        )}
                        {cw > 0 && (
                          <span
                            style={{ width: cw, background: "var(--violet)" }}
                          />
                        )}
                        {ow > 0 && (
                          <span
                            style={{ width: ow, background: "var(--mint)" }}
                          />
                        )}
                      </div>
                      <div
                        className="font-mono text-[11px] text-foreground/80"
                      >
                        {formatCurrency(row.cost_usd || 0)}
                      </div>
                    </div>
                  );
                })
              ) : (
                <div
                  className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40"
                >
                  No token usage yet
                </div>
              )}
              {tokenRows.length > 0 && (
                <div
                  className="grid items-center gap-3 border-t px-4 py-3"
                  style={{
                    borderColor: "var(--line)",
                    background: "var(--card)",
                    gridTemplateColumns: "1fr 1fr 1fr 1fr auto",
                  }}
                >
                  <span
                    className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground"
                  >
                    Totals
                  </span>
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: "var(--signal)" }}
                  >
                    {formatNumber(newInTotal)} new
                  </span>
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: "var(--violet)" }}
                  >
                    {formatNumber(cachedInTotal)} cached
                  </span>
                  <span
                    className="font-mono text-[11px]"
                    style={{ color: "var(--mint)" }}
                  >
                    {formatNumber(outTotal)} out
                  </span>
                  <span
                    className="font-mono text-[11px] text-foreground/80"
                  >
                    {formatCurrency(summary.total_cost_usd || 0)}
                  </span>
                </div>
              )}
            </Panel>
          </div>

          {trend.length > 2 && (
            <AreaTrendCard
              title="Token volume trend"
              description="Total tokens consumed per period."
              data={trend.map((r) => ({
                date: r.date || "",
                tokens: Number(r.tokens || 0),
              }))}
              series={[{ key: "tokens", label: "Tokens", color: "var(--chart-3)" }]}
              height={190}
            />
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          TOOLS TAB
      ════════════════════════════════════════════════════════════════════ */}
      {tab === "tools" && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {toolsKpis.map((kpi) => (
              <KpiCard key={kpi.label} {...kpi} />
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            {/* Health donut */}
            <Panel>
              <PanelHead
                title="Tool health"
                sub="Success vs failure distribution"
                accent="var(--mint)"
              />
              <div className="flex items-center gap-6 p-5">
                <DonutChart
                  segments={toolHealthSegs}
                  size={148}
                  thickness={22}
                  label={formatPercent(summary.tool_success_rate || 0)}
                  sublabel="success"
                />
                <div className="flex-1 space-y-4">
                  <DonutLegend segments={toolHealthSegs} />
                  <div
                    className="border-t pt-3"
                    style={{ borderColor: "var(--line)" }}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span
                        className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/40"
                      >
                        Success rate
                      </span>
                      <span
                        className="font-mono text-[12px] font-semibold"
                        style={{ color: "var(--mint)" }}
                      >
                        {formatPercent(summary.tool_success_rate || 0)}
                      </span>
                    </div>
                    <RadialGauge
                      value={(summary.tool_success_rate || 0) * 100}
                      max={100}
                      color="var(--mint)"
                      size={80}
                    />
                  </div>
                </div>
              </div>
            </Panel>

            {/* Top tools horizontal bars */}
            <Panel>
              <PanelHead
                title="Top tools by calls"
                sub="Most-used tool names · success rate · avg duration"
                accent="var(--sky)"
              />
              <div
                className="grid border-b px-4 py-2"
                style={{
                  borderColor: "var(--line)",
                  background: "var(--card)",
                  gridTemplateColumns: "1fr 68px 100px 64px",
                }}
              >
                {["tool", "calls", "success", "avg"].map((h) => (
                  <div
                    key={h}
                    className="font-mono text-[10px] uppercase tracking-[0.12em] first:text-left text-right text-muted-foreground/60"
                  >
                    {h}
                  </div>
                ))}
              </div>
              {toolRows.length ? (
                toolRows
                  .slice(0, 12)
                  .map((row) => (
                    <ToolReliabilityRow key={row.tool_name} row={row} />
                  ))
              ) : (
                <div
                  className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40"
                >
                  No tool calls recorded yet
                </div>
              )}
            </Panel>
          </div>

          {/* Tool calls bar chart over time */}
          {trend.length > 2 && (
            <Panel>
              <PanelHead
                title="Tool call volume"
                sub="Tool calls per period"
                accent="var(--sky)"
              />
              <div className="p-5">
                <TrendBars
                  rawValues={trend.map((r) => Number(r.tool_calls || 0))}
                  color="var(--sky)"
                  height={72}
                />
                <div
                  className="mt-2 flex justify-between font-mono text-[9.5px] text-muted-foreground/40"
                >
                  <span>earliest</span>
                  <span>latest</span>
                </div>
              </div>
            </Panel>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════════
          AGENTS TAB
      ════════════════════════════════════════════════════════════════════ */}
      {tab === "agents" && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {agentsKpis.map((kpi) => (
              <KpiCard key={kpi.label} {...kpi} />
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
            {/* Agent cards */}
            <div className="grid gap-3 sm:grid-cols-2">
              {agentSummary.length ? (
                agentSummary.map((row) => {
                  const sr = row.total ? row.success / row.total : 0;
                  const srColor =
                    sr >= 0.8
                      ? "var(--mint)"
                      : sr >= 0.5
                        ? "var(--signal)"
                        : "var(--rose)";
                  return (
                    <Panel key={row.actor}>
                      <div
                        className="border-b px-4 py-3"
                        style={{ borderColor: "var(--line)" }}
                      >
                        <div className="flex items-center justify-between">
                          <div
                            className="text-[13px] font-semibold text-foreground"
                          >
                            {row.actor}
                          </div>
                          <span
                            className="font-mono text-[11px] text-muted-foreground/60"
                          >
                            {formatNumber(row.total)} runs
                          </span>
                        </div>
                        <div
                          className="mt-2 h-1.5 overflow-hidden rounded-full"
                          style={{ background: "var(--line)" }}
                        >
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${sr * 100}%`,
                              background: srColor,
                            }}
                          />
                        </div>
                      </div>
                      <div
                        className="grid grid-cols-4 divide-x text-center"
                        style={{ divideColor: "var(--line)" }}
                      >
                        {[
                          {
                            label: "success",
                            value: formatPercent(sr),
                            color: srColor,
                          },
                          {
                            label: "tools",
                            value: formatNumber(row.toolCalls),
                            color: "var(--sky)",
                          },
                          {
                            label: "llm",
                            value: formatNumber(row.llmCalls),
                            color: "var(--violet)",
                          },
                          {
                            label: "avg",
                            value: `${Number(row.avgDuration || 0).toFixed(1)}s`,
                            color: "var(--mute)",
                          },
                        ].map(({ label, value, color }) => (
                          <div key={label} className="py-3 px-1">
                            <div
                              className="font-mono text-[13px] font-semibold"
                              style={{ color }}
                            >
                              {value}
                            </div>
                            <div
                              className="text-[9px] uppercase tracking-[0.12em] mt-0.5 text-muted-foreground/40"
                            >
                              {label}
                            </div>
                          </div>
                        ))}
                      </div>
                    </Panel>
                  );
                })
              ) : (
                <Panel className="sm:col-span-2">
                  <div
                    className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40"
                  >
                    No agent runs recorded yet
                  </div>
                </Panel>
              )}
            </div>

            {/* Agent distribution donut */}
            <div className="space-y-5">
              <Panel>
                <PanelHead
                  title="Agent distribution"
                  sub="Runs by agent type"
                  accent="var(--violet)"
                />
                <div className="flex flex-col items-center gap-4 p-5">
                  <DonutChart
                    segments={agentDonutSegs}
                    size={140}
                    thickness={20}
                    label={formatNumber(totalAgentRuns)}
                    sublabel="total runs"
                  />
                  {agentDonutSegs.length > 0 && (
                    <DonutLegend segments={agentDonutSegs} />
                  )}
                </div>
              </Panel>
            </div>
          </div>

          {/* Failed runs */}
          <Panel>
            <PanelHead
              title="Recent failures"
              sub="Latest failed pipeline runs"
              accent="var(--rose)"
            />
            {failedRuns.length ? (
              failedRuns.map((row) => (
                <FailedRunRow key={row.run_id} row={row} />
              ))
            ) : (
              <div
                className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40"
              >
                No failed runs recorded
              </div>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

export function OverviewPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center gap-3 py-20">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
          <span className="text-sm text-muted-foreground">Loading dashboard…</span>
        </div>
      }
    >
      <OverviewPageContent />
    </Suspense>
  );
}

