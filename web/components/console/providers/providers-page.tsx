/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useState } from "react";
import {
  AlertCircle,
  Globe,
  Loader2,
  Search,
  Server,
  Shield,
  Wifi,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { KpiCard } from "@/components/kpi-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

const SAMPLE = `https://cdn.example.com/live/master.m3u8\nhttps://edge.example.net/channel/index.m3u8`;

const CHART_COLORS = [
  "var(--signal)",
  "var(--sky)",
  "var(--mint)",
  "var(--violet)",
  "hsl(35 90% 58%)",
  "hsl(160 60% 50%)",
  "hsl(260 70% 65%)",
  "hsl(10 80% 58%)",
];

function CustomBarTooltip({  active, payload, label  }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-md text-[12px]">
      <p className="font-medium text-foreground">{label}</p>
      <p className="text-muted-foreground">{formatNumber(payload[0]?.value)} URLs</p>
    </div>
  );
}

function CustomPieTooltip({  active, payload  }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-md text-[12px]">
      <p className="font-medium text-foreground">{payload[0]?.name}</p>
      <p className="text-muted-foreground">{formatNumber(payload[0]?.value)} URLs</p>
    </div>
  );
}

function ProviderBarChart({  rows = [], color = "var(--signal)", maxBars = 12  }: any) {
  const data = rows.slice(0, maxBars).map((r: any) => ({
    name: r.provider || r.country || "--",
    count: Number(r.count || 0),
  }));
  if (!data.length) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        No data yet
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} layout="vertical" margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis type="number" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          tick={{ fontSize: 11, fill: "hsl(var(--foreground))" }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip content={<CustomBarTooltip />} cursor={{ fill: "hsl(var(--muted))" }} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]} fill={color} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function CountryPieChart({  rows = []  }: any) {
  const data = rows.slice(0, 8).map((r: any, i: any) => ({
    name: `${r.flag || "🌐"} ${r.country_code || r.country || "--"}`,
    value: Number(r.count || 0),
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));
  if (!data.length) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
        No country data
      </div>
    );
  }
  return (
    <div className="flex items-center gap-6">
      <ResponsiveContainer width={180} height={180}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={52}
            outerRadius={80}
            paddingAngle={3}
            dataKey="value"
          >
            {data.map((entry: any, i: any) => (
              <Cell key={entry.name} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip content={<CustomPieTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex-1 space-y-1.5 min-w-0">
        {data.map((entry: any) => (
          <div key={entry.name} className="flex items-center gap-2 text-[12px]">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: entry.color }}
            />
            <span className="truncate text-foreground">{entry.name}</span>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">
              {formatNumber(entry.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LookupRow({  row  }: any) {
  return (
    <TableRow>
      <TableCell className="max-w-[200px] truncate px-4 py-2.5 font-mono text-[11px] text-sky-500" title={row.stream_url}>
        {row.stream_url?.replace(/^https?:\/\//, "")}
      </TableCell>
      <TableCell className="px-4 py-2.5 font-mono text-[11.5px] text-foreground/80">
        {row.ip || "--"}
      </TableCell>
      <TableCell className="px-4 py-2.5 text-[12px] text-foreground/80">
        {row.provider || "--"}
      </TableCell>
      <TableCell className="px-4 py-2.5 text-[12px] text-muted-foreground">
        {row.org || "--"}
      </TableCell>
      <TableCell className="px-4 py-2.5 text-[12px]">
        <span className="inline-flex items-center gap-1.5">
          <span>{row.flag || "🌐"}</span>
          <span className="text-muted-foreground">{row.country_code || row.country || "--"}</span>
        </span>
      </TableCell>
      <TableCell className={`px-4 py-2.5 font-mono text-[11px] ${row.abuse_email ? "text-primary" : "text-muted-foreground/40"}`}>
        {row.abuse_email || "--"}
      </TableCell>
    </TableRow>
  );
}

export function ProvidersPage() {
  const [urlsText, setUrlsText] = useState(SAMPLE);
  const [result, setResult] = useState<any>(null);
  const [history, setHistory] = useState({
    rows: [],
    summary: {},
    top_providers: [],
    top_countries: [],
    country_map: { points: [] },
  });
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function loadHistory() {
    const payload = await apiFetch("/ui/providers/history?limit=50&offset=0");
    // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
    setHistory(payload);
  }

  useEffect(() => {
    setError("");
    loadHistory().catch(() =>
      setHistory({ rows: [], summary: {}, top_providers: [], top_countries: [], country_map: { points: [] } }),
    );
  }, []);

  async function runLookup() {
    setIsLoading(true);
    setError("");
    try {
      const streamUrls = urlsText.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
      const response = await fetch(apiUrl("/ui/providers/lookup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream_urls: streamUrls }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `Status ${response.status}`);
      setResult(payload);
      await loadHistory();
    } catch (e: any) {
      setError(e.message || "Provider lookup failed");
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }

  const stats = result?.stats || history.summary || {};
  const displayRows = result?.rows || history.rows || [];
  const topProviders = result?.top_providers || history.top_providers || [];
  const topCountries = result?.top_countries || history.top_countries || [];

  const resolveRate = stats.total_urls
    ? Math.round(((stats.resolved_ips || 0) / stats.total_urls) * 100)
    : 0;
  const matchRate = stats.total_urls
    ? Math.round(((stats.provider_matches || 0) / stats.total_urls) * 100)
    : 0;

  const kpis = [
    { label: "Checked URLs", value: formatNumber(stats.total_urls || stats.total_checks || 0), description: "Stream URLs inspected", accent: "signal", icon: Wifi },
    { label: "Resolved IPs", value: formatNumber(stats.resolved_ips || 0), description: "URLs with a routable IP", accent: "mint", icon: Server },
    { label: "Provider matches", value: formatNumber(stats.provider_matches || 0), description: "Identified org / hosting", accent: "sky", icon: Globe },
    { label: "Abuse contacts", value: formatNumber(stats.abuse_contacts_found || 0), description: "Abuse email found", accent: "rose", icon: Shield },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stream URL Intelligence</h1>
        <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
          Resolve stream URLs to IP, hosting provider, country, and abuse contacts. Visualizes provider and country coverage from the DB-backed lookup history.
        </p>
      </div>

      {/* KPIs */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => <KpiCard key={kpi.label} {...kpi} />)}
      </div>

      {/* Rate stats */}
      {stats.total_urls > 0 ? (
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            { label: "Resolve rate", value: `${resolveRate}%`, color: resolveRate > 80 ? "var(--mint)" : resolveRate > 50 ? "var(--signal)" : "var(--rose)" },
            { label: "Match rate", value: `${matchRate}%`, color: matchRate > 60 ? "var(--mint)" : "var(--signal)" },
            { label: "Unique providers", value: formatNumber(stats.unique_providers || topProviders.length), color: "var(--sky)" },
            { label: "Countries", value: formatNumber(stats.unique_countries || topCountries.length), color: "var(--violet)" },
          ].map((s) => (
            <Card key={s.label}>
              <CardContent className="px-4 py-3">
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">{s.label}</p>
                <p className="mt-1 text-[22px] font-semibold tabular-nums" style={{ color: s.color }}>{s.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {/* Charts */}
      {(topProviders.length > 0 || topCountries.length > 0) ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm">Provider distribution</CardTitle>
                  <CardDescription>Hosting / CDN frequency across checked URLs</CardDescription>
                </div>
                <Badge tone="default" className="font-mono text-[10px]">{topProviders.length} providers</Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <ProviderBarChart rows={topProviders} color="var(--signal)" />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm">Country distribution</CardTitle>
                  <CardDescription>Countries from resolved IP geolocation</CardDescription>
                </div>
                <Badge tone="default" className="font-mono text-[10px]">{topCountries.length} countries</Badge>
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              <CountryPieChart rows={topCountries} />
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* Manual lookup */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-primary" />
            <CardTitle className="text-sm">Manual lookup</CardTitle>
            <span className="rounded-full border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
              one URL per line
            </span>
          </div>
          <CardDescription>Paste stream URLs to resolve IPs, providers, and abuse contacts on demand.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={urlsText}
            onChange={(e) => setUrlsText(e.target.value)}
            className="min-h-[100px] font-mono text-xs"
            placeholder="https://cdn.example.com/live/master.m3u8"
          />
          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button variant="accent" onClick={runLookup} disabled={isLoading}>
              {isLoading ? (
                <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Resolving…</>
              ) : "Run lookup"}
            </Button>
            <Button variant="outline" onClick={loadHistory}>Refresh history</Button>
            {result ? (
              <Button variant="ghost" size="sm" onClick={() => setResult(null)} className="ml-auto text-muted-foreground">
                Clear results
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Results table */}
      {displayRows.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm">
                {result ? "Lookup results" : "Lookup history"}
              </CardTitle>
              <Badge tone="default" className="font-mono text-[10px]">{displayRows.length} entries</Badge>
            </div>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table className="min-w-full text-[12px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {["URL", "IP", "Provider", "Org", "Country", "Abuse contact"].map((h) => (
                    <TableHead key={h} className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60 whitespace-nowrap">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {displayRows.map((row: any, i: any) => (
                  <LookupRow key={`${row.stream_url}-${i}`} row={row} />
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      ) : !isLoading ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
            <Wifi className="h-8 w-8 opacity-30" />
            <p className="text-sm">Paste stream URLs above and run a lookup to see results here.</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}