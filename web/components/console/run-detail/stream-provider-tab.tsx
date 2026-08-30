/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { useEffect, useMemo, useState } from "react";
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

import { apiUrl } from "@/lib/api";
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

function dedupe(values = []) {
  const seen = new Set();
  const rows = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    rows.push(text);
  }
  return rows;
}

function normalizeCountryCode(value: any) {
  const text = String(value || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(text) ? text : "";
}

function flagEmojiFromCountryCode(code: any) {
  const normalized = normalizeCountryCode(code);
  if (!normalized) return "";
  return Array.from(normalized)
    .map((char) => String.fromCodePoint(127397 + char.charCodeAt(0)))
    .join("");
}

function normalizeProviderRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const countryCode =
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      normalizeCountryCode(row?.country_code) || normalizeCountryCode(row?.country);
    return {
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      ...row,
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      stream_url: String(row?.stream_url || row?.url || "").trim(),
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      ip: String(row?.ip || "").trim(),
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      hostname: String(row?.hostname || "").trim(),
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      provider: String(row?.provider || "").trim(),
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      org: String(row?.org || "").trim(),
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      country: String(row?.country || "").trim(),
      country_code: countryCode,
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      flag: String(row?.flag || "").trim() || flagEmojiFromCountryCode(countryCode),
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      abuse_email: String(row?.abuse_email || "").trim(),
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      whois_raw: String(row?.whois_raw || "").trim(),
    };
  });
}

function buildProviderPayload(rows = [], source = "persisted") {
  const normalizedRows = normalizeProviderRows(rows);
  const providerCounts = {};
  const countryCounts = {};
  for (const row of normalizedRows) {
    if (row.provider) {
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      providerCounts[row.provider] = (providerCounts[row.provider] || 0) + 1;
    }
    if (row.country || row.country_code) {
      const key = row.country || row.country_code;
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      const entry = countryCounts[key] || {
        country: row.country || row.country_code,
        country_code: row.country_code,
        flag: row.flag,
        count: 0,
      };
      entry.count += 1;
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      countryCounts[key] = entry;
    }
  }
  return {
    source,
    rows: normalizedRows,
    stats: {
      total_urls: normalizedRows.length,
      resolved_ips: normalizedRows.filter((row) => row.ip).length,
      provider_matches: normalizedRows.filter((row) => row.provider).length,
      abuse_contacts_found: normalizedRows.filter((row) => row.abuse_email).length,
      unique_providers: Object.keys(providerCounts).length,
      unique_hosts: new Set(normalizedRows.map((row) => row.hostname).filter(Boolean)).size,
      unique_countries: Object.keys(countryCounts).length,
      unresolved_urls: normalizedRows.filter((row) => !row.ip).length,
    },
    top_providers: Object.entries(providerCounts)
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([provider, count]) => ({ provider, count })),
    top_countries: Object.values(countryCounts)
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      .sort((a, b) => (b.count - a.count) || String(a.country).localeCompare(String(b.country)))
      .slice(0, 8),
  };
}

function collectServerStreamUrls(server: any) {
  return dedupe([
    // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
    ...(Array.isArray(server?.stream_urls) ? server.stream_urls : []),
    // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
    ...(Array.isArray(server?.m3u8_urls) ? server.m3u8_urls : []),
    // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
    ...(Array.isArray(server?.mpd_urls) ? server.mpd_urls : []),
    // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
    ...(Array.isArray(server?.mp4_urls) ? server.mp4_urls : []),
    // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
    server?.primary_stream || "",
  ]);
}

function summarizeExtractionResults(extractionResults = []) {
  return (Array.isArray(extractionResults) ? extractionResults : [])
    .filter((row) => row && typeof row === "object")
    .map((row, index) => {
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      const servers = (Array.isArray(row.servers) ? row.servers : [])
        .filter((server: any) => server && typeof server === "object")
        .map((server: any) => {
          const streamUrls = collectServerStreamUrls(server);
          return {
            label: String(server.label || `server_${index + 1}`).trim(),
            status: String(server.status || "unknown").trim(),
            server_up: Boolean(server.server_up),
            player_state: String(server.player_state || "").trim(),
            detected_channel: String(server.detected_channel || server.channel || "").trim(),
            channel_candidates: Array.isArray(server.channel_candidates)
              ? server.channel_candidates.filter(Boolean)
              : [],
            channel_confidence: String(server.channel_confidence || "").trim(),
            channel_detection_method: String(server.channel_detection_method || "").trim(),
            ocr_text: String(server.ocr_text || server.player_ocr_text || "").trim(),
            screenshot_url: String(server.screenshot_url || "").trim(),
            embedded_url: String(server.embedded_url || "").trim(),
            player_iframe_url: String(server.player_iframe_url || "").trim(),
            network_diagnostics_count: Array.isArray(server.network_diagnostics)
              ? server.network_diagnostics.length
              : 0,
            iframe_diagnostics_count: Array.isArray(server.iframe_diagnostics)
              ? server.iframe_diagnostics.length
              : 0,
            stream_urls: streamUrls,
          };
        });
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      const sampleStreams = dedupe([
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        ...(Array.isArray(row.streams) ? row.streams.map((stream: any) => stream?.url || "") : []),
        ...servers.flatMap((server: any) => server.stream_urls),
      ]);
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      const screenshots = dedupe([
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        ...(Array.isArray(row.screenshots) ? row.screenshots : []),
        ...servers.map((server: any) => server.screenshot_url),
      ]);
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      const channelMetadata = row.channel_metadata && typeof row.channel_metadata === "object"
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        ? row.channel_metadata
        : {};
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      const detectedChannels = dedupe([
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        ...(Array.isArray(row.detected_channels) ? row.detected_channels : []),
        ...(Array.isArray(channelMetadata.channel_candidates) ? channelMetadata.channel_candidates : []),
        ...servers.map((server: any) => server.detected_channel),
      ]);
      const primaryChannel = String(
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        row.primary_channel || channelMetadata.primary_channel || detectedChannels[0] || "",
      ).trim();
      // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
      const ocrTexts = dedupe([
        ...(Array.isArray(channelMetadata.ocr_texts) ? channelMetadata.ocr_texts : []),
        ...servers.map((server: any) => server.ocr_text),
      ]);
      const firstChannelServer = servers.find((server: any) =>
        server.channel_detection_method || server.channel_confidence,
      );
      return {
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        key: `${row.url || "extraction"}-${index}`,
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        url: String(row.url || "").trim(),
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        agent_type: String(row.agent_type || row.page_type || "agent").trim(),
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        page_type: String(row.page_type || "").trim(),
        // @ts-expect-error -- strict migration: suppress for T43 batch (cast to any)
        status: String(row.status || "unknown").trim(),
        primary_channel: primaryChannel,
        detected_channels: detectedChannels,
        channel_confidence: String(
          channelMetadata.channel_confidence || firstChannelServer?.channel_confidence || "",
        ).trim(),
        channel_detection_method: String(
          channelMetadata.channel_detection_method || firstChannelServer?.channel_detection_method || "",
        ).trim(),
        ocr_texts: ocrTexts,
        server_count: servers.length,
        stream_count: sampleStreams.length,
        screenshot_count: screenshots.length,
        network_diagnostics_count: servers.reduce(
          (total: any, server: any) => total + Number(server.network_diagnostics_count || 0),
          0,
        ),
        iframe_diagnostics_count: servers.reduce(
          (total: any, server: any) => total + Number(server.iframe_diagnostics_count || 0),
          0,
        ),
        sample_streams: sampleStreams.slice(0, 8),
        sample_screenshots: screenshots.slice(0, 4),
        servers,
      };
    });
}

function BarTooltip({  active, payload, label  }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-[12px] shadow-md">
      <p className="font-medium text-foreground">{label}</p>
      <p className="text-muted-foreground">{formatNumber(payload[0]?.value)} URLs</p>
    </div>
  );
}

function PieTooltip({  active, payload  }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-[12px] shadow-md">
      <p className="font-medium text-foreground">{payload[0]?.name}</p>
      <p className="text-muted-foreground">{formatNumber(payload[0]?.value)} URLs</p>
    </div>
  );
}

function ProviderBarChart({  rows = [], color = "var(--signal)"  }: any) {
  const data = rows.slice(0, 10).map((row: any) => ({
    name: row.provider || "--",
    count: Number(row.count || 0),
  }));
  if (!data.length) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">No data</div>;
  }
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

function CountryPieChart({  rows = []  }: any) {
  const data = rows.slice(0, 7).map((row: any, index: any) => ({
    name: `${row.flag || ""} ${row.country_code || row.country || "--"}`.trim(),
    value: Number(row.count || 0),
    color: CHART_COLORS[index % CHART_COLORS.length],
  }));
  if (!data.length) {
    return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">No country data</div>;
  }
  return (
    <div className="flex items-center gap-5">
      <ResponsiveContainer width={160} height={160}>
        <PieChart>
          <Pie data={data} cx="50%" cy="50%" innerRadius={44} outerRadius={72} paddingAngle={3} dataKey="value">
            {data.map((entry: any) => <Cell key={entry.name} fill={entry.color} />)}
          </Pie>
          <Tooltip content={<PieTooltip />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="min-w-0 flex-1 space-y-1.5">
        {data.map((entry: any) => (
          <div key={entry.name} className="flex items-center gap-2 text-[12px]">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: entry.color }} />
            <span className="truncate text-foreground">{entry.name}</span>
            <span className="ml-auto font-mono text-[11px] tabular-nums text-muted-foreground">{formatNumber(entry.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatCard({  label, value, color  }: any) {
  return (
    <Card>
      <CardContent className="px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">{label}</p>
        <p className="mt-1 text-xl font-semibold tabular-nums" style={{ color }}>{value}</p>
      </CardContent>
    </Card>
  );
}

export function StreamProviderTab({ 
  runId,
  runUrl,
  streamUrls = [],
  providerAnalysis = [],
  extractionResults = [],
 }: any) {
  const [data, setData] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasRun, setHasRun] = useState(false);

  const persistedPayload = useMemo(
    () => buildProviderPayload(providerAnalysis, "persisted"),
    [providerAnalysis],
  );
  const evidenceRows = useMemo(
    () => summarizeExtractionResults(extractionResults),
    [extractionResults],
  );
  const evidenceSummary = useMemo(
    () => ({
      extraction_count: evidenceRows.length,
      stream_count: evidenceRows.reduce((total, row) => total + Number(row.stream_count || 0), 0),
      screenshot_count: evidenceRows.reduce((total, row) => total + Number(row.screenshot_count || 0), 0),
      channel_count: new Set(
        evidenceRows.flatMap((row) => [row.primary_channel, ...(row.detected_channels || [])]).filter(Boolean),
      ).size,
      ocr_count: evidenceRows.reduce((total, row) => total + Number(row.ocr_texts?.length || 0), 0),
      network_diagnostics_count: evidenceRows.reduce(
        (total, row) => total + Number(row.network_diagnostics_count || 0),
        0,
      ),
      iframe_diagnostics_count: evidenceRows.reduce(
        (total, row) => total + Number(row.iframe_diagnostics_count || 0),
        0,
      ),
    }),
    [evidenceRows],
  );

  async function runLookup(urls: any) {
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
      setData({
        ...payload,
        rows: normalizeProviderRows(payload?.rows || []),
        source: "live_lookup",
      });
    } catch (nextError: any) {
      setError(nextError.message || "Provider lookup failed");
    } finally {
      setIsLoading(false);
      setHasRun(true);
    }
  }

  useEffect(() => {
    if (persistedPayload.rows.length) {
      setData(persistedPayload);
      setHasRun(true);
      return;
    }
    const urls = Array.isArray(streamUrls) ? streamUrls.filter(Boolean) : [];
    if (!urls.length) {
      setData(null);
      setHasRun(true);
      return;
    }
    runLookup(urls);
  }, [persistedPayload, runId, runUrl, streamUrls]); // eslint-disable-line react-hooks/exhaustive-deps

  const stats = data?.stats || {};
  const rows = data?.rows || [];
  const topProviders = data?.top_providers || [];
  const topCountries = data?.top_countries || [];
  const hasLookupUrls = Array.isArray(streamUrls) && streamUrls.length > 0;
  const usingPersistedIntel = data?.source === "persisted";

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
        <p className="text-sm text-muted-foreground">Resolving stream URLs...</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Provider intelligence</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {usingPersistedIntel
              ? "Using the provider intel persisted by the orchestrator for this run."
              : hasLookupUrls
                ? `Resolved from detected stream URLs (${formatNumber(streamUrls.length)} candidates).`
                : "No run URLs available for provider resolution yet."}
          </p>
        </div>
        {hasLookupUrls ? (
          <Button variant="outline" size="sm" onClick={() => runLookup(streamUrls)} disabled={isLoading}>
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

      {evidenceSummary.extraction_count > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader className="border-b px-4 py-3">
            <div className="flex flex-wrap items-start gap-3">
              <div>
                <CardTitle className="text-sm">Agent networking evidence</CardTitle>
                <CardDescription>
                  What hosting and embedded agents returned before orchestrator provider resolution.
                </CardDescription>
              </div>
              <div className="ml-auto flex flex-wrap gap-2">
                <Badge tone="signal" className="font-mono text-[10px]">
                  streams {evidenceSummary.stream_count}
                </Badge>
                <Badge tone="default" className="font-mono text-[10px]">
                  screenshots {evidenceSummary.screenshot_count}
                </Badge>
                <Badge tone={evidenceSummary.channel_count ? "signal" : "default"} className="font-mono text-[10px]">
                  channels {evidenceSummary.channel_count}
                </Badge>
                <Badge tone={evidenceSummary.ocr_count ? "signal" : "default"} className="font-mono text-[10px]">
                  OCR {evidenceSummary.ocr_count}
                </Badge>
                <Badge tone="default" className="font-mono text-[10px]">
                  network hits {evidenceSummary.network_diagnostics_count}
                </Badge>
                <Badge tone="default" className="font-mono text-[10px]">
                  iframe hits {evidenceSummary.iframe_diagnostics_count}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 px-4 py-4">
            {evidenceRows.map((row) => (
              <div key={row.key} className="rounded-xl border border-border bg-muted/10 p-3">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-primary">
                        {row.agent_type || row.page_type || "agent"}
                      </span>
                      <Badge tone="default" className="font-mono text-[10px]">
                        {row.status || "unknown"}
                      </Badge>
                    </div>
                    <div className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {row.url || "--"}
                    </div>
                    {row.primary_channel || row.detected_channels.length || row.channel_detection_method || row.ocr_texts.length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {row.primary_channel ? (
                          <Badge tone="signal" className="font-mono text-[10px]">
                            channel {row.primary_channel}
                          </Badge>
                        ) : null}
                        {row.channel_confidence ? (
                          <Badge tone="default" className="font-mono text-[10px]">
                            confidence {row.channel_confidence}
                          </Badge>
                        ) : null}
                        {row.channel_detection_method ? (
                          <Badge tone="default" className="font-mono text-[10px]">
                            method {row.channel_detection_method}
                          </Badge>
                        ) : null}
                        {row.ocr_texts.length ? (
                          <Badge tone="default" className="font-mono text-[10px]">
                            OCR text {row.ocr_texts.length}
                          </Badge>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Badge tone="signal" className="font-mono text-[10px]">
                      streams {row.stream_count}
                    </Badge>
                    <Badge tone="default" className="font-mono text-[10px]">
                      servers {row.server_count}
                    </Badge>
                    <Badge tone="default" className="font-mono text-[10px]">
                      screenshots {row.screenshot_count}
                    </Badge>
                  </div>
                </div>

                {row.sample_streams.length ? (
                  <div className="mt-3 rounded-lg border border-border bg-card px-3 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
                      Sample streams
                    </div>
                    <div className="mt-1 space-y-1 font-mono text-[11px] text-foreground/80">
                      {row.sample_streams.map((streamUrl) => (
                        <div key={streamUrl} className="break-all">
                          {streamUrl}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {row.servers.length ? (
                  <div className="mt-3 grid gap-2 lg:grid-cols-2">
                    {row.servers.map((server: any) => (
                      <div key={`${row.key}-${server.label}`} className="rounded-lg border border-border bg-card px-3 py-2.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <Server className="h-3.5 w-3.5 text-primary" />
                          <span className="text-[12px] font-medium">{server.label}</span>
                          <Badge tone={server.status === "success" ? "success" : "default"} className="ml-auto font-mono text-[10px]">
                            {server.status || "unknown"}
                          </Badge>
                        </div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px]">
                            player {server.player_state || "--"}
                          </div>
                          <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px]">
                            streams {server.stream_urls.length}
                          </div>
                          <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px]">
                            network {server.network_diagnostics_count}
                          </div>
                          <div className="rounded-md border border-border/70 bg-muted/20 px-2.5 py-2 text-[11px]">
                            iframe {server.iframe_diagnostics_count}
                          </div>
                        </div>
                        {server.screenshot_url ? (
                          <div className="mt-2 break-all font-mono text-[10.5px] text-muted-foreground">
                            screenshot {server.screenshot_url}
                          </div>
                        ) : null}
                        {server.detected_channel || server.channel_detection_method || server.channel_confidence ? (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {server.detected_channel ? (
                              <Badge tone="signal" className="font-mono text-[10px]">
                                channel {server.detected_channel}
                              </Badge>
                            ) : null}
                            {server.channel_confidence ? (
                              <Badge tone="default" className="font-mono text-[10px]">
                                {server.channel_confidence}
                              </Badge>
                            ) : null}
                            {server.channel_detection_method ? (
                              <Badge tone="default" className="font-mono text-[10px]">
                                {server.channel_detection_method}
                              </Badge>
                            ) : null}
                          </div>
                        ) : null}
                        {server.channel_candidates.length ? (
                          <div className="mt-2 text-[10.5px] text-muted-foreground">
                            candidates {server.channel_candidates.join(", ")}
                          </div>
                        ) : null}
                        {server.ocr_text ? (
                          <div className="mt-2 rounded-md border border-border/70 bg-muted/20 px-2.5 py-2">
                            <div className="text-[9.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
                              OCR / visual text
                            </div>
                            <div className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-foreground/80">
                              {server.ocr_text}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

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
                  <CardDescription>From resolved IP geolocation and Whois data</CardDescription>
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

      {rows.length > 0 ? (
        <Card className="overflow-hidden">
          <CardHeader className="flex-row items-center justify-between space-y-0 border-b px-4 py-3">
            <div>
              <CardTitle className="text-sm">Resolution results</CardTitle>
              <CardDescription className="mt-0.5 text-[12px]">
                Persisted orchestrator provider rows when available, with live re-resolution as fallback.
              </CardDescription>
            </div>
            <Badge tone="default" className="font-mono text-[10px]">{rows.length} entries</Badge>
          </CardHeader>
          <div className="overflow-x-auto">
            <Table className="min-w-full text-[12px]">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {["URL", "IP", "Provider", "Org", "Country", "Abuse contact", "Whois"].map((heading) => (
                    <TableHead key={heading} className="whitespace-nowrap px-4 py-2.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60">
                      {heading}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row: any, index: any) => (
                  <TableRow key={`${row.stream_url || row.url}-${index}`}>
                    <TableCell className="max-w-[220px] truncate px-4 py-2.5 font-mono text-[11px] text-sky-500" title={row.stream_url || row.url}>
                      {(row.stream_url || row.url || "--").replace(/^https?:\/\//, "")}
                    </TableCell>
                    <TableCell className="px-4 py-2.5 font-mono text-[11.5px]">{row.ip || "--"}</TableCell>
                    <TableCell className="px-4 py-2.5 text-[12px]">{row.provider || "--"}</TableCell>
                    <TableCell className="px-4 py-2.5 text-[12px] text-muted-foreground">{row.org || "--"}</TableCell>
                    <TableCell className="px-4 py-2.5 text-[12px]">
                      <span className="inline-flex items-center gap-1.5">
                        <span>{row.flag || "--"}</span>
                        <span className="text-muted-foreground">{row.country_code || row.country || "--"}</span>
                      </span>
                    </TableCell>
                    <TableCell className={`px-4 py-2.5 font-mono text-[11px] ${row.abuse_email ? "text-primary" : "text-muted-foreground/40"}`}>
                      {row.abuse_email || "--"}
                    </TableCell>
                    <TableCell className="px-4 py-2.5">
                      {row.whois_raw ? (
                        <details className="max-w-[240px]">
                          <summary className="cursor-pointer text-[11px] font-medium text-foreground/80">
                            View whois
                          </summary>
                          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/20 p-2 font-mono text-[10px] text-muted-foreground">
                            {row.whois_raw}
                          </pre>
                        </details>
                      ) : (
                        <span className="text-[11px] text-muted-foreground/40">--</span>
                      )}
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
            {evidenceSummary.extraction_count > 0 ? (
              <Shield className="h-7 w-7 opacity-30" />
            ) : (
              <Globe className="h-7 w-7 opacity-30" />
            )}
            <p className="text-sm">
              {evidenceSummary.extraction_count > 0
                ? "Agent evidence was captured, but no provider rows were persisted for this run yet."
                : "No resolution data for this run yet."}
            </p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}