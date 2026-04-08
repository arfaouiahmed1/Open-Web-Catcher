"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Search } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { KpiCard } from "@/components/kpi-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const SAMPLE = `https://cdn.example.com/live/master.m3u8\nhttps://edge.example.net/channel/index.m3u8`;

export default function ProvidersPage() {
  const [urlsText, setUrlsText]     = useState(SAMPLE);
  const [result, setResult]         = useState(null);
  const [history, setHistory]       = useState({ rows: [], summary: {}, top_providers: [], top_countries: [] });
  const [error, setError]           = useState("");
  const [isLoading, setIsLoading]   = useState(false);

  async function loadHistory() {
    const payload = await apiFetch("/ui/providers/history?limit=25&offset=0");
    setHistory(payload);
  }

  useEffect(() => { loadHistory().catch((e) => setError(e.message)); }, []);

  async function runLookup() {
    setIsLoading(true);
    setError("");
    try {
      const streamUrls = urlsText.split(/\r?\n/).map((u) => u.trim()).filter(Boolean);
      const res = await fetch(apiUrl("/ui/providers/lookup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stream_urls: streamUrls }),
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.detail || `Status ${res.status}`);
      setResult(payload);
      await loadHistory();
    } catch (e) {
      setError(e.message || "Provider lookup failed");
      setResult(null);
    } finally {
      setIsLoading(false);
    }
  }

  const stats = result?.stats || history.summary || {};
  const kpis = [
    { label: "Checked URLs",      value: formatNumber(stats.total_urls || stats.total_checks || 0),   description: "Stream URLs inspected" },
    { label: "Resolved IPs",      value: formatNumber(stats.resolved_ips || 0),                        description: "URLs with a routable IP" },
    { label: "Provider matches",  value: formatNumber(stats.provider_matches || 0),                    description: "Identified org/provider" },
    { label: "Abuse contacts",    value: formatNumber(stats.abuse_contacts_found || 0),                description: "Abuse email found" },
  ];

  return (
    <div className="space-y-6">

      {/* header */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-spark">Provider Intel</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">Stream URL intelligence</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Resolve m3u8 / mpd stream URLs to their IP, hosting provider, geo, and abuse contacts.
        </p>
      </div>

      {/* kpis */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => <KpiCard key={k.label} {...k} />)}
      </div>

      {/* lookup card */}
      <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-spark" />
          <span className="text-sm font-semibold text-white">Lookup batch</span>
          <span className="ml-2 text-xs text-slate-600">One URL per line</span>
        </div>
        <Textarea
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
          className="min-h-[120px]"
          placeholder="https://cdn.example.com/live/master.m3u8"
        />
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-ember/30 bg-ember/10 px-3 py-2.5 text-sm text-ember">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="accent" onClick={runLookup} disabled={isLoading}>
            {isLoading ? "Resolving…" : "Run lookup"}
          </Button>
          <Button variant="ghost" onClick={loadHistory} className="border border-white/10">
            Refresh history
          </Button>
        </div>
      </div>

      {/* results */}
      {result && (
        <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
          <DataTable
            title="Lookup results"
            description="Resolved URLs from the last batch"
            columns={["stream_url","hostname","ip","provider","org","country","region","abuse_email"]}
            rows={result.rows || []}
          />
          <JsonViewer label="Batch JSON" value={result} />
        </div>
      )}

      {/* history */}
      <div className="grid gap-5 xl:grid-cols-2">
        <DataTable
          title="Top providers"
          description="Provider frequency across all lookups"
          columns={["provider","count"]}
          rows={history.top_providers || []}
        />
        <DataTable
          title="Top countries"
          description="Geo distribution across all lookups"
          columns={["country","count"]}
          rows={history.top_countries || []}
        />
      </div>

      <DataTable
        title="Lookup history"
        description="All checked stream URLs from the console"
        columns={["created_at","lookup_id","stream_url","provider","country","abuse_email","ip"]}
        rows={history.rows || []}
      />

    </div>
  );
}
