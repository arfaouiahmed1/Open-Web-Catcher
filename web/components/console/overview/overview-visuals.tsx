"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  Pie,
  PieChart,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { SectionPanelSkeleton } from "@/components/console/common/section-panel";
import { EmptyState } from "@/components/console/common/empty-state";

export interface OverviewVisualsProps {
  overview: Record<string, unknown> | null;
  toolRows?: Array<Record<string, unknown>>;
  state?: "loading" | "error" | "success";
}

/** Target daily-average latency shown as a benchmark line on the latency chart. */
const LATENCY_TARGET_SECONDS = 30;

const PALETTE = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

type Summary = Record<string, unknown>;
type Row = Record<string, unknown>;

function readSummary(overview: Record<string, unknown> | null): Summary {
  return ((overview ?? {}).summary ?? {}) as Summary;
}

function readTrend(overview: Record<string, unknown> | null): Row[] {
  const o = (overview ?? {}) as Record<string, unknown>;
  return (Array.isArray(o.trend) ? o.trend : []) as Row[];
}

function readModels(overview: Record<string, unknown> | null): Row[] {
  const o = (overview ?? {}) as Record<string, unknown>;
  return (Array.isArray(o.model_breakdown) ? o.model_breakdown : []) as Row[];
}

function shortDate(value: unknown): string {
  return String(value ?? "").slice(5) || String(value ?? "");
}

function formatCompactNumber(value: unknown): string {
  const n = Number(value || 0);
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}b`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${Math.round(n)}`;
}

function formatCompactCurrency(value: unknown): string {
  const n = Number(value || 0);
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  if (abs > 0 && abs < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function successColor(rate: number): string {
  if (rate >= 0.9) return "var(--mint)";
  if (rate >= 0.7) return "var(--signal)";
  return "var(--rose)";
}

/** Hover card for the spend/token trend: date, runs, cost, tokens. */
function TrendTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ payload?: Row }>; label?: string | number }) {
  if (!active || !payload?.length) return null;
  const row: Row = payload[0]?.payload ?? {};
  return (
    <div className="rounded-lg border bg-card px-3 py-2 text-xs shadow-md">
      <div className="mb-1 font-mono font-semibold">{String(label ?? row.date ?? "")}</div>
      <div className="space-y-0.5 font-mono tabular-nums text-muted-foreground">
        <div>Runs: <span className="text-foreground">{formatNumber(Number(row.runs || 0))}</span></div>
        <div>Cost: <span className="text-foreground">{formatCurrency(Number(row.cost_usd || 0))}</span></div>
        <div>Tokens: <span className="text-foreground">{formatNumber(Number(row.tokens || 0))}</span></div>
      </div>
    </div>
  );
}

/** 7-day spend + token trend. Uses exact trend fields: date, runs, cost_usd, tokens. */
function SpendTokenTrend({ trend }: { trend: Row[] }) {
  if (trend.length < 2) {
    return <p className="px-1 py-8 text-center text-xs text-muted-foreground">Not enough history yet — charts appear after a couple of days with runs.</p>;
  }
  const data = trend.map((r) => ({
    date: shortDate(r.date),
    runs: Number(r.runs || 0),
    cost_usd: Number(r.cost_usd || 0),
    tokens: Number(r.tokens || 0),
  }));
  return (
    <ChartContainer
      config={{
        cost_usd: { label: "Cost ($)", color: "var(--chart-1)" },
        tokens: { label: "Tokens", color: "var(--chart-2)" },
      }}
      className="w-full"
      style={{ height: 230 }}
    >
      <AreaChart data={data} margin={{ top: 6, right: 8, left: 8, bottom: 0 }}>
        <defs>
          <linearGradient id="fill-ov-cost" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-cost_usd)" stopOpacity={0.35} />
            <stop offset="95%" stopColor="var(--color-cost_usd)" stopOpacity={0.04} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} />
        <YAxis
          yAxisId="cost"
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={formatCompactCurrency}
          domain={[0, "dataMax"]}
        />
        <YAxis
          yAxisId="tokens"
          orientation="right"
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={formatCompactNumber}
          domain={[0, "dataMax"]}
        />
        <ChartTooltip cursor={false} content={<TrendTooltip />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Area
          yAxisId="cost"
          dataKey="cost_usd"
          type="monotone"
          fill="url(#fill-ov-cost)"
          stroke="var(--color-cost_usd)"
          strokeWidth={2}
        />
        <Line
          yAxisId="tokens"
          dataKey="tokens"
          type="monotone"
          stroke="var(--color-tokens)"
          strokeWidth={2}
          strokeDasharray="5 3"
          dot={false}
        />
      </AreaChart>
    </ChartContainer>
  );
}

const NO_TARGET_STATUSES: Record<string, true> = { no_streams: true, no_hosting_pages: true, page_inaccessible: true, site_dead: true };

/** Run outcome donut. Uses exact summary.status_breakdown counts. */
function OutcomeDonut({ summary }: { summary: Summary }) {
  const breakdown = (summary.status_breakdown ?? {}) as Record<string, unknown>;
  let success = 0;
  let partial = 0;
  let noTarget = 0;
  let other = 0;
  for (const [status, count] of Object.entries(breakdown)) {
    const n = Number(count || 0);
    const key = status.trim().toLowerCase();
    if (key === "success") success += n;
    else if (key === "partial") partial += n;
    else if (NO_TARGET_STATUSES[key]) noTarget += n;
    else other += n;
  }
  const total = success + partial + noTarget + other;
  if (!total) {
    return <p className="px-1 py-8 text-center text-xs text-muted-foreground">No completed runs yet.</p>;
  }
  const segments = [
    { label: "Success", value: success, color: "var(--mint)" },
    { label: "Partial", value: partial, color: "var(--chart-2)" },
    { label: "No target", value: noTarget, color: "var(--signal)" },
    { label: "Needs attention", value: other, color: "var(--rose)" },
  ].filter((s) => s.value > 0);
  const donutConfig = {
    Success: { label: "Success", color: "var(--mint)" },
    Partial: { label: "Partial", color: "var(--chart-2)" },
    "No target": { label: "No target", color: "var(--signal)" },
    "Needs attention": { label: "Needs attention", color: "var(--rose)" },
  };
  return (
    <div className="flex flex-col items-center gap-5 p-5 sm:flex-row">
      <div className="relative shrink-0" style={{ width: 168, height: 168 }}>
        <ChartContainer config={donutConfig} className="h-[168px] w-[168px]">
          <PieChart>
          <Pie
            data={segments}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={56}
            outerRadius={78}
            paddingAngle={3}
            strokeWidth={0}
          >
            {segments.map((entry) => (
              <Cell key={entry.label} fill={entry.color} />
            ))}
          </Pie>
          <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
          </PieChart>
        </ChartContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="font-mono text-lg font-bold leading-none">{formatNumber(total)}</div>
          <div className="mt-1 text-[9px] uppercase tracking-[0.14em] text-muted-foreground">runs</div>
        </div>
      </div>
      <ul className="w-full flex-1 space-y-1.5">
        {segments.map((seg) => (
          <li key={seg.label} className="flex items-center gap-2 text-[11px]">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: seg.color }} />
            <span className="min-w-0 flex-1 truncate text-foreground/80">{seg.label}</span>
            <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
              {formatNumber(seg.value)} · {formatPercent(seg.value / total)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Daily average latency bars with a 30s benchmark line. Uses trend.avg_latency_seconds. */
function LatencyBars({ trend }: { trend: Row[] }) {
  if (trend.length < 2) {
    return <p className="px-1 py-8 text-center text-xs text-muted-foreground">Not enough history yet — latency bars appear after a couple of days with runs.</p>;
  }
  const data = trend.map((r) => ({
    date: shortDate(r.date),
    avg_latency_seconds: Number(r.avg_latency_seconds || 0),
  }));
  return (
    <ChartContainer
      config={{ avg_latency_seconds: { label: "Avg latency (s)", color: "var(--chart-5)" } }}
      className="w-full"
      style={{ height: 230 }}
    >
      <BarChart data={data} margin={{ top: 6, right: 16, left: 8, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} minTickGap={28} />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={52}
          tickFormatter={(v: unknown) => `${formatCompactNumber(v)}s`}
          domain={[0, "dataMax"]}
        />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" />} />
        <ChartLegend content={<ChartLegendContent />} />
        <ReferenceLine
          y={LATENCY_TARGET_SECONDS}
          stroke="var(--rose)"
          strokeDasharray="4 3"
          label={{ value: `${LATENCY_TARGET_SECONDS}s target`, fontSize: 10, fill: "var(--rose-text)", position: "insideTopRight" }}
        />
        <Bar dataKey="avg_latency_seconds" fill="var(--color-avg_latency_seconds)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ChartContainer>
  );
}

/** Provider + model distribution bars. Uses exact model_breakdown fields. */
function ProviderModelBars({ models }: { models: Row[] }) {
  const providerTotals = new Map<string, { provider: string; cost: number; tokens: number; calls: number }>();
  for (const row of models) {
    const provider = String(row.provider || "unknown");
    const entry = providerTotals.get(provider) ?? { provider, cost: 0, tokens: 0, calls: 0 };
    entry.cost += Number(row.cost_usd || 0);
    entry.tokens += Number(row.tokens || 0);
    entry.calls += Number(row.calls || 0);
    providerTotals.set(provider, entry);
  }
  const providers = [...providerTotals.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens).slice(0, 5);
  const totalCost = providers.reduce((s, r) => s + r.cost, 0);
  const totalTokens = providers.reduce((s, r) => s + r.tokens, 0);
  const bySpend = totalCost > 0;
  const total = bySpend ? totalCost : totalTokens || 1;
  const topModels = [...models]
    .sort((a, b) => Number(b.cost_usd || 0) - Number(a.cost_usd || 0) || Number(b.tokens || 0) - Number(a.tokens || 0))
    .slice(0, 5);
  if (!models.length) {
    return <p className="px-1 py-8 text-center text-xs text-muted-foreground">No model usage recorded yet.</p>;
  }
  return (
    <div>
      <p className="px-4 pt-3 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/75">By provider</p>
      {providers.map((row, i) => {
        const value = bySpend ? row.cost : row.tokens;
        return (
          <div key={row.provider} className="border-b px-4 py-2.5 last:border-0">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[12px] text-foreground" title={row.provider}>{row.provider}</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/70">
                {bySpend ? formatCurrency(value) : `${formatNumber(value)} tok`}
              </span>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/75">
              {formatNumber(row.calls)} calls · {formatNumber(row.tokens)} tok
            </div>
            <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${Math.min(100, (value / total) * 100)}%`, background: PALETTE[i % PALETTE.length] }}
              />
            </div>
          </div>
        );
      })}
      <p className="px-4 pt-3 text-[9.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/75">By model</p>
      {topModels.map((row, i) => {
        const label = String(row.label || `${row.provider || "?"}::${row.model_name || "?"}`);
        const value = bySpend ? Number(row.cost_usd || 0) : Number(row.tokens || 0);
        return (
          <div key={`${label}-${i}`} className="border-b px-4 py-2.5 last:border-0">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-foreground/80" title={label}>{label}</span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-foreground/70">
                {bySpend ? formatCurrency(value) : `${formatNumber(value)} tok`}
              </span>
            </div>
            <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-border">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${Math.min(100, (value / total) * 100)}%`, background: PALETTE[(i + 2) % PALETTE.length] }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Tool reliability bars. Uses exact top_tools fields. */
function ToolReliabilityBars({ tools }: { tools: Row[] }) {
  const rows = [...tools]
    .sort((a, b) => Number(b.calls || 0) - Number(a.calls || 0))
    .slice(0, 6);
  if (!rows.length) {
    return <p className="px-1 py-8 text-center text-xs text-muted-foreground">No tool calls recorded yet.</p>;
  }
  return (
    <div>
      <div
        className="grid border-b px-4 py-2"
        style={{ borderColor: "var(--line)", background: "var(--card)", gridTemplateColumns: "1fr 64px 96px 56px" }}
      >
        {["tool", "calls", "success", "avg"].map((h) => (
          <div
            key={h}
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground/75 first:text-left text-right"
          >
            {h}
          </div>
        ))}
      </div>
      {rows.map((row) => {
        const rate = Number(row.success_rate || 0);
        const color = successColor(rate);
        return (
          <div
            key={String(row.tool_name || "?")}
            className="grid items-center gap-3 border-b px-4 py-2.5 last:border-0"
            style={{ gridTemplateColumns: "1fr 64px 96px 56px" }}
          >
            <div className="min-w-0 truncate font-mono text-[11px] text-foreground/80" title={String(row.tool_name || "?")}>
              {String(row.tool_name || "?")}
            </div>
            <div className="text-right font-mono text-[11px] text-muted-foreground">{formatNumber(Number(row.calls || 0))}</div>
            <div className="flex items-center gap-2">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                <div className="h-full rounded-full" style={{ width: `${Math.min(100, rate * 100)}%`, background: color }} />
              </div>
              <span className="w-8 text-right font-mono text-[10px]" style={{ color }}>{Math.round(rate * 100)}%</span>
            </div>
            <div className="text-right font-mono text-[10px] text-muted-foreground/75">
              {Number(row.avg_duration_seconds || 0).toFixed(1)}s
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OverviewVisuals({ overview, toolRows, state }: OverviewVisualsProps) {
  if (state === "loading" || !overview) {
    return (
      <div className="grid gap-5 xl:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <SectionPanelSkeleton key={i} className={i === 0 ? "xl:col-span-2" : undefined} />
        ))}
      </div>
    );
  }
  if (state === "error") {
    return (
      <Card>
        <CardContent className="py-10 text-center text-sm text-destructive">
          Could not load dashboard charts.
        </CardContent>
      </Card>
    );
  }

  const summary = readSummary(overview);
  const trend = readTrend(overview);
  const models = readModels(overview);
  const tools = (toolRows ?? ((overview as Record<string, unknown>).top_tools ?? []) as Row[]) as Row[];
  const hasAnything =
    Number(summary.total_runs || 0) > 0 || trend.length > 0 || models.length > 0 || tools.length > 0;
  if (!hasAnything) {
    return (
      <Card>
        <EmptyState
          tone="default"
          title="No dashboard data yet"
          description="Run a pipeline to populate spend, outcome, latency, provider, and tool charts."
        />
      </Card>
    );
  }

  return (
    <div className="grid gap-5 xl:grid-cols-2">
      <Card className="overflow-hidden xl:col-span-2">
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Spend &amp; token trend</CardTitle>
          <CardDescription>Daily model spend and token volume over the last 7 days</CardDescription>
        </CardHeader>
        <CardContent className="p-5">
          <SpendTokenTrend trend={trend} />
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Run outcomes</CardTitle>
          <CardDescription>Completed runs grouped by result</CardDescription>
        </CardHeader>
        <OutcomeDonut summary={summary} />
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Daily latency</CardTitle>
          <CardDescription>Average run time per day against the 30s target</CardDescription>
        </CardHeader>
        <CardContent className="p-5">
          <LatencyBars trend={trend} />
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Spend by provider &amp; model</CardTitle>
          <CardDescription>Where token volume and model spend concentrate</CardDescription>
        </CardHeader>
        <ProviderModelBars models={models} />
      </Card>

      <Card className="overflow-hidden">
        <CardHeader className="border-b">
          <CardTitle className="text-sm">Tool reliability</CardTitle>
          <CardDescription>Most-used browser tools and their success rates</CardDescription>
        </CardHeader>
        <ToolReliabilityBars tools={tools} />
      </Card>
    </div>
  );
}
