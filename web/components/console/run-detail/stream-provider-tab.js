"use client";

import { useEffect, useState } from "react";
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
import { AlertCircle, Globe, Loader2, Server, Shield, Wifi } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

function BarTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-md text-[12px]">
      <p className="font-medium text-foreground">{label}</p>
      <p className="text-muted-foreground">{formatNumber(payload[0]?.value)} URLs</p>
    </div>
  );
}

function PieTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-md text-[12px]">
      <p className="font-medium text-foreground">{payload[0]?.name}</p>
      <p className="text-muted-foreground">{formatNumber(payload[0]?.value)} URLs</p>
    </div>
  );
}

function ProviderBarChart({ rows = [], color = "var(--signal)" }) {
  const data = rows.slice(0, 10).map((r) => ({
    name: r.provider || "--",
    count: Number(r.count || 0),
  }));
  if (!data.length) return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">No data</div>;
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} layout="vertical" margin={{ left: 4, right: 12, top: 4, bottom: 4 }}>
        <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis type="number" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} />
        <YAxis type="category" dataKey="name" width={100} tick={{ fontSize: 11, fill: "hsl(var(--foreground))" }} tickLine={false} axisLine={false} />
        <Tooltip content={<BarTooltip />} cursor={{ fill: "hsl(var(--muted))" }} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]} fill={color} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function CountryPieChart({ rows = [] }) {
  const data = rows.slice(0, 7).map((r, i) => ({
    name: `${r.flag || "🌐"} ${r.country_code || r.country || "--"}`,
    value: Number(r.count || 0),
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));
  if (!data.length) return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">No country data</div>;
  return (
    <div className="flex items-center gap-5">
      <ResponsiveContainer width={160} height={160}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={44} outerRadius={72} paddingAngle={3} dataKey="value">
            {data.map((entry, i) => <Cell key={entry.name} fill={entry.color} />)}
          </Pie>
          <Tooltip content={<PieTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="flex-1 space-y-1.5 min-w-0">
        {data.map((entry) => (
          <div key={entry.name} className="flex items-center gap-2 text-[12px]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color }} />
            <span className="truncate text-foreground">{entry.name}</span>
            <span className="ml-auto font-mono text-[11px] text-muted-foreground tabular-nums">{formatNumber(entry.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <Card>
      <CardContent className="px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">{label}</p>
        <p className="mt-1 text-xl font-semibold tabular-nums" style={{ color }}>{value}</p>
      </CardContent>
    </Card>
  );
}

export function StreamProviderTab({ runId, runUrl }) {
  const [data, setData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasRun, setHasRun] = useState(false);

  async function fetchHistory() {
    const payload = await apiFetch("/ui/providers/history?limit=50&offset=0");
    return payload;
  }

  async function runLookup(urls) {
    setIsLoading(true);
    setError("");
    try {
      const response = await fetch(apiUrl("/ui/providers/lookup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream_urls: urls }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `Status ${response.status}`);
      setData(payload);
    } catch (e) {
      setError(e.message || "Provider lookup failed");
    } finally {
      setIsLoading(false);
      setHasRun(true);
    }
  }

  useEffect(() => {
    // Auto-resolve run URL when tab mounts
    if (runUrl) {
      runLookup([runUrl]);
    } else {
      // Fall back to history
      fetchHistory()
        .then((h) => setData(h))
        .catch(() => {})
        .finally(() => setHasRun(true));
    }
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = data?.stats || data?.summary || {};
  const rows = data?.rows || [];
  const topProviders = data?.top_providers || [];
  const topCountries = data?.top_countries || [];

  const resolveRate = stats.total_urls
    ? Math.round(((stats.resolved_ips || 0) / stats.total_urls) * 100)
    : null;
  const matchRate = stats.total_urls
    ? Math.round(((stats.provider_matches || 0) / stats.total_urls) * 100)
    : null;

  if (isLoading) {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary/60" />
        <p className="text-sm text-muted-foreground">Resolving stream URLs…</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Provider Intelligence</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {runUrl
              ? `Resolved from run URL — IP, hosting provider, country, and abuse contacts.`
              : "Lookup history across all resolved stream URLs."}
          </p>
        </div>
        {runUrl ? (
          <Button variant="outline" size="sm" onClick={() => runLookup([runUrl])} disabled={isLoading}>
            <Wifi className="mr-1.5 h-3.5 w-3.5" />
            Re-resolve
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {/* Stats row */}
      {stats.total_urls > 0 ? (
        <div className="grid gap-3 sm:grid-cols-4">
          {resolveRate !== null ? (
            <StatCard label="Resolve rate" value={`${resolveRate}%`} color={resolveRate > 80 ? "var(--mint)" : "var(--signal)"} />
          ) : null}
          {matchRate !== null ? (
            <StatCard label="Match rate" value={`${matchRate}%`} color={matchRate > 60 ? "var(--mint)" : "var(--signal)"} />
          ) : null}
          <StatCard label="Unique providers" value={formatNumber(stats.unique_providers || topProviders.length)} color="var(--sky)" />
          <StatCard label="Countries" value={formatNumber(stats.unique_countries || topCountries.length)} color="var(--violet)" />
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
                  <CardDescription>Hosting / CDN frequency</CardDescription>
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
                  <CardDescription>From resolved IP geolocation</CardDescription>
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

      {/* Detail table */}
      {rows.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
            <CardTitle className="text-sm">Resolution results</CardTitle>
            <Badge tone="default" className="font-mono text-[10px]">{rows.length} entries</Badge>
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
                {rows.map((row, i) => (
                  <TableRow key={`${row.stream_url}-${i}`}>
                    <TableCell className="max-w-[200px] truncate px-4 py-2.5 font-mono text-[11px] text-sky-500" title={row.stream_url}>
                      {row.stream_url?.replace(/^https?:\/\//, "")}
                    </TableCell>
                    <TableCell className="px-4 py-2.5 font-mono text-[11.5px]">{row.ip || "--"}</TableCell>
                    <TableCell className="px-4 py-2.5 text-[12px]">{row.provider || "--"}</TableCell>
                    <TableCell className="px-4 py-2.5 text-[12px] text-muted-foreground">{row.org || "--"}</TableCell>
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
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>
      ) : hasRun && !error ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center text-muted-foreground">
            <Globe className="h-7 w-7 opacity-30" />
            <p className="text-sm">No resolution data for this run yet.</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
