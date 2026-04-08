"use client";

import { useEffect, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { KpiCard } from "@/components/kpi-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

const SAMPLE_URLS = `https://cdn.example.com/live/master.m3u8
https://edge.example.net/channel/index.m3u8`;

export default function ProvidersPage() {
  const [urlsValue, setUrlsValue] = useState(SAMPLE_URLS);
  const [resultRows, setResultRows] = useState([]);
  const [resultStats, setResultStats] = useState({});
  const [history, setHistory] = useState({ rows: [], summary: {}, top_providers: [], top_countries: [] });
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function loadHistory() {
    const payload = await apiFetch("/ui/providers/history?limit=25&offset=0");
    setHistory(payload);
  }

  useEffect(() => {
    loadHistory().catch((loadError) => {
      setError(loadError.message || "Failed to load provider lookup history.");
    });
  }, []);

  async function runLookup() {
    setIsLoading(true);
    setError("");
    try {
      const streamUrls = urlsValue
        .split(/\r?\n/)
        .map((item) => item.trim())
        .filter(Boolean);
      const response = await fetch(apiUrl("/ui/providers/lookup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream_urls: streamUrls })
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.detail || `Lookup failed with ${response.status}`);
      }
      setResultRows(payload.rows || []);
      setResultStats(payload.stats || {});
      await loadHistory();
    } catch (lookupError) {
      setError(lookupError.message || "Provider lookup failed.");
      setResultRows([]);
      setResultStats({});
    } finally {
      setIsLoading(false);
    }
  }

  const stats = resultRows.length ? resultStats : history.summary || {};
  const statCards = [
    {
      label: "Checked URLs",
      value: formatNumber(stats.total_urls || stats.total_checks || 0),
      description: "Stream URLs inspected through the provider-intel surface.",
      accent: "from-signal/20 to-transparent"
    },
    {
      label: "Resolved IPs",
      value: formatNumber(stats.resolved_ips || 0),
      description: "URLs that resolved to a routable IP address.",
      accent: "from-surge/20 to-transparent"
    },
    {
      label: "Provider Matches",
      value: formatNumber(stats.provider_matches || 0),
      description: "Rows with an identified org/provider mapping.",
      accent: "from-spark/20 to-transparent"
    },
    {
      label: "Abuse Contacts",
      value: formatNumber(stats.abuse_contacts_found || 0),
      description: "Rows where an abuse contact email was found.",
      accent: "from-orange-500/20 to-transparent"
    }
  ];

  return (
    <div className="space-y-6">
      <section className="max-w-4xl">
        <div className="text-xs uppercase tracking-[0.4em] text-spark">Provider Intel</div>
        <h1 className="mt-3 text-4xl font-semibold">Test m3u8s against IP and provider intelligence</h1>
        <p className="mt-4 text-base leading-7 text-slate-300">
          Paste stream URLs, resolve their IP and host facts, inspect provider and abuse-contact data, and compare the latest lookup batch against persisted lookup history.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {statCards.map((item) => (
          <KpiCard key={item.label} {...item} />
        ))}
      </section>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Lookup Batch</CardTitle>
            <CardDescription>One URL per line. Best for `m3u8`, `mpd`, and direct media URLs.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            value={urlsValue}
            onChange={(event) => setUrlsValue(event.target.value)}
            className="min-h-[180px]"
          />
          {error ? <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">{error}</div> : null}
          <div className="flex flex-wrap gap-3">
            <Button variant="accent" onClick={runLookup} disabled={isLoading}>
              {isLoading ? "Inspecting..." : "Run Provider Lookup"}
            </Button>
            <Button variant="secondary" onClick={loadHistory}>
              Refresh History
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)]">
        <DataTable
          title="Lookup Results"
          description="Latest checked URLs with resolved host, provider, and abuse-contact details."
          columns={["stream_url", "hostname", "ip", "provider", "org", "country", "region", "city", "abuse_email", "lookup_id", "created_at"]}
          rows={resultRows}
        />
        <JsonViewer label="Latest Batch JSON" value={{ rows: resultRows, stats: resultStats }} />
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <DataTable
          title="Top Providers"
          description="Persisted provider frequency across all console lookups."
          columns={["provider", "count"]}
          rows={history.top_providers || []}
        />
        <DataTable
          title="Top Countries"
          description="Persisted geo distribution across all console lookups."
          columns={["country", "count"]}
          rows={history.top_countries || []}
        />
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <DataTable
          title="Lookup History"
          description="DB-backed lookup history with one row per checked stream URL."
          columns={["created_at", "lookup_id", "stream_url", "provider", "country", "abuse_email", "ip"]}
          rows={history.rows || []}
        />
        <JsonViewer label="Historical Summary" value={history.summary || {}} />
      </section>
    </div>
  );
}
