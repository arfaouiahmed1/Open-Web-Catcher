/* eslint-disable */
﻿"use client";

import Link from "next/link";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Bot, CircleDollarSign, Coins, Cpu, Globe2, LayoutGrid, Loader2 } from "lucide-react";

import { apiUrl } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { overviewFailureOnlySuccessRate } from "@/lib/overview-metrics";
import { estimateCallCost, loadPricing, synthCallsFromModelUsage } from "@/lib/pricing";
import { statusLabel } from "@/lib/run-status";
import { KpiCard } from "@/components/kpi-card";
import { DashboardPersistencePanel } from "@/components/dashboard";
import { RuntimeEventsPanel } from "@/components/runtime-events-panel";
import { OverviewKpisTab } from "./tabs/overview-kpis-tab";
import { CostsTab } from "./tabs/costs-tab";
import { TokensTab } from "./tabs/tokens-tab";
import { DashboardIntro } from "./dashboard-intro";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";
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
  { id: "providers", label: "Providers", Icon: Globe2 },
  { id: "tools", label: "Tools", Icon: Cpu },
  { id: "agents", label: "Agents", Icon: Bot },
];

const EMPTY_OBJECT = {};
const EMPTY_ARRAY: any[] = [];
const EXTERNAL_BLOCKER_STATUSES = new Set([
  "page_inaccessible",
  "site_dead",
  "no_streams",
  "no_hosting_pages",
]);

const PALETTE = [
  "var(--signal)",
  "var(--violet)",
  "var(--mint)",
  "var(--sky)",
  "var(--rose)",
];

async function apiFetch(path: any, options = {}) {
  // @ts-expect-error -- strict migration
  const { timeoutMs = 10_000, ...fetchOptions } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(apiUrl(path), {
      ...fetchOptions,
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   CHART PRIMITIVES
═══════════════════════════════════════════════════════════════════════════ */

/** Smooth bezier area + line chart. `data` = array of numbers. */
function AreaLine({ data = [], color = "var(--signal)", height = 72 }: any) {
  const gid = useRef(`al${Math.random().toString(36).slice(2)}`).current;
  if (!data || data.length < 2) return <div style={{ height }} />;
  const W = 480,
    H = height,
    pd = { t: 6, b: 6, l: 2, r: 2 };
  const vals = data.map((v: any) => Number(v) || 0);
  const mx = Math.max(...vals, 0.001);
  const mn = 0;
  const rng = mx - mn || 1;
  const cw = W - pd.l - pd.r;
  const ch = H - pd.t - pd.b;
  const pts = vals.map((v: any, i: any) => [
    pd.l + (i / (vals.length - 1)) * cw,
    pd.t + ch - ((v - mn) / rng) * ch,
  ]);
  const line = pts.reduce((acc: any, [x, y]: any, i: any) => {
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
}: any) {
  const vals = rawValues
    ? rawValues
    : data.map((d: any) => Number(d[valueKey] || 0));
  if (!vals || vals.length < 2) return <div style={{ height }} />;
  const mx = Math.max(...vals, 0.001);
  return (
    <div className="flex items-end gap-[2px]" style={{ height }} aria-hidden>
      {vals.map((v: any, i: any) => (
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
}: any) {
  const r = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const positiveSegments = segments.filter((seg: any) => Number(seg.value || 0) > 0);
  const total = positiveSegments.reduce((s: any, g: any) => s + Math.max(0, Number(g.value || 0)), 0);
  const gap = positiveSegments.length > 1 ? Math.min(4, circ * 0.012) : 0;

  let dashOffset = circ * 0.25; // start at top
  const arcs = positiveSegments.map((seg: any) => {
    const pct = Math.max(0, Number(seg.value || 0)) / (total || 1);
    const dash = Math.max(0, pct * circ - gap);
    const arc = { ...seg, dash, gap: circ - dash, offset: -dashOffset };
    dashOffset -= pct * circ;
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
        {arcs.map((arc: any, i: any) => (
          <circle
            key={`${arc.label}-${i}`}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={arc.color}
            strokeWidth={thickness}
            strokeDasharray={`${arc.dash} ${circ - arc.dash}`}
            strokeDashoffset={arc.offset}
            strokeLinecap={positiveSegments.length > 1 ? "round" : "butt"}
          />
        ))}
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
}: any) {
  const sw = 10;
  const r = (size - sw) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const pct = Math.min(1, Math.max(0, value / (max || 1)));
  const toR = (deg: any) => (deg * Math.PI) / 180;
  const arc = (cx: any, cy: any, r: any, a1: any, a2: any) => {
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

function formatCompactNumber(value: any) {
  const n = Number(value || 0);
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}b`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

function contextUsage(row = {}) {
  // @ts-expect-error -- strict migration
  const contextWindow = Number(row.context_window || 0);
  // @ts-expect-error -- strict migration
  const contextTokens = Number(row.context_tokens || 0);
  const contextPct =
    // @ts-expect-error -- strict migration
    Number(row.context_usage_pct || 0) ||
    (contextWindow > 0 ? contextTokens / contextWindow : 0);
  return { contextWindow, contextTokens, contextPct };
}

function contextUsageLabel(row = {}) {
  const { contextWindow, contextTokens, contextPct } = contextUsage(row);
  if (contextWindow <= 0) return "not tracked";
  return `${formatPercent(contextPct)} / ${formatNumber(contextTokens)} of ${formatCompactNumber(contextWindow)}`;
}

function chartMax(data = [], series = []) {
  let max = 0;
  for (const row of data) {
    const stacks = {};
    for (const item of series) {
      // @ts-expect-error -- strict migration
      const value = Number(row?.[item.key] || 0);
      max = Math.max(max, value);
      // @ts-expect-error -- strict migration
      if (item.stackId) stacks[item.stackId] = (stacks[item.stackId] || 0) + value;
    }
    for (const value of Object.values(stacks)) max = Math.max(max, Number(value || 0));
  }
  return max;
}

function AreaTrendCard({ title, description, data = [], series = [], height = 220 }: any) {
  const config = Object.fromEntries(
    series.map((item: any) => [item.key, { label: item.label, color: item.color }]),
  );
  const maxValue = chartMax(data, series);

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-5">
        <ChartContainer config={config} className="w-full" style={{ height }}>
          <AreaChart data={data} margin={{ top: 6, right: 16, left: 8, bottom: 0 }}>
            <defs>
              {series.map((item: any) => (
                <linearGradient key={item.key} id={`fill-${item.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={`var(--color-${item.key})`} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={`var(--color-${item.key})`} stopOpacity={0.04} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={formatCompactNumber}
              domain={[0, maxValue <= 1 ? 1 : "dataMax"]}
              allowDecimals={maxValue <= 10}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <ChartLegend content={<ChartLegendContent />} />
            {series.map((item: any) => (
              <Area
                key={item.key}
                dataKey={item.key}
                type="monotone"
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

function BarTrendCard({ title, description, data = [], series = [], height = 220 }: any) {
  const config = Object.fromEntries(
    series.map((item: any) => [item.key, { label: item.label, color: item.color }]),
  );
  const maxValue = chartMax(data, series);

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="p-5">
        <ChartContainer config={config} className="w-full" style={{ height }}>
          <BarChart data={data} margin={{ top: 6, right: 16, left: 8, bottom: 0 }}>
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={formatCompactNumber}
              domain={[0, maxValue <= 1 ? 1 : "dataMax"]}
              allowDecimals={maxValue <= 10}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
            <ChartLegend content={<ChartLegendContent />} />
            {series.map((item: any) => (
              <Bar
                key={item.key}
                dataKey={item.key}
                fill={`var(--color-${item.key})`}
                radius={[4, 4, 0, 0]}
                stackId={item.stackId}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

function MiniPieChart({ data = [], size = 180 }: any) {
  const positive = data.filter((entry: any) => Number(entry.value || 0) > 0);
  if (!positive.length) {
    return (
      <div className="flex h-44 items-center justify-center text-[12px] text-muted-foreground/50">
        No distribution data
      </div>
    );
  }
  return (
    <PieChart width={size} height={size}>
      <Pie
        data={positive}
        dataKey="value"
        nameKey="label"
        cx="50%"
        cy="50%"
        innerRadius={Math.round(size * 0.28)}
        outerRadius={Math.round(size * 0.43)}
        paddingAngle={3}
      >
        {positive.map((entry: any, index: any) => (
          <Cell key={`${entry.label}-${index}`} fill={entry.color} />
        ))}
      </Pie>
    </PieChart>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   LAYOUT PRIMITIVES
═══════════════════════════════════════════════════════════════════════════ */

function Panel({ children, className = "" }: any) {
  return (
    <Card className={`overflow-hidden ${className}`}>
      {children}
    </Card>
  );
}

function PanelHead({ title, sub, aside, accent = "var(--signal)" }: any) {
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
function TabBar({ active, onChange, agentPolling }: any) {
  return (
    <Tabs value={active} onValueChange={onChange}>
      <TabsList className="h-auto w-full justify-start gap-1 p-1">
        {TABS.map(({ id, label, Icon }: any) => (
          <TabsTrigger
            key={id}
            value={id}
            className="flex-1 gap-1.5 text-[12px]"
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">{label}</span>
            {id === "agents" && agentPolling && (
              <span
                className="relative ml-0.5 flex h-[6px] w-[6px] shrink-0"
                title="Auto-refreshing"
              >
                <span
                  className="absolute inset-0 rounded-full opacity-60"
                  style={{ background: "var(--signal)", animation: "ping 1.6s ease-in-out infinite" }}
                />
                <span className="relative h-[6px] w-[6px] rounded-full" style={{ background: "var(--signal)" }} />
              </span>
            )}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/** Legend row for a donut chart. */
function DonutLegend({ segments }: any) {
  return (
    <div className="space-y-1.5">
      {segments.map((seg: any) => (
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
function HBarRow({ label, value, share, color, sub, rank }: any) {
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
function SectionLabel({ children }: any) {
  return (
    <p className="text-[9.5px] font-semibold uppercase tracking-[0.16em] mb-3 text-muted-foreground/60">
      {children}
    </p>
  );
}

/** System live-status pills strip. */
function StatusStrip({ summary }: any) {
  const workingWebsites = Number(summary.distinct_working_websites || 0);
  const noStreamOrHostingRuns = Number(summary.no_stream_or_hosting_runs || 0);
  const items = [
    {
      label: "Working sites",
      value: workingWebsites,
      color: workingWebsites > 0 ? "var(--mint)" : "var(--mute-3)",
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
      label: "No stream/host",
      value: noStreamOrHostingRuns,
      color: noStreamOrHostingRuns > 0 ? "var(--signal)" : "var(--mute-3)",
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
      {items.map(({ label, value, color, live }: any) => (
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

function ActiveRunRow({ run }: any) {
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

function FailedRunRow({ row }: any) {
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

function ToolReliabilityRow({ row }: any) {
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

function urlHost(value: any) {
  try {
    return new URL(String(value || "")).hostname;
  } catch {
    return String(value || "").replace(/^https?:\/\//, "").split("/")[0] || "-";
  }
}

function ProviderWorkflowRow({ row }: any) {
  const url = row.url || row.stream_url || "";
  return (
    <TableRow>
      <TableCell className="max-w-[260px] px-4 py-2.5">
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-mono text-[11px] text-primary hover:underline"
            title={url}
          >
            {url.replace(/^https?:\/\//, "")}
          </a>
        ) : (
          <span className="font-mono text-[11px] text-muted-foreground/50">-</span>
        )}
      </TableCell>
      <TableCell className="px-4 py-2.5 text-[12px] text-foreground/80">
        {row.provider || row.org || "unresolved"}
      </TableCell>
      <TableCell className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">
        {row.hostname || urlHost(url)}
      </TableCell>
      <TableCell className="px-4 py-2.5 text-[12px] text-muted-foreground">
        {row.country || "-"}
      </TableCell>
      <TableCell className="px-4 py-2.5 font-mono text-[11px] text-primary">
        {row.abuse_email || "-"}
      </TableCell>
      <TableCell className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground/60">
        {row.pipeline_run_id ? `#${row.pipeline_run_id}` : "-"}
      </TableCell>
    </TableRow>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   MAIN PAGE
═══════════════════════════════════════════════════════════════════════════ */

// (AGENT_POLL_MS removed — plan task 42: agents tab refreshes on entry and
    // tab focus, not on a timer.)

function OverviewPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = searchParams.get("tab") || "overview";

  const [overview, setOverview] = useState<any>(null);
  const [toolRel, setToolRel] = useState<any>(null);
  const [agentRunsDb, setAgentRunsDb] = useState<any>(null);
  const [providerAnalysisDb, setProviderAnalysisDb] = useState<any>(null);
  const [runStreamsDb, setRunStreamsDb] = useState<any>(null);
  const [pricingMap, setPricingMap] = useState<any>(null);
  const [failedData, setFailedData] = useState<any>(null);
  const [runtimeEvents, setRuntimeEvents] = useState([]);
  const [dbTables, setDbTables] = useState([]);
  const [error, setError] = useState("");
  const [agentPolling, setAgentPolling] = useState(false);

  useEffect(() => {
    let mounted = true;
    Promise.allSettled([
      apiFetch("/ui/overview"),
      apiFetch("/ui/tools/reliability?limit=20"),
      apiFetch("/ui/database/agent_runs?limit=300"),
      apiFetch("/ui/database/provider_analyses?limit=300"),
      apiFetch("/ui/database/run_streams?limit=300"),
      apiFetch("/ui/runs?status=failed&limit=12&offset=0"),
      apiFetch("/ui/events/recent?limit=30"),
      apiFetch("/ui/database/tables"),
      loadPricing(),
    ])
      .then(
        ([
          overviewRes,
          toolRes,
          agentRes,
          providerRes,
          streamRes,
          failedRes,
          eventsRes,
          dbTablesRes,
          pricingRes,
        ]) => {
          if (!mounted) return;
          setOverview(
            overviewRes.status === "fulfilled" ? overviewRes.value : {},
          );
          setToolRel(toolRes.status === "fulfilled" ? toolRes.value : {});
          setAgentRunsDb(agentRes.status === "fulfilled" ? agentRes.value : {});
          setProviderAnalysisDb(
            providerRes.status === "fulfilled" ? providerRes.value : {},
          );
          setRunStreamsDb(
            streamRes.status === "fulfilled" ? streamRes.value : {},
          );
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
          setPricingMap(
            pricingRes.status === "fulfilled" ? pricingRes.value : new Map(),
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

  // Refresh agent data when on the agents tab.
    // Plan task 42 (de-polling): no setInterval. Data refreshes on tab entry
    // and on tab focus (visibilitychange) — the agents view tolerates slight
    // staleness between focus events.
    useEffect(() => {
      if (tab !== "agents") { setAgentPolling(false); return undefined; }
      setAgentPolling(true);
      let mounted = true;
      function refreshAgents() {
        Promise.allSettled([
          apiFetch("/ui/database/agent_runs?limit=300"),
          apiFetch("/ui/runs?status=failed&limit=12&offset=0"),
          apiFetch("/ui/overview"),
        ]).then(([agentRes, failedRes, overviewRes]) => {
          if (!mounted) return;
          if (agentRes.status === "fulfilled") setAgentRunsDb(agentRes.value);
          if (failedRes.status === "fulfilled") setFailedData(failedRes.value);
          if (overviewRes.status === "fulfilled") setOverview(overviewRes.value);
        });
      }
      function onVisibility() {
        if (document.visibilityState === "visible") {
          refreshAgents();
        }
      }
      refreshAgents();
      document.addEventListener("visibilitychange", onVisibility);
      return () => { mounted = false; document.removeEventListener("visibilitychange", onVisibility); setAgentPolling(false); };
    }, [tab]);

  function setTab(next: any) {
    const p = new URLSearchParams(searchParams.toString());
    p.set("tab", next);
    router.push(`${pathname}?${p.toString()}`, { scroll: false });
  }

  /* ── derived data ────────────────────────────────────────────────────── */
  const summary = overview?.summary ?? EMPTY_OBJECT;
  const dashboardSuccessRate = overviewFailureOnlySuccessRate(summary);
  const distinctWorkingWebsites = Number(summary.distinct_working_websites || 0);
  const noStreamOrHostingRuns = Number(summary.no_stream_or_hosting_runs || 0);
  const rawTrend = overview?.trend ?? EMPTY_ARRAY;
  const rawModelRows = overview?.model_breakdown ?? EMPTY_ARRAY;
  const overviewProviderRows = overview?.provider_breakdown ?? EMPTY_ARRAY;
  const providerAnalysisRows = providerAnalysisDb?.rows ?? EMPTY_ARRAY;
  const workflowStreamRows = runStreamsDb?.rows ?? EMPTY_ARRAY;
  const toolRows = toolRel?.rows ?? overview?.top_tools ?? EMPTY_ARRAY;
  const activeRuns = (overview?.active_runs ?? EMPTY_ARRAY).filter(
    (r: any) => !r.completed,
  );
  const recentRuns = overview?.recent_runs ?? EMPTY_ARRAY;
  const failedRuns = failedData?.rows ?? EMPTY_ARRAY;
  const blockerRuns = recentRuns
    .filter((row: any) => EXTERNAL_BLOCKER_STATUSES.has(String(row.final_status || row.status || "").toLowerCase()))
    .slice(0, 8);

  const modelRows = useMemo(() => {
    const syntheticCalls = synthCallsFromModelUsage(rawModelRows);
    const byKey = new Map(
      syntheticCalls.map((call) => [
        `${call.provider || ""}::${call.model_name || ""}`,
        call,
      ]),
    );
    return rawModelRows
      .map((row: any) => {
        const key = `${row.provider || ""}::${row.model_name || ""}`;
        const estimated = estimateCallCost(byKey.get(key) || row, pricingMap);
        const loggedTotal = Number(
          row.cost_usd ?? row.estimated_total_cost_usd ?? row.total_cost_usd ?? 0,
        );
        const useEstimate = loggedTotal <= 0 && Number(estimated.total || 0) > 0;
        const totalCost = useEstimate ? Number(estimated.total || 0) : loggedTotal;
        return {
          ...row,
          calls: Number(row.calls || row.llm_calls || 0),
          tokens:
            Number(row.tokens || 0) ||
            Number(row.input_tokens || 0) + Number(row.output_tokens || 0),
          cost_usd: totalCost,
          estimated_input_cost_usd: useEstimate
            ? Number(estimated.input || 0)
            : Number(row.estimated_input_cost_usd || 0),
          estimated_cached_input_cost_usd: useEstimate
            ? Number(estimated.cached || 0)
            : Number(row.estimated_cached_input_cost_usd || 0),
          estimated_cache_write_cost_usd: useEstimate
            ? Number(estimated.cacheWrite || 0)
            : Number(row.estimated_cache_write_cost_usd || 0),
          estimated_output_cost_usd: useEstimate
            ? Number(estimated.output || 0)
            : Number(row.estimated_output_cost_usd || 0),
          cost_source: useEstimate
            ? estimated.source
            : row.cost_source || (loggedTotal > 0 ? "recorded" : estimated.source),
          pricing_available: Boolean(estimated.pricing),
        };
      })
      .sort((a: any, b: any) => {
        const costDelta = Number(b.cost_usd || 0) - Number(a.cost_usd || 0);
        if (Math.abs(costDelta) > 0.000001) return costDelta;
        const tokenDelta = Number(b.tokens || 0) - Number(a.tokens || 0);
        if (tokenDelta) return tokenDelta;
        return String(a.label || a.model_name || "").localeCompare(
          String(b.label || b.model_name || ""),
        );
      });
  }, [rawModelRows, pricingMap]);

  const computedModelCost = modelRows.reduce((s: any, r: any) => s + Number(r.cost_usd || 0), 0);
  const recordedTotalCost = Number(summary.total_cost_usd || 0);
  const effectiveTotalCost = recordedTotalCost > 0 ? recordedTotalCost : computedModelCost;
  const effectiveAvgCost =
    summary.terminal_runs || summary.total_runs
      ? effectiveTotalCost / Number(summary.terminal_runs || summary.total_runs || 1)
      : 0;
  const costSourceLabel =
    recordedTotalCost > 0
      ? "Recorded model spend"
      : computedModelCost > 0
        ? "Token-priced estimate"
        : "No pricing configured";

  const trend = useMemo(() => {
    const totalTrendCost = rawTrend.reduce((s: any, r: any) => s + Number(r.cost_usd || 0), 0);
    if (totalTrendCost > 0 || effectiveTotalCost <= 0) return rawTrend;
    const totalTrendTokens = rawTrend.reduce((s: any, r: any) => s + Number(r.tokens || 0), 0);
    if (totalTrendTokens <= 0) return rawTrend;
    return rawTrend.map((row: any) => ({
      ...row,
      cost_usd: (effectiveTotalCost * Number(row.tokens || 0)) / totalTrendTokens,
    }));
  }, [rawTrend, effectiveTotalCost]);

  const tokenRows = useMemo(
    () =>
      modelRows.map((row: any) => {
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

  const totalModelCost = computedModelCost || modelRows.reduce((s: any, r: any) => s + Number(r.tokens || 0), 0) || 1;
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
        modelRows.reduce((acc: any, row: any) => {
          const k = String(row.provider || "unknown");
          if (!acc[k])
            acc[k] = {
              provider: k,
              cost_usd: 0,
              input_cost_usd: 0,
              cached_cost_usd: 0,
              output_cost_usd: 0,
              calls: 0,
              tokens: 0,
            };
          acc[k].cost_usd += Number(row.cost_usd || 0);
          acc[k].input_cost_usd += Number(row.estimated_input_cost_usd || 0);
          acc[k].cached_cost_usd += Number(row.estimated_cached_input_cost_usd || 0);
          acc[k].output_cost_usd += Number(row.estimated_output_cost_usd || 0);
          acc[k].calls += Number(row.calls || 0);
          acc[k].tokens += Number(row.tokens || 0);
          return acc;
        }, {}),
      ).sort((a, b) => {
        // @ts-expect-error -- strict migration
        const costDelta = b.cost_usd - a.cost_usd;
        if (Math.abs(costDelta) > 0.000001) return costDelta;
        // @ts-expect-error -- strict migration
        return b.tokens - a.tokens;
      }),
    [modelRows],
  );

  // @ts-expect-error -- strict migration
  const totalProviderCost = providerCostRows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  // @ts-expect-error -- strict migration
  const totalProviderTokens = providerCostRows.reduce((s, r) => s + Number(r.tokens || 0), 0);
  // @ts-expect-error -- strict migration
  const providerDistributionMode = totalProviderCost > 0 ? "cost" : "tokens";
  const providerDistributionTotal =
    providerDistributionMode === "cost" ? totalProviderCost || 1 : totalProviderTokens || 1;

  const agentRows = agentRunsDb?.rows ?? EMPTY_ARRAY;
  const agentSummary = useMemo(() => {
    const rows = agentRows;
    const grouped = new Map();
    for (const row of rows) {
      const actor = row.actor || row.agent_type || "unknown";
      const status = String(row.status || "unknown").trim().toLowerCase() || "unknown";
      const { contextWindow, contextTokens, contextPct } = contextUsage(row);
      if (!grouped.has(actor))
        grouped.set(actor, {
          actor,
          total: 0,
          statusCounts: {},
          latestStatus: status,
          toolCalls: 0,
          llmCalls: 0,
          duration: 0,
          contextWindow: 0,
          contextTokens: 0,
          peakContextPct: 0,
          trackedContextRuns: 0,
        });
      const e = grouped.get(actor);
      e.total++;
      e.statusCounts[status] = (e.statusCounts[status] || 0) + 1;
      e.latestStatus = status;
      e.toolCalls += Number(row.tool_calls_made || 0);
      e.llmCalls += Number(row.llm_calls_made || 0);
      e.duration += Number(row.duration_seconds || 0);
      if (contextWindow > 0) {
        e.trackedContextRuns++;
        e.contextWindow = Math.max(e.contextWindow, contextWindow);
        e.contextTokens = Math.max(e.contextTokens, contextTokens);
        e.peakContextPct = Math.max(e.peakContextPct, contextPct);
      }
    }
    return Array.from(grouped.values())
      .map((r) => ({ ...r, avgDuration: r.total ? r.duration / r.total : 0 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 6);
  }, [agentRows]);

  const totalAgentRuns = agentSummary.reduce((s, r) => s + r.total, 0);
  const trackedAgentContextRuns = agentRows.filter((row: any) => contextUsage(row).contextWindow > 0).length;

  const agentStatusRows = useMemo(() => {
    const grouped = new Map();
    for (const row of agentRows) {
      const status = String(row.status || "unknown").trim().toLowerCase() || "unknown";
      grouped.set(status, (grouped.get(status) || 0) + 1);
    }
    return Array.from(grouped.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
  }, [agentRows]);

  const recentAgentRows = useMemo(
    () =>
      [...agentRows]
        .sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")))
        .slice(0, 12),
    [agentRows],
  );

  const workflowProviderStats = useMemo(() => {
    const providerMap = new Map();
    const countryMap = new Map();
    const runIds = new Set();
    const analysedUrls = new Set();
    let abuseContacts = 0;

    for (const row of providerAnalysisRows) {
      const provider = String(row.provider || "unknown").trim() || "unknown";
      const country = String(row.country || "").trim();
      const streamUrl = String(row.stream_url || "").trim();
      const pipelineRunId = row.pipeline_run_id != null ? String(row.pipeline_run_id) : "";
      if (pipelineRunId) runIds.add(pipelineRunId);
      if (streamUrl) analysedUrls.add(streamUrl);
      if (row.abuse_email) abuseContacts += 1;
      if (!providerMap.has(provider)) {
        providerMap.set(provider, {
          provider,
          count: 0,
          affectedRuns: new Set(),
          abuseContacts: 0,
          countries: new Set(),
        });
      }
      const providerEntry = providerMap.get(provider);
      providerEntry.count += 1;
      if (pipelineRunId) providerEntry.affectedRuns.add(pipelineRunId);
      if (row.abuse_email) providerEntry.abuseContacts += 1;
      if (country) providerEntry.countries.add(country);

      if (country) {
        const entry = countryMap.get(country) || { country, count: 0 };
        entry.count += 1;
        countryMap.set(country, entry);
      }
    }

    if (!providerAnalysisRows.length) {
      for (const row of overviewProviderRows) {
        const provider = String(row.provider || "unknown").trim() || "unknown";
        providerMap.set(provider, {
          provider,
          count: Number(row.analysis_count || 0),
          affectedRuns: Number(row.affected_runs || 0),
          abuseContacts: 0,
          countries: 0,
        });
      }
    }

    const providerRows = Array.from(providerMap.values())
      .map((row) => ({
        ...row,
        affectedRuns:
          row.affectedRuns instanceof Set ? row.affectedRuns.size : Number(row.affectedRuns || 0),
        countries: row.countries instanceof Set ? row.countries.size : Number(row.countries || 0),
      }))
      .sort((a, b) => b.count - a.count || a.provider.localeCompare(b.provider));
    const countryRows = Array.from(countryMap.values()).sort(
      (a, b) => b.count - a.count || a.country.localeCompare(b.country),
    );

    return {
      providerRows,
      countryRows,
      analysedLinks:
        analysedUrls.size
        || providerAnalysisRows.length
        || overviewProviderRows.reduce((total: any, row: any) => total + Number(row.analysis_count || 0), 0),
      streamLinks: workflowStreamRows.length,
      affectedRuns:
        runIds.size
        || overviewProviderRows.reduce((total: any, row: any) => total + Number(row.affected_runs || 0), 0),
      abuseContacts,
    };
  }, [overviewProviderRows, providerAnalysisRows, workflowStreamRows]);

  const workflowProviderLinkRows = useMemo(() => {
    if (providerAnalysisRows.length) {
      return providerAnalysisRows.slice(0, 60).map((row: any) => ({
        ...row,
        url: row.stream_url || "",
        source: "provider_analysis",
      }));
    }
    return workflowStreamRows.slice(0, 60).map((row: any) => ({
      ...row,
      url: row.stream_url || "",
      provider: "",
      hostname: "",
      org: "",
      country: "",
      abuse_email: "",
      created_at: row.captured_at || row.created_at || "",
      source: "run_stream",
    }));
  }, [providerAnalysisRows, workflowStreamRows]);

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
  const llmProviderBlockedRuns = Number(summary.llm_provider_blocked_runs || 0);
  const llmRateLimitedRuns = Number(summary.llm_rate_limited_runs || 0);
  const llmApiDownRuns = Number(summary.llm_api_down_runs || 0);
  const llmProviderStatus =
    llmRateLimitedRuns > 0
      ? "Rate limited"
      : llmApiDownRuns > 0
        ? "API down"
        : "OK";
  const overviewKpisRow1 = [
    {
      label: "Total runs",
      value: formatNumber(summary.total_runs || 0),
      description: "Persisted orchestrator runs",
      sparkData: trend.map((r: any) => r.runs || 0),
    },
    {
      label: "Success rate",
      value: formatPercent(dashboardSuccessRate),
      description: "Only failed runs lower this",
      bar: dashboardSuccessRate * 100,
      accent: "mint",
    },
    {
      label: "Avg latency",
      value: `${Number(summary.avg_latency_seconds || 0).toFixed(1)}s`,
      description: "End-to-end wall-clock",
      sparkData: trend.map((r: any) => r.avg_latency_seconds || 0),
    },
    {
      label: "Total cost",
      value: formatCurrency(effectiveTotalCost),
      description: costSourceLabel,
      sparkData: trend.map((r: any) => r.cost_usd || 0),
      accent: "signal",
    },
  ];
  const overviewKpisRow2 = [
    {
      label: "Total tokens",
      value: formatNumber(summary.total_tokens || 0),
      description: "Input + output tokens",
      sparkData: trend.map((r: any) => r.tokens || 0),
      accent: "sky",
    },
    {
      label: "Working websites",
      value: formatNumber(distinctWorkingWebsites),
      description: "Distinct success/partial sites",
      accent: distinctWorkingWebsites > 0 ? "mint" : undefined,
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
      label: "LLM API",
      value: llmProviderStatus,
      description: llmProviderBlockedRuns
        ? `${formatNumber(llmProviderBlockedRuns)} rate/down runs excluded`
        : "No rate-limit or outage blockers",
      accent: llmProviderBlockedRuns ? "signal" : "mint",
    },
    {
      label: "No streams/hosting",
      value: formatNumber(noStreamOrHostingRuns),
      description: "Runs with no streams or hosting pages",
      accent: noStreamOrHostingRuns > 0 ? "signal" : undefined,
    },
  ];

  /* ── Costs KPI set ───────────────────────────────────────────────────── */
  const costsKpis = [
    {
      label: "Total cost",
      value: formatCurrency(effectiveTotalCost),
      description: costSourceLabel,
      sparkData: trend.map((r: any) => r.cost_usd || 0),
      accent: "signal",
    },
    {
      label: "Avg cost / run",
      value: formatCurrency(effectiveAvgCost),
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
            effectiveTotalCost / (summary.total_tokens / 1000),
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
      sparkData: trend.map((r: any) => r.tokens || 0),
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
      label: "Tracked context",
      value: formatNumber(trackedAgentContextRuns || summary.context_tracked_agent_runs || 0),
      description: "Agent rows with context window",
      accent: "mint",
    },
    {
      label: "Tool calls",
      value: formatNumber(agentSummary.reduce((s, r) => s + r.toolCalls, 0)),
      description: "Total across agents",
      accent: "sky",
    },
  ];

  const providerKpis = [
    {
      label: "Workflow links",
      value: formatNumber(workflowProviderStats.streamLinks || workflowProviderStats.analysedLinks),
      description: "Stream links captured by runs",
      accent: "sky",
    },
    {
      label: "Analysed links",
      value: formatNumber(workflowProviderStats.analysedLinks),
      description: "Links resolved to provider intel",
      accent: "signal",
    },
    {
      label: "Providers",
      value: formatNumber(workflowProviderStats.providerRows.length || summary.unique_providers || 0),
      description: "Distinct hosting/CDN names",
      accent: "violet",
    },
    {
      label: "Affected runs",
      value: formatNumber(workflowProviderStats.affectedRuns),
      description: "Runs with provider rows",
      accent: "mint",
    },
    {
      label: "Abuse contacts",
      value: formatNumber(workflowProviderStats.abuseContacts),
      description: "Resolved abuse inboxes",
      accent: "rose",
    },
    {
      label: "Coverage",
      value: formatPercent(
        workflowProviderStats.streamLinks
          ? workflowProviderStats.analysedLinks / workflowProviderStats.streamLinks
          : 0,
      ),
      description: "Analysed links / captured links",
      bar: workflowProviderStats.streamLinks
        ? (workflowProviderStats.analysedLinks / workflowProviderStats.streamLinks) * 100
        : 0,
      accent: "mint",
    },
  ];

  /* ── donut segment builders ──────────────────────────────────────────── */
  const providerDonutSegs = providerCostRows.slice(0, 5).map((row, i) => ({
    // @ts-expect-error -- strict migration
    label: row.provider,
    value:
      providerDistributionMode === "cost"
        // @ts-expect-error -- strict migration
        ? Number(row.cost_usd || 0)
        // @ts-expect-error -- strict migration
        : Number(row.tokens || 0),
    color: PALETTE[i % PALETTE.length],
    pct:
      (providerDistributionMode === "cost"
        // @ts-expect-error -- strict migration
        ? Number(row.cost_usd || 0)
        // @ts-expect-error -- strict migration
        : Number(row.tokens || 0)) / providerDistributionTotal,
    formatted:
      providerDistributionMode === "cost"
        // @ts-expect-error -- strict migration
        ? formatCurrency(row.cost_usd || 0)
        // @ts-expect-error -- strict migration
        : `${formatNumber(row.tokens || 0)} tok`,
  }));

  const costComponentTotals = modelRows.reduce(
    (acc: any, row: any) => {
      acc.input += Number(row.estimated_input_cost_usd || 0);
      acc.cached += Number(row.estimated_cached_input_cost_usd || 0);
      acc.cacheWrite += Number(row.estimated_cache_write_cost_usd || 0);
      acc.output += Number(row.estimated_output_cost_usd || 0);
      return acc;
    },
    { input: 0, cached: 0, cacheWrite: 0, output: 0 },
  );
  const costComponentTotal =
    costComponentTotals.input +
    costComponentTotals.cached +
    costComponentTotals.cacheWrite +
    costComponentTotals.output;
  const costComponentSegs = [
    {
      label: "Input",
      value: costComponentTotals.input,
      color: "var(--signal)",
      formatted: formatCurrency(costComponentTotals.input),
    },
    {
      label: "Cached",
      value: costComponentTotals.cached,
      color: "var(--violet)",
      formatted: formatCurrency(costComponentTotals.cached),
    },
    {
      label: "Cache write",
      value: costComponentTotals.cacheWrite,
      color: "var(--sky)",
      formatted: formatCurrency(costComponentTotals.cacheWrite),
    },
    {
      label: "Output",
      value: costComponentTotals.output,
      color: "var(--mint)",
      formatted: formatCurrency(costComponentTotals.output),
    },
  ].filter((item) => item.value > 0);

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

  const agentStatusSegs = agentStatusRows.map((row, i) => ({
    label: row.status,
    value: row.count,
    color:
      row.status === "success" || row.status === "succeeded"
        ? "var(--mint)"
        : row.status === "failed"
          ? "var(--rose)"
          : PALETTE[i % PALETTE.length],
    pct: row.count / (agentRows.length || 1),
    formatted: formatNumber(row.count),
  }));

  const workflowProviderSegs = workflowProviderStats.providerRows.slice(0, 6).map((row, i) => ({
    label: row.provider,
    value: row.count,
    color: PALETTE[i % PALETTE.length],
    pct: row.count / (workflowProviderStats.analysedLinks || 1),
    formatted: `${formatNumber(row.count)} links`,
  }));

  const workflowCountryPieData = workflowProviderStats.countryRows.slice(0, 7).map((row, i) => ({
    label: row.country || "unknown",
    value: row.count,
    color: PALETTE[i % PALETTE.length],
  }));

  /* ── render ──────────────────────────────────────────────────────────── */
  return (
    <div className="space-y-6">
      <DashboardIntro />
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

      <TabBar active={tab} onChange={setTab} agentPolling={agentPolling} />

      {/* ════════════════════════════════════════════════════════════════════
          OVERVIEW TAB
      ════════════════════════════════════════════════════════════════════ */}
      {tab === "overview" && (
        <div className="space-y-6">
          <OverviewKpisTab overview={overview} state={overview ? "success" : error ? "error" : "loading"} />

          {/* Live status strip */}
          <StatusStrip summary={summary} />

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
                // @ts-expect-error -- strict migration
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
                    fmt: (v: any) => `${Number(v || 0).toFixed(1)}s`,
                  },
                ].map(({ key, label, color, fmt }: any) => {
                  const vals = trend.map((r: any) => Number(r[key] || 0));
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
              data={trend.map((r: any) => ({
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

          {trend.length > 2 && (
            <BarTrendCard
              title="Run outcome mix"
              description="Stacked daily successes, partial/running runs, agent failures, and site/server blockers."
              data={trend.map((r: any) => ({
                date: r.date || "",
                successes: Number(r.successes || 0),
                partials: Number(r.partials || 0),
                agent_failures: Number(r.agent_failures || 0),
                external_blockers: Number(r.external_blockers || 0),
              }))}
              series={[
                { key: "successes", label: "Success", color: "var(--chart-1)", stackId: "status" },
                { key: "partials", label: "Partial", color: "var(--chart-2)", stackId: "status" },
                { key: "agent_failures", label: "Agent fail", color: "var(--chart-5)", stackId: "status" },
                { key: "external_blockers", label: "Site/server", color: "var(--chart-4)", stackId: "status" },
              ]}
              height={210}
            />
          )}

          {/* Live + recent runs */}
          <div className="grid gap-5 xl:grid-cols-[340px_1fr]">
            <Panel>
              <PanelHead
                title="Live traces"
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
                  .map((row: any) => <ActiveRunRow key={row.run_id} run={row} />)
              ) : (
                <div className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40">
                  No live traces
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
                    recentRuns.slice(0, 8).map((row: any) => (
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
          <CostsTab overview={overview} state={overview ? "success" : error ? "error" : "loading"} />

          <div className="grid gap-5 xl:grid-cols-2">
            {/* Provider cost donut */}
            <Panel>
              <PanelHead
                title="Cost by provider"
                sub="Aggregated from model usage rows; falls back to token share when pricing is absent"
                accent="var(--signal)"
              />
              <div className="flex items-center gap-6 p-5">
                <DonutChart
                  segments={providerDonutSegs}
                  size={148}
                  thickness={22}
                  label={
                    providerDistributionMode === "cost"
                      ? formatCurrency(effectiveTotalCost)
                      : formatNumber(totalProviderTokens)
                  }
                  sublabel={providerDistributionMode === "cost" ? "total" : "tokens"}
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
                sub="Top models by recorded or token-priced spend"
                accent="var(--violet)"
              />
              {modelRows.length ? (
                modelRows
                  .slice(0, 8)
                  .map((row: any, i: any) => {
                    const shareValue = computedModelCost > 0 ? Number(row.cost_usd || 0) : Number(row.tokens || 0);
                    return (
                      <HBarRow
                        key={`${row.provider}-${row.model_name}-${i}`}
                        rank={i + 1}
                        label={row.label || `${row.provider}::${row.model_name}`}
                        value={formatCurrency(row.cost_usd || 0)}
                        share={(shareValue / totalModelCost) * 100}
                        color={PALETTE[i % PALETTE.length]}
                        sub={`${formatNumber(row.calls || 0)} calls · ${formatNumber(row.tokens || 0)} tok · ${row.cost_source || "unpriced"}`}
                      />
                    );
                  })
              ) : (
                <div
                  className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40"
                >
                  No model cost data
                </div>
              )}
            </Panel>
          </div>

          <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
            <Panel>
              <PanelHead
                title="Cost component mix"
                sub="Input, cached input, cache writes, and output"
                accent="var(--mint)"
              />
              <div className="flex flex-col items-center gap-4 p-5">
                <DonutChart
                  segments={costComponentSegs}
                  size={140}
                  thickness={20}
                  label={formatCurrency(costComponentTotal || effectiveTotalCost)}
                  sublabel="priced"
                />
                {costComponentSegs.length ? (
                  <DonutLegend segments={costComponentSegs} />
                ) : (
                  <div className="text-center text-[12px] text-muted-foreground/50">
                    Configure pricing to split spend by token type.
                  </div>
                )}
              </div>
            </Panel>

            <Panel>
              <PanelHead
                title="Model pricing details"
                sub="Token-derived cost components per model"
                accent="var(--sky)"
              />
              <div className="overflow-x-auto">
                <Table className="min-w-full text-[12px]">
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      {["Model", "Input", "Cached", "Output", "Total", "Source"].map((h) => (
                        <TableHead key={h} className="px-4 py-2.5 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                          {h}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {modelRows.slice(0, 8).map((row: any) => (
                      <TableRow key={`${row.provider}-${row.model_name}-pricing`}>
                        <TableCell className="max-w-[260px] truncate px-4 py-2.5 font-mono text-[11px]" title={row.label || `${row.provider}::${row.model_name}`}>
                          {row.label || `${row.provider}::${row.model_name}`}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px]">{formatCurrency(row.estimated_input_cost_usd || 0)}</TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px]">{formatCurrency(row.estimated_cached_input_cost_usd || 0)}</TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px]">{formatCurrency(row.estimated_output_cost_usd || 0)}</TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px] text-foreground">{formatCurrency(row.cost_usd || 0)}</TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[10px] text-muted-foreground">{row.cost_source || "unpriced"}</TableCell>
                      </TableRow>
                    ))}
                    {!modelRows.length && (
                      <TableRow className="hover:bg-transparent">
                        <TableCell colSpan={6} className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40">
                          No model usage rows recorded yet
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </Panel>
          </div>

          {trend.length > 2 && (
            <AreaTrendCard
              title="Cost trend"
              description="Daily cost over the last 7 periods."
              data={trend.map((r: any) => ({
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
                    {formatCurrency(effectiveTotalCost)} total
                  </div>
                </div>
                <AreaLine
                  data={trend.map((r: any) => Number(r.cost_usd || 0))}
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
              data={trend.map((r: any) => ({
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
          <TokensTab overview={overview} state={overview ? "success" : error ? "error" : "loading"} />

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
                tokenRows.map((row: any) => {
                  const total = Math.max(row.newIn + row.cachedIn + row.out, 1);
                  const maxTotal = Math.max(
                    ...tokenRows.map((r: any) => r.newIn + r.cachedIn + r.out),
                    1,
                  );
                  const scaledWidth = Math.max((total / maxTotal) * 100, 2);
                  const nw = (row.newIn / total) * 100;
                  const cw = (row.cachedIn / total) * 100;
                  const ow = (row.out / total) * 100;
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
                      <div className="h-3.5 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
                        <div
                          className="flex h-full overflow-hidden rounded-full gap-[1px]"
                          style={{ width: `${scaledWidth}%` }}
                        >
                          {nw > 0 && (
                            <span style={{ flexBasis: `${nw}%`, background: "var(--signal)" }} />
                          )}
                          {cw > 0 && (
                            <span style={{ flexBasis: `${cw}%`, background: "var(--violet)" }} />
                          )}
                          {ow > 0 && (
                            <span style={{ flexBasis: `${ow}%`, background: "var(--mint)" }} />
                          )}
                        </div>
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
                    {formatCurrency(effectiveTotalCost)}
                  </span>
                </div>
              )}
            </Panel>
          </div>

          {trend.length > 2 && (
            <AreaTrendCard
              title="Token volume trend"
              description="Total tokens consumed per period."
              data={trend.map((r: any) => ({
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
          PROVIDERS TAB
      ════════════════════════════════════════════════════════════════════ */}
      {tab === "providers" && (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {providerKpis.map((kpi) => (
              <KpiCard key={kpi.label} {...kpi} />
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Panel>
              <PanelHead
                title="Provider distribution"
                sub="Hosting/CDN providers from workflow stream analysis"
                accent="var(--violet)"
              />
              <div className="flex items-center gap-6 p-5">
                <DonutChart
                  segments={workflowProviderSegs}
                  size={148}
                  thickness={22}
                  label={formatNumber(workflowProviderStats.analysedLinks)}
                  sublabel="links"
                />
                <div className="flex-1">
                  {workflowProviderSegs.length ? (
                    <DonutLegend segments={workflowProviderSegs} />
                  ) : (
                    <div className="text-[12px] text-muted-foreground/50">
                      No provider analysis rows recorded yet.
                    </div>
                  )}
                </div>
              </div>
            </Panel>

            <Panel>
              <PanelHead
                title="Provider geography"
                sub="Countries resolved from provider analysis"
                accent="var(--mint)"
              />
              <div className="flex items-center gap-6 p-5">
                <MiniPieChart data={workflowCountryPieData} size={176} />
                <div className="flex-1 space-y-2">
                  {workflowProviderStats.countryRows.slice(0, 7).map((row, i) => (
                    <div key={row.country || i} className="flex items-center gap-2 text-[11px]">
                      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} />
                      <span className="min-w-0 flex-1 truncate text-foreground/80">{row.country || "unknown"}</span>
                      <span className="font-mono text-[10.5px] text-muted-foreground">{formatNumber(row.count)}</span>
                    </div>
                  ))}
                  {!workflowProviderStats.countryRows.length && (
                    <div className="text-[12px] text-muted-foreground/50">
                      Country data appears after provider lookups resolve IP metadata.
                    </div>
                  )}
                </div>
              </div>
            </Panel>
          </div>

          <div className="grid gap-5 xl:grid-cols-[360px_1fr]">
            <Panel>
              <PanelHead
                title="Top providers"
                sub="Link count, affected runs, and abuse contacts"
                accent="var(--signal)"
              />
              {workflowProviderStats.providerRows.length ? (
                workflowProviderStats.providerRows.slice(0, 10).map((row, i) => (
                  <HBarRow
                    key={row.provider}
                    rank={i + 1}
                    label={row.provider}
                    value={formatNumber(row.count)}
                    share={(row.count / (workflowProviderStats.analysedLinks || 1)) * 100}
                    color={PALETTE[i % PALETTE.length]}
                    sub={`${formatNumber(row.affectedRuns)} runs · ${formatNumber(row.abuseContacts)} abuse contacts`}
                  />
                ))
              ) : (
                <div className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40">
                  No provider rows recorded yet
                </div>
              )}
            </Panel>

            <Panel>
              <PanelHead
                title="Workflow links"
                sub="Stream links captured during workflow execution"
                accent="var(--sky)"
                aside={
                  <span className="font-mono text-[10px] text-muted-foreground/60">
                    {formatNumber(workflowProviderLinkRows.length)} shown
                  </span>
                }
              />
              {workflowProviderLinkRows.length ? (
                <div className="overflow-x-auto">
                  <Table className="min-w-full text-[12px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        {["Link", "Provider", "Host", "Country", "Abuse", "Run"].map((h) => (
                          <TableHead key={h} className="px-4 py-2.5 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                            {h}
                          </TableHead>
                        ))}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {workflowProviderLinkRows.map((row: any, i: any) => (
                        <ProviderWorkflowRow key={`${row.url || row.stream_url}-${i}`} row={row} />
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <div className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40">
                  No workflow stream links recorded yet
                </div>
              )}
            </Panel>
          </div>
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
                  .map((row: any) => (
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
                  rawValues={trend.map((r: any) => Number(r.tool_calls || 0))}
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
                  const contextRow = {
                    context_window: row.contextWindow,
                    context_tokens: row.contextTokens,
                    context_usage_pct: row.peakContextPct,
                  };
                  const contextTone =
                    row.peakContextPct >= 0.85
                      ? "var(--rose)"
                      : row.peakContextPct >= 0.6
                        ? "var(--signal)"
                        : row.contextWindow > 0
                          ? "var(--mint)"
                          : "var(--mute)";
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
                              width: row.contextWindow > 0 ? `${Math.min(100, Math.max(0, row.peakContextPct * 100))}%` : "0%",
                              background: contextTone,
                            }}
                          />
                        </div>
                      </div>
                      <div
                        className="grid grid-cols-4 divide-x text-center"
                        // @ts-expect-error -- strict migration
                        style={{ divideColor: "var(--line)" }}
                      >
                        {[
                          {
                            label: "status",
                            value: statusLabel(row.latestStatus),
                            color: "var(--ink)",
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
                            label: "context",
                            value: row.contextWindow > 0 ? formatPercent(row.peakContextPct) : "--",
                            color: contextTone,
                          },
                        ].map(({ label, value, color }: any) => (
                          <div key={label} className="min-w-0 px-1 py-3">
                            <div
                              className="truncate font-mono text-[13px] font-semibold"
                              style={{ color }}
                              title={value}
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
                      <div className="border-t px-4 py-2.5 text-[11px] text-muted-foreground">
                        <span className="font-mono text-foreground/70">
                          {contextUsageLabel(contextRow)}
                        </span>
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

              <Panel>
                <PanelHead
                  title="Agent status mix"
                  sub="Terminal and in-flight statuses"
                  accent="var(--mint)"
                />
                <div className="flex flex-col items-center gap-4 p-5">
                  <DonutChart
                    segments={agentStatusSegs}
                    size={132}
                    thickness={18}
                    label={formatNumber(agentRows.length)}
                    sublabel="records"
                  />
                  {agentStatusSegs.length > 0 && <DonutLegend segments={agentStatusSegs} />}
                </div>
              </Panel>
            </div>
          </div>

          <Panel>
            <PanelHead
              title="Recent agent invocations"
              sub="Latest persisted agent rows from the workflow database"
              accent="var(--sky)"
              aside={
                <span className="font-mono text-[10px] text-muted-foreground/60">
                  {formatNumber(agentRows.length)} loaded
                </span>
              }
            />
            {recentAgentRows.length ? (
              <div className="overflow-x-auto">
                  <Table className="min-w-full text-[12px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                      {["Agent", "Status", "Target", "Context", "LLM", "Tools", "Duration"].map((h) => (
                        <TableHead key={h} className="px-4 py-2.5 text-left font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/60">
                          {h}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentAgentRows.map((row) => (
                      <TableRow key={row.id || `${row.actor}-${row.started_at}`}>
                        <TableCell className="px-4 py-2.5">
                          <div className="font-mono text-[11px] text-foreground">{row.actor || row.agent_type || "agent"}</div>
                          <div className="font-mono text-[10px] text-muted-foreground/50">{row.agent_type || "-"}</div>
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">{row.status || "-"}</TableCell>
                        <TableCell className="max-w-[340px] truncate px-4 py-2.5 font-mono text-[11px] text-muted-foreground" title={row.target_url}>
                          {row.target_url || "-"}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground" title={contextUsageLabel(row)}>
                          {contextUsage(row).contextWindow > 0 ? formatPercent(contextUsage(row).contextPct) : "--"}
                        </TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px]">{formatNumber(row.llm_calls_made || 0)}</TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px]">{formatNumber(row.tool_calls_made || 0)}</TableCell>
                        <TableCell className="px-4 py-2.5 font-mono text-[11px] text-muted-foreground">{Number(row.duration_seconds || 0).toFixed(1)}s</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <div className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40">
                No agent database rows returned
              </div>
            )}
          </Panel>

          {/* Failed runs */}
          <div className="grid gap-5 xl:grid-cols-2">
            <Panel>
              <PanelHead
                title="Recent agent failures"
                sub="Workflow failures that still count against the agent"
                accent="var(--rose)"
              />
              {failedRuns.length ? (
                failedRuns.map((row: any) => (
                  <FailedRunRow key={row.run_id} row={row} />
                ))
              ) : (
                <div
                  className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40"
                >
                  No agent failures recorded
                </div>
              )}
            </Panel>
            <Panel>
              <PanelHead
                title="Site/server blockers"
                sub="Recent inaccessible pages or no-stream outcomes"
                accent="var(--chart-4)"
              />
              {blockerRuns.length ? (
                blockerRuns.map((row: any) => (
                  <FailedRunRow key={row.run_id} row={row} />
                ))
              ) : (
                <div
                  className="px-4 py-10 text-center font-mono text-[12px] text-muted-foreground/40"
                >
                  No site/server blockers in recent runs
                </div>
              )}
            </Panel>
          </div>
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