"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Globe, Loader2, Search, Server, Shield, Wifi } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { KpiCard } from "@/components/kpi-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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

function BarChart({ rows, valueKey = "count", labelKey = "provider", color = "var(--signal)", maxBars = 10, renderLabel = null, emptyMsg = "No data" }) {
  const visible = (rows || []).slice(0, maxBars);
  if (!visible.length) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">{emptyMsg}</div>
    );
  }
  const max = Math.max(...visible.map((row) => Number(row[valueKey] || 0)), 1);
  return (
    <div className="space-y-2">
      {visible.map((row, index) => {
        const value = Number(row[valueKey] || 0);
        const pct = (value / max) * 100;
        return (
          <div key={`${row[labelKey]}-${index}`} className="flex items-center gap-3">
            <div className="w-32 shrink-0 truncate text-right text-[12px] text-foreground/70" title={row[labelKey]}>
              {renderLabel ? renderLabel(row) : (row[labelKey] || "--")}
            </div>
            <div className="relative flex-1 overflow-hidden rounded-full bg-border" style={{ height: 8 }}>
              <div
                className="absolute inset-y-0 left-0 rounded-full transition-all duration-500"
                style={{ width: `${pct}%`, background: color }}
              />
            </div>
            <div className="w-10 shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">{value}</div>
          </div>
        );
      })}
    </div>
  );
}

function StatBadge({ label, value, color }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border bg-card px-3 py-2.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">{label}</span>
      <span className="text-[18px] font-semibold tabular-nums" style={{ color: color || "var(--foreground)" }}>{value}</span>
    </div>
  );
}

function LookupRow({ row, even }) {
  return (
    <TableRow>
      <TableCell className="px-4 py-2.5 font-mono text-[11px] max-w-[220px] truncate text-sky-400" title={row.stream_url}>
        {row.stream_url?.replace(/^https?:\/\//, "")}
      </TableCell>
      <TableCell className="px-4 py-2.5 font-mono text-[11.5px] text-foreground/80">{row.ip || "--"}</TableCell>
      <TableCell className="px-4 py-2.5 text-[12px] text-foreground/80">{row.provider || "--"}</TableCell>
      <TableCell className="px-4 py-2.5 text-[12px] text-muted-foreground">{row.org || "--"}</TableCell>
      <TableCell className="px-4 py-2.5 text-[12px] text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span>{row.flag || "🌐"}</span>
          <span>{row.country_code || row.country || "--"}</span>
        </span>
      </TableCell>
      <TableCell className={`px-4 py-2.5 text-[11.5px] font-mono ${row.abuse_email ? "text-primary" : "text-muted-foreground/40"}`}>
        {row.abuse_email || "--"}
      </TableCell>
    </TableRow>
  );
}

function CountryMap({ points = [] }) {
  if (!points.length) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        No country history yet
      </div>
    );
  }
  const total = points.reduce((sum, point) => sum + Number(point.count || 0), 0) || 1;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {points.map((point) => (
        <div key={`${point.country_code}-${point.country}`} className="rounded-xl border bg-card px-3 py-3 text-center">
          <div className="text-2xl">{point.flag || "🌐"}</div>
          <div className="mt-1 text-[12px] font-medium text-foreground">{point.country_code || point.country}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{formatNumber(point.count || 0)} checks</div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full" style={{ width: `${(Number(point.count || 0) / total) * 100}%`, background: "var(--sky)" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProvidersPage() {
  const [urlsText, setUrlsText] = useState(SAMPLE);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState({ rows: [], summary: {}, top_providers: [], top_countries: [], country_map: { points: [] } });
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function loadHistory() {
    const payload = await apiFetch("/ui/providers/history?limit=50&offset=0");
    setHistory(payload);
  }

  useEffect(() => {
    setError("");
    loadHistory().catch(() =>
      setHistory({
        rows: [],
        summary: {},
        top_providers: [],
        top_countries: [],
        country_map: { points: [] },
      }),
    );
  }, []);

  async function runLookup() {
    setIsLoading(true);
    setError("");
    try {
      const streamUrls = urlsText.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
      const response = await fetch(apiUrl("/ui/providers/lookup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream_urls: streamUrls }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.detail || `Status ${response.status}`);
      setResult(payload);
      await loadHistory();
    } catch (lookupError) {
      setError(lookupError.message || "Provider lookup failed");
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }

  const stats = result?.stats || history.summary || {};
  const displayRows = result?.rows || history.rows || [];
  const topProviders = result?.top_providers || history.top_providers || [];
  const topCountries = result?.top_countries || history.top_countries || [];
  const countryMap = result?.country_map?.points || history.country_map?.points || [];

  const kpis = [
    { label: "Checked URLs", value: formatNumber(stats.total_urls || stats.total_checks || 0), description: "Stream URLs inspected", accent: "signal", icon: Wifi },
    { label: "Resolved IPs", value: formatNumber(stats.resolved_ips || 0), description: "URLs with a routable IP", accent: "mint", icon: Server },
    { label: "Provider matches", value: formatNumber(stats.provider_matches || 0), description: "Identified org / hosting", accent: "sky", icon: Globe },
    { label: "Abuse contacts", value: formatNumber(stats.abuse_contacts_found || 0), description: "Abuse email found", accent: "rose", icon: Shield },
  ];

  const resolveRate = stats.total_urls ? Math.round(((stats.resolved_ips || 0) / stats.total_urls) * 100) : 0;
  const matchRate = stats.total_urls ? Math.round(((stats.provider_matches || 0) / stats.total_urls) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Stream URL Intelligence</h1>
        <p className="max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
          Resolve stream URLs to IP, hosting provider, country, and abuse contacts, then visualize provider and country coverage from the DB-backed lookup history.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((kpi) => <KpiCard key={kpi.label} {...kpi} />)}
      </div>

      {stats.total_urls > 0 ? (
        <Card>
          <CardContent className="grid gap-3 sm:grid-cols-4 p-4">
            <StatBadge label="Resolve rate" value={`${resolveRate}%`} color={resolveRate > 80 ? "var(--mint)" : resolveRate > 50 ? "var(--signal)" : "var(--rose)"} />
            <StatBadge label="Provider match rate" value={`${matchRate}%`} color={matchRate > 60 ? "var(--mint)" : "var(--signal)"} />
            <StatBadge label="Unique providers" value={formatNumber(stats.unique_providers || topProviders.length)} color="var(--sky)" />
            <StatBadge label="Countries" value={formatNumber(stats.unique_countries || topCountries.length)} color="var(--violet)" />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Search className="h-3.5 w-3.5 text-primary" />
            <CardTitle className="text-sm font-medium">Manual lookup</CardTitle>
            <span className="ml-1 rounded-full border px-2 py-0.5 font-mono text-[10.5px] text-muted-foreground">
              secondary tool
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={urlsText}
            onChange={(event) => setUrlsText(event.target.value)}
            className="min-h-[120px]"
            placeholder="https://cdn.example.com/live/master.m3u8"
            mono
          />
          {error ? (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          ) : null}
          <div className="flex gap-2">
            <Button variant="accent" onClick={runLookup} disabled={isLoading}>
              {isLoading ? <><Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />Resolving...</> : "Run lookup"}
            </Button>
            <Button variant="outline" onClick={loadHistory}>
              Refresh history
            </Button>
          </div>
        </CardContent>
      </Card>

      {(topProviders.length > 0 || topCountries.length > 0) ? (
        <div className="grid gap-5 xl:grid-cols-2">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm">Provider distribution</CardTitle>
                  <CardDescription>Hosting / CDN frequency across all checked URLs</CardDescription>
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">{topProviders.length} providers</span>
              </div>
            </CardHeader>
            <CardContent>
              <BarChart rows={topProviders} valueKey="count" labelKey="provider" color="var(--signal)" maxBars={12} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm">Country distribution</CardTitle>
                  <CardDescription>Flags and country codes from resolved IP history</CardDescription>
                </div>
                <span className="font-mono text-[11px] text-muted-foreground">{topCountries.length} countries</span>
              </div>
            </CardHeader>
            <CardContent>
              <BarChart
                rows={topCountries}
                valueKey="count"
                labelKey="country"
                color="var(--sky)"
                maxBars={12}
                renderLabel={(row) => `${row.flag || "🌐"} ${row.country_code || row.country || "--"}`}
              />
            </CardContent>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-sm">Country map</CardTitle>
              <CardDescription>Country badges from stored lookup history</CardDescription>
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">{countryMap.length} points</span>
          </div>
        </CardHeader>
        <CardContent>
          <CountryMap points={countryMap} />
        </CardContent>
      </Card>

      {displayRows.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
            <div className="flex items-center gap-3">
              <CardTitle className="text-sm">
                {result ? "Latest lookup results" : "Lookup history"}
              </CardTitle>
              <span className="font-mono text-[11px] text-muted-foreground">{displayRows.length} entries</span>
            </div>
            {result ? (
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                Show history
              </Button>
            ) : null}
          </CardHeader>
          <Table className="min-w-full text-[12.5px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {["URL", "IP", "Provider", "Org", "Country", "Abuse contact"].map((header) => (
                  <TableHead key={header} className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] whitespace-nowrap text-muted-foreground/60">
                    {header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayRows.map((row, index) => (
                <LookupRow key={`${row.stream_url}-${index}`} row={row} even={index % 2 === 0} />
              ))}
            </TableBody>
          </Table>
        </Card>
      ) : !isLoading ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
            <Wifi className="h-8 w-8 opacity-30" />
            <p className="text-sm">Paste stream URLs above and run a lookup to see results here.</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
