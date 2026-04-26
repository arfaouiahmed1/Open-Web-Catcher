"use client";

import { useEffect, useState, useCallback } from "react";
import {
  BarChart3,
  Check,
  ChevronDown,
  Database,
  Filter,
  Loader2,
  Play,
  RefreshCw,
  Tag,
  X,
} from "lucide-react";
import { apiFetch } from "@/lib/api";
import { formatPercent } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const LANG_COLORS = {
  arabic:     "var(--violet)",
  english:    "var(--signal)",
  spanish:    "var(--mint)",
  french:     "var(--sky)",
  portuguese: "var(--amber, #f59e0b)",
  other:      "var(--mute-2)",
  "":         "var(--mute-3)",
};

function LangBadge({ lang }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        color: LANG_COLORS[lang] || LANG_COLORS[""],
        background: `color-mix(in oklch, ${LANG_COLORS[lang] || LANG_COLORS[""]} 14%, transparent)`,
      }}
    >
      {lang || "unlabeled"}
    </span>
  );
}

function SuccessBar({ rate, total }) {
  if (!total) return <span className="text-[11px]" style={{ color: "var(--mute-3)" }}>no runs</span>;
  const color = rate >= 80 ? "var(--mint)" : rate >= 50 ? "var(--signal)" : "var(--rose)";
  return (
    <div className="flex items-center gap-2">
      <div className="w-20 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
        <div className="h-full rounded-full" style={{ width: `${rate}%`, background: color }} />
      </div>
      <span className="text-[11px] font-mono" style={{ color }}>{rate.toFixed(1)}%</span>
    </div>
  );
}

export default function DatasetsPage() {
  const [meta, setMeta]       = useState({ languages: [], labels: [] });
  const [stats, setStats]     = useState(null);
  const [sites, setSites]     = useState([]);
  const [total, setTotal]     = useState(0);
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage]       = useState(0);

  // Filters
  const [filterLang,  setFilterLang]  = useState("");
  const [filterLabel, setFilterLabel] = useState("");

  // Batch test state
  const [batchLang,   setBatchLang]   = useState("");
  const [batchLabel,  setBatchLabel]  = useState("");
  const [batchLimit,  setBatchLimit]  = useState(20);
  const [batchUrls,   setBatchUrls]   = useState("");  // newline-separated custom URLs
  const [testing,     setTesting]     = useState(false);
  const [testProg,    setTestProg]    = useState(0);
  const [testTotal,   setTestTotal]   = useState(0);

  // Selection for bulk label
  const [selected, setSelected] = useState(new Set());
  const [bulkLang, setBulkLang] = useState("");

  const PAGE_SIZE = 50;

  const loadMeta = useCallback(async () => {
    const m = await apiFetch("/api/datasets/meta");
    setMeta(m);
  }, []);

  const loadStats = useCallback(async () => {
    const s = await apiFetch("/api/datasets/sites/stats");
    setStats(s);
  }, []);

  const loadSites = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        offset: page * PAGE_SIZE,
        limit: PAGE_SIZE,
        ...(filterLang  ? { language: filterLang }  : {}),
        ...(filterLabel ? { label:    filterLabel }  : {}),
      });
      const data = await apiFetch(`/api/datasets/sites?${params}`);
      setSites(data.sites || []);
      setTotal(data.total || 0);
    } finally {
      setLoading(false);
    }
  }, [page, filterLang, filterLabel]);

  const loadResults = useCallback(async () => {
    const r = await apiFetch("/api/datasets/results");
    setResults(r);
  }, []);

  useEffect(() => {
    loadMeta();
    loadStats();
    loadResults();
  }, [loadMeta, loadStats, loadResults]);

  useEffect(() => {
    setPage(0);
  }, [filterLang, filterLabel]);

  useEffect(() => {
    loadSites();
  }, [loadSites]);

  const handleLabelSite = async (siteId, language) => {
    await apiFetch(`/api/datasets/sites/${siteId}`, {
      method: "PATCH",
      body: JSON.stringify({ language }),
    });
    setSites((prev) => prev.map((s) => s.id == siteId ? { ...s, language } : s));
    loadStats();
  };

  const handleBulkLabel = async () => {
    if (!bulkLang || selected.size === 0) return;
    await apiFetch("/api/datasets/sites/bulk-update", {
      method: "POST",
      body: JSON.stringify({ ids: [...selected].map(Number), language: bulkLang }),
    });
    setSelected(new Set());
    setBulkLang("");
    loadSites();
    loadStats();
  };

  const toggleSelect = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleRunBatch = async () => {
    // Build URL list from either custom input or filtered sites
    let urls = [];
    if (batchUrls.trim()) {
      urls = batchUrls.split("\n").map((u) => u.trim()).filter(Boolean);
    } else {
      const params = new URLSearchParams({
        limit: batchLimit,
        ...(batchLang  ? { language: batchLang }  : {}),
        ...(batchLabel ? { label:    batchLabel }  : {}),
      });
      const data = await apiFetch(`/api/datasets/sites?${params}`);
      urls = (data.sites || []).map((s) => s.url);
    }

    if (!urls.length) return;
    setTesting(true);
    setTestProg(0);
    setTestTotal(urls.length);

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        // Trigger a real run via the pipeline
        const res = await apiFetch("/run", {
          method: "POST",
          body: JSON.stringify({ url }),
        });
        const success = res?.final_status === "success" || res?.metrics?.success;
        // Find matching site for its lang/label
        const matchSite = sites.find((s) => s.url === url);
        await apiFetch(
          `/api/datasets/results/record?url=${encodeURIComponent(url)}&success=${!!success}` +
          `&language=${encodeURIComponent(matchSite?.language || batchLang || "")}` +
          `&label=${encodeURIComponent(matchSite?.label || batchLabel || "")}`,
          { method: "POST" }
        );
      } catch {
        // Record failure
        await apiFetch(
          `/api/datasets/results/record?url=${encodeURIComponent(url)}&success=false` +
          `&language=${encodeURIComponent(batchLang || "")}` +
          `&label=${encodeURIComponent(batchLabel || "")}`,
          { method: "POST" }
        ).catch(() => {});
      }
      setTestProg(i + 1);
    }

    setTesting(false);
    loadResults();
    loadStats();
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className="space-y-6 p-6 max-w-[1400px]">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Database size={22} style={{ color: "var(--signal)" }} />
            <h1 className="text-2xl font-bold">Datasets</h1>
          </div>
          <p className="text-[13px]" style={{ color: "var(--mute-2)" }}>
            {stats?.total ?? "…"} sites · label by language · run batch tests
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={() => { loadSites(); loadStats(); loadResults(); }}>
          <RefreshCw size={14} />
        </Button>
      </div>

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Total Sites"   value={stats.total} />
          <StatCard label="Unlabeled"     value={stats.unlabeled} accent="warning" />
          <StatCard label="Languages"     value={Object.keys(stats.by_language).filter((k) => k && k !== "unlabeled").length} />
          <StatCard
            label="Overall Success"
            value={results ? `${results.success_rate.toFixed(1)}%` : "—"}
            accent={results?.success_rate >= 80 ? "success" : results?.success_rate >= 50 ? "warning" : "danger"}
          />
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left: site table */}
        <div className="xl:col-span-2 space-y-3">
          {/* Filters + bulk actions */}
          <div className="flex flex-wrap gap-2 items-center">
            <Select
              label="Language"
              value={filterLang}
              options={[{ value: "", label: "All languages" }, ...meta.languages.map((l) => ({ value: l, label: l }))]}
              onChange={setFilterLang}
            />
            <Select
              label="Label"
              value={filterLabel}
              options={[{ value: "", label: "All labels" }, ...meta.labels.map((l) => ({ value: l, label: l }))]}
              onChange={setFilterLabel}
            />
            {selected.size > 0 && (
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-[12px]" style={{ color: "var(--mute-2)" }}>{selected.size} selected</span>
                <Select
                  label="Set language"
                  value={bulkLang}
                  options={[{ value: "", label: "pick language…" }, ...meta.languages.map((l) => ({ value: l, label: l }))]}
                  onChange={setBulkLang}
                />
                <Button size="sm" onClick={handleBulkLabel} disabled={!bulkLang}>
                  <Tag size={13} className="mr-1" /> Apply
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  <X size={13} />
                </Button>
              </div>
            )}
          </div>

          {/* Table */}
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", background: "rgba(255,255,255,0.02)" }}>
                  <th className="px-3 py-2 text-left w-8">
                    <input
                      type="checkbox"
                      checked={selected.size === sites.length && sites.length > 0}
                      onChange={(e) => setSelected(e.target.checked ? new Set(sites.map((s) => s.id)) : new Set())}
                    />
                  </th>
                  <th className="px-3 py-2 text-left" style={{ color: "var(--mute-2)" }}>URL</th>
                  <th className="px-3 py-2 text-left w-32" style={{ color: "var(--mute-2)" }}>Language</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={3} className="py-8 text-center"><Loader2 className="animate-spin mx-auto" size={18} /></td></tr>
                ) : sites.length === 0 ? (
                  <tr><td colSpan={3} className="py-8 text-center" style={{ color: "var(--mute-3)" }}>No sites found</td></tr>
                ) : sites.map((site) => (
                  <tr
                    key={site.id}
                    style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}
                    className="hover:bg-white/[0.02] transition-colors"
                  >
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        checked={selected.has(site.id)}
                        onChange={() => toggleSelect(site.id)}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="font-mono truncate block max-w-[380px]" style={{ color: "var(--ink-dim)" }} title={site.url}>
                        {site.url}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <InlineSelect
                        value={site.language}
                        options={["", ...meta.languages]}
                        onChange={(v) => handleLabelSite(site.id, v)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between text-[12px]" style={{ color: "var(--mute-2)" }}>
            <span>{total} sites · page {page + 1} / {Math.max(totalPages, 1)}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Prev</Button>
              <Button size="sm" variant="ghost" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next</Button>
            </div>
          </div>
        </div>

        {/* Right: batch test + results */}
        <div className="space-y-4">
          {/* Batch runner */}
          <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: "var(--border)" }}>
            <div className="flex items-center gap-2 mb-1">
              <Play size={14} style={{ color: "var(--signal)" }} />
              <span className="font-semibold text-[13px]">Batch Test</span>
            </div>

            <div className="space-y-2">
              <label className="text-[11px] uppercase tracking-wide" style={{ color: "var(--mute-3)" }}>Filter by language</label>
              <Select
                value={batchLang}
                options={[{ value: "", label: "All" }, ...meta.languages.map((l) => ({ value: l, label: l }))]}
                onChange={setBatchLang}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[11px] uppercase tracking-wide" style={{ color: "var(--mute-3)" }}>Filter by label</label>
              <Select
                value={batchLabel}
                options={[{ value: "", label: "All" }, ...meta.labels.map((l) => ({ value: l, label: l }))]}
                onChange={setBatchLabel}
              />
            </div>

            <div className="space-y-2">
              <label className="text-[11px] uppercase tracking-wide" style={{ color: "var(--mute-3)" }}>Batch size (from dataset)</label>
              <div className="flex gap-2">
                {[10, 20, 50, 100].map((n) => (
                  <button
                    key={n}
                    onClick={() => setBatchLimit(n)}
                    className="flex-1 py-1 rounded text-[12px] font-medium transition-all"
                    style={{
                      background: batchLimit === n ? "color-mix(in oklch, var(--signal) 14%, transparent)" : "rgba(255,255,255,0.04)",
                      border: `1px solid ${batchLimit === n ? "color-mix(in oklch, var(--signal) 30%, transparent)" : "transparent"}`,
                      color: batchLimit === n ? "var(--signal)" : "var(--mute-2)",
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[11px] uppercase tracking-wide" style={{ color: "var(--mute-3)" }}>
                Or paste custom URLs (one per line)
              </label>
              <textarea
                rows={4}
                placeholder={"https://example.com\nhttps://other.com"}
                value={batchUrls}
                onChange={(e) => setBatchUrls(e.target.value)}
                className="w-full rounded-lg border px-3 py-2 text-[12px] font-mono resize-none"
                style={{
                  background: "var(--surface)",
                  borderColor: "var(--border)",
                  color: "var(--ink)",
                  outline: "none",
                }}
              />
            </div>

            {testing && (
              <div className="space-y-1">
                <div className="flex justify-between text-[11px]" style={{ color: "var(--mute-2)" }}>
                  <span>Running…</span>
                  <span>{testProg} / {testTotal}</span>
                </div>
                <div className="w-full h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.06)" }}>
                  <div
                    className="h-full rounded-full transition-all"
                    style={{ width: `${testTotal ? testProg / testTotal * 100 : 0}%`, background: "var(--signal)" }}
                  />
                </div>
              </div>
            )}

            <Button className="w-full" onClick={handleRunBatch} disabled={testing}>
              {testing ? <><Loader2 className="animate-spin mr-2" size={14} />Running…</> : <><BarChart3 size={14} className="mr-2" />Run Batch</>}
            </Button>
          </div>

          {/* Results summary */}
          {results && results.total > 0 && (
            <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: "var(--border)" }}>
              <span className="font-semibold text-[13px]">Results</span>
              <div className="grid grid-cols-3 gap-2 text-center">
                <MiniStat label="Tested"  value={results.total} />
                <MiniStat label="Passed"  value={results.successful} accent="success" />
                <MiniStat label="Failed"  value={results.failed}     accent="danger" />
              </div>
              <SuccessBar rate={results.success_rate} total={results.total} />

              {Object.keys(results.by_language).length > 0 && (
                <div className="space-y-1.5">
                  <div className="text-[10px] uppercase tracking-wide" style={{ color: "var(--mute-3)" }}>By language</div>
                  {Object.entries(results.by_language).map(([lang, d]) => (
                    <div key={lang} className="flex items-center justify-between gap-2">
                      <LangBadge lang={lang} />
                      <SuccessBar rate={d.success_rate} total={d.total} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── small components ────────────────────────────────────────────────────── */

function StatCard({ label, value, accent }) {
  const color = accent === "success" ? "var(--mint)" : accent === "warning" ? "var(--signal)" : accent === "danger" ? "var(--rose)" : "var(--ink)";
  return (
    <div className="rounded-xl border p-4" style={{ borderColor: "var(--border)", background: "var(--surface)" }}>
      <div className="text-[10px] uppercase tracking-wide mb-1" style={{ color: "var(--mute-3)" }}>{label}</div>
      <div className="text-2xl font-bold" style={{ color }}>{value}</div>
    </div>
  );
}

function MiniStat({ label, value, accent }) {
  const color = accent === "success" ? "var(--mint)" : accent === "danger" ? "var(--rose)" : "var(--ink)";
  return (
    <div>
      <div className="text-lg font-bold" style={{ color }}>{value}</div>
      <div className="text-[10px]" style={{ color: "var(--mute-3)" }}>{label}</div>
    </div>
  );
}

function Select({ value, options, onChange, label }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border px-2 py-1 text-[12px]"
      style={{
        background: "var(--surface)",
        borderColor: "var(--border)",
        color: value ? "var(--ink)" : "var(--mute-2)",
        outline: "none",
      }}
    >
      {options.map((o) => (
        <option key={o.value ?? o} value={o.value ?? o}>{(o.label ?? o) || "—"}</option>
      ))}
    </select>
  );
}

function InlineSelect({ value, options, onChange }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
      style={{
        background: `color-mix(in oklch, ${LANG_COLORS[value] || LANG_COLORS[""]} 12%, transparent)`,
        color: LANG_COLORS[value] || LANG_COLORS[""],
        border: "none",
        outline: "none",
        cursor: "pointer",
      }}
    >
      {options.map((o) => (
        <option key={o} value={o} style={{ background: "var(--bg)", color: "var(--ink)" }}>
          {o || "unlabeled"}
        </option>
      ))}
    </select>
  );
}
