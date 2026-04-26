"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Globe, Search, Server, Shield, Wifi } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatNumber } from "@/lib/utils";
import { KpiCard } from "@/components/kpi-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

const SAMPLE = `https://cdn.example.com/live/master.m3u8\nhttps://edge.example.net/channel/index.m3u8`;

/* ── Bar chart ── */
function BarChart({ rows, valueKey = "count", labelKey = "provider", color = "var(--signal)", maxBars = 10, title, emptyMsg = "No data" }) {
  const visible = (rows || []).slice(0, maxBars);
  if (!visible.length) {
    return (
      <div className="flex h-32 items-center justify-center text-[12.5px]" style={{ color: "var(--mute)" }}>{emptyMsg}</div>
    );
  }
  const max = Math.max(...visible.map((r) => Number(r[valueKey] || 0)), 1);
  return (
    <div className="space-y-2">
      {title && <div className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-2)" }}>{title}</div>}
      {visible.map((row, idx) => {
        const val = Number(row[valueKey] || 0);
        const pct = (val / max) * 100;
        return (
          <div key={`${row[labelKey]}-${idx}`} className="flex items-center gap-3">
            <div className="w-28 shrink-0 truncate text-right text-[12px]" style={{ color: "var(--ink-dim)" }} title={row[labelKey]}>
              {row[labelKey] || "—"}
            </div>
            <div className="relative flex-1 overflow-hidden rounded-full" style={{ height: 8, background: "var(--line)" }}>
              <div
                className="absolute inset-y-0 left-0 rounded-full"
                style={{
                  width: `${pct}%`,
                  background: color,
                  boxShadow: `0 0 8px color-mix(in oklch, ${color} 40%, transparent)`,
                  transition: "width 500ms cubic-bezier(0.4,0,0.2,1)",
                }}
              />
            </div>
            <div className="w-10 shrink-0 font-mono text-[11px] tabular-nums" style={{ color: "var(--mute)" }}>{val}</div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Mini stat ── */
function StatBadge({ label, value, color }) {
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border px-3 py-2.5" style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.15)" }}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: "var(--mute-2)" }}>{label}</span>
      <span className="text-[18px] font-semibold tabular-nums" style={{ color: color || "var(--ink)" }}>{value}</span>
    </div>
  );
}

/* ── Result row ── */
function LookupRow({ row, even }) {
  return (
    <tr style={{ background: even ? "rgba(255,255,255,0.012)" : "transparent" }}>
      <td className="px-4 py-2.5 font-mono text-[11px] max-w-[220px] truncate" style={{ color: "var(--sky)" }} title={row.stream_url}>
        {row.stream_url?.replace(/^https?:\/\//, "")}
      </td>
      <td className="px-4 py-2.5 font-mono text-[11.5px]" style={{ color: "var(--ink-dim)" }}>{row.ip || "—"}</td>
      <td className="px-4 py-2.5 text-[12px]" style={{ color: "var(--ink-dim)" }}>{row.provider || "—"}</td>
      <td className="px-4 py-2.5 text-[12px]" style={{ color: "var(--mute)" }}>{row.org || "—"}</td>
      <td className="px-4 py-2.5 text-[12px]" style={{ color: "var(--mute)" }}>{row.country || "—"}</td>
      <td className="px-4 py-2.5 text-[11.5px] font-mono" style={{ color: row.abuse_email ? "var(--signal)" : "var(--mute-3)" }}>
        {row.abuse_email || "—"}
      </td>
    </tr>
  );
}

export default function ProvidersPage() {
  const [urlsText, setUrlsText]   = useState(SAMPLE);
  const [result, setResult]       = useState(null);
  const [history, setHistory]     = useState({ rows: [], summary: {}, top_providers: [], top_countries: [] });
  const [error, setError]         = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function loadHistory() {
    const payload = await apiFetch("/ui/providers/history?limit=50&offset=0");
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
    { label: "Checked URLs",     value: formatNumber(stats.total_urls || stats.total_checks || 0), description: "Stream URLs inspected",         accent: "signal", icon: Wifi },
    { label: "Resolved IPs",     value: formatNumber(stats.resolved_ips || 0),                     description: "URLs with a routable IP",        accent: "mint",   icon: Server },
    { label: "Provider matches", value: formatNumber(stats.provider_matches || 0),                 description: "Identified org / hosting",       accent: "sky",    icon: Globe },
    { label: "Abuse contacts",   value: formatNumber(stats.abuse_contacts_found || 0),             description: "Abuse email found",              accent: "rose",   icon: Shield },
  ];

  const displayRows = result?.rows || history.rows || [];
  const topProviders = result?.top_providers || history.top_providers || [];
  const topCountries = result?.top_countries || history.top_countries || [];

  const resolveRate = stats.total_urls
    ? Math.round(((stats.resolved_ips || 0) / stats.total_urls) * 100)
    : 0;
  const matchRate = stats.total_urls
    ? Math.round(((stats.provider_matches || 0) / stats.total_urls) * 100)
    : 0;

  return (
    <div className="space-y-6">

      {/* page header */}
      <div>
        <span className="owc-eyebrow">provider intel · stream resolution</span>
        <h1 className="mt-2 text-3xl font-semibold text-[var(--ink)]">
          Stream URL Intelligence
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          Resolve m3u8 / mpd stream URLs to IP, ASN, hosting provider, geo, and abuse contacts. Visualize CDN distribution across your dataset.
        </p>
      </div>

      {/* kpis */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map((k) => <KpiCard key={k.label} {...k} />)}
      </div>

      {/* Resolve rate summary */}
      {stats.total_urls > 0 && (
        <div
          className="grid gap-3 sm:grid-cols-4 rounded-[14px] border p-4"
          style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
        >
          <StatBadge label="Resolve rate" value={`${resolveRate}%`} color={resolveRate > 80 ? "var(--mint)" : resolveRate > 50 ? "var(--signal)" : "var(--rose)"} />
          <StatBadge label="Provider match rate" value={`${matchRate}%`} color={matchRate > 60 ? "var(--mint)" : "var(--signal)"} />
          <StatBadge label="Unique providers" value={formatNumber(topProviders.length)} color="var(--sky)" />
          <StatBadge label="Countries" value={formatNumber(topCountries.length)} color="var(--violet)" />
        </div>
      )}

      {/* lookup card */}
      <div
        className="rounded-[14px] border p-4 space-y-3"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        <div className="flex items-center gap-2">
          <Search className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
          <span className="text-[13.5px] font-medium text-[var(--ink)]">Batch lookup</span>
          <span className="ml-2 rounded-full border px-2 py-0.5 font-mono text-[10.5px]" style={{ borderColor: "var(--line)", color: "var(--mute)" }}>
            one URL per line
          </span>
        </div>
        <Textarea
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
          className="min-h-[120px]"
          placeholder="https://cdn.example.com/live/master.m3u8"
          mono
        />
        {error && (
          <div
            className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[13px]"
            style={{ borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)", background: "color-mix(in oklch, var(--rose) 10%, transparent)", color: "var(--rose)" }}
          >
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {error}
          </div>
        )}
        <div className="flex gap-2">
          <Button variant="accent" onClick={runLookup} disabled={isLoading}>
            {isLoading ? <><span className="owc-spinner owc-spinner-sm" />Resolving…</> : "Run lookup"}
          </Button>
          <Button variant="ghost" onClick={loadHistory} className="border border-[var(--line)]">
            Refresh history
          </Button>
        </div>
      </div>

      {/* Distribution charts */}
      {(topProviders.length > 0 || topCountries.length > 0) && (
        <div className="grid gap-5 xl:grid-cols-2">
          <div
            className="rounded-[14px] border p-4 space-y-4"
            style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13.5px] font-medium text-[var(--ink)]">Provider distribution</div>
                <div className="mt-0.5 text-[12px]" style={{ color: "var(--mute)" }}>Hosting / CDN frequency across all checked URLs</div>
              </div>
              <span className="font-mono text-[11px]" style={{ color: "var(--mute)" }}>{topProviders.length} providers</span>
            </div>
            <BarChart rows={topProviders} valueKey="count" labelKey="provider" color="var(--signal)" maxBars={12} />
          </div>

          <div
            className="rounded-[14px] border p-4 space-y-4"
            style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13.5px] font-medium text-[var(--ink)]">Geographic distribution</div>
                <div className="mt-0.5 text-[12px]" style={{ color: "var(--mute)" }}>Country frequency across resolved IPs</div>
              </div>
              <span className="font-mono text-[11px]" style={{ color: "var(--mute)" }}>{topCountries.length} countries</span>
            </div>
            <BarChart rows={topCountries} valueKey="count" labelKey="country" color="var(--sky)" maxBars={12} />
          </div>
        </div>
      )}

      {/* results table */}
      {displayRows.length > 0 && (
        <div
          className="rounded-[14px] border overflow-hidden"
          style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
        >
          <div className="flex items-center justify-between border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
            <div>
              <span className="text-[13.5px] font-medium text-[var(--ink)]">
                {result ? "Latest batch results" : "Lookup history"}
              </span>
              <span className="ml-3 font-mono text-[11px]" style={{ color: "var(--mute)" }}>{displayRows.length} entries</span>
            </div>
            {result && (
              <button
                type="button"
                onClick={() => setResult(null)}
                className="text-[11.5px] transition-colors"
                style={{ color: "var(--mute)" }}
              >
                Show history
              </button>
            )}
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-[12.5px]">
              <thead>
                <tr className="border-b" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.012)" }}>
                  {["URL", "IP", "Provider", "Org", "Country", "Abuse contact"].map((h) => (
                    <th key={h} className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.12em] whitespace-nowrap" style={{ color: "var(--mute)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayRows.map((row, idx) => (
                  <LookupRow key={`${row.stream_url}-${idx}`} row={row} even={idx % 2 === 0} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {displayRows.length === 0 && !isLoading && (
        <div
          className="flex flex-col items-center gap-3 rounded-[14px] border py-16"
          style={{ borderColor: "var(--line)", background: "var(--card)", color: "var(--mute)" }}
        >
          <Wifi className="h-8 w-8 opacity-30" />
          <div className="text-[13px]">Paste stream URLs above and run a lookup to see results here.</div>
        </div>
      )}
    </div>
  );
}
