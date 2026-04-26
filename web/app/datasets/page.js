"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, Loader2, RefreshCw, Tag } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { formatPercent } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

const LANG_COLORS = {
  arabic: "var(--violet)",
  english: "var(--signal)",
  spanish: "var(--mint)",
  french: "var(--sky)",
  portuguese: "var(--amber, #f59e0b)",
  other: "var(--mute-2)",
  "": "var(--mute-3)",
};

function InlineSelect({ value, options, onChange }) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
      style={{
        background: `color-mix(in oklch, ${LANG_COLORS[value] || LANG_COLORS[""]} 12%, transparent)`,
        color: LANG_COLORS[value] || LANG_COLORS[""],
        border: "none",
        outline: "none",
        cursor: "pointer",
      }}
    >
      {options.map((option) => (
        <option key={option} value={option} style={{ background: "var(--bg)", color: "var(--ink)" }}>
          {option || "unlabeled"}
        </option>
      ))}
    </select>
  );
}

function StatCard({ label, value, accent }) {
  const color = accent === "success" ? "var(--mint)" : accent === "warning" ? "var(--signal)" : accent === "danger" ? "var(--rose)" : "var(--ink)";
  return (
    <div className="rounded-[16px] border p-4" style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}>
      <div className="text-[10px] uppercase tracking-[0.12em]" style={{ color: "var(--mute-3)" }}>{label}</div>
      <div className="mt-1 text-2xl font-semibold" style={{ color }}>{value}</div>
    </div>
  );
}

function ProgressBar({ value, total }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]" style={{ color: "var(--mute-2)" }}>
        <span>{value} / {total}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full" style={{ background: "rgba(255,255,255,0.06)" }}>
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "var(--signal)" }} />
      </div>
    </div>
  );
}

export default function DatasetsPage() {
  const [meta, setMeta] = useState({ languages: [], labels: [] });
  const [stats, setStats] = useState(null);
  const [results, setResults] = useState(null);
  const [sites, setSites] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [activeBatch, setActiveBatch] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [notice, setNotice] = useState("");

  const [filterLang, setFilterLang] = useState("");
  const [filterLabel, setFilterLabel] = useState("");
  const [search, setSearch] = useState("");

  const [bulkLang, setBulkLang] = useState("");
  const [bulkLabel, setBulkLabel] = useState("");

  const [batchLang, setBatchLang] = useState("");
  const [batchLabel, setBatchLabel] = useState("");
  const [batchLimit, setBatchLimit] = useState(20);
  const [batchUrls, setBatchUrls] = useState("");
  const [batchName, setBatchName] = useState("");

  const PAGE_SIZE = 25;

  const loadSummary = useCallback(async () => {
    const [metaPayload, statsPayload, resultsPayload, batchPayload] = await Promise.all([
      apiFetch("/api/datasets/meta"),
      apiFetch("/api/datasets/sites/stats"),
      apiFetch("/api/datasets/results"),
      apiFetch("/api/datasets/batches?limit=1&offset=0"),
    ]);
    setMeta({ languages: metaPayload.languages || [], labels: metaPayload.labels || [] });
    setStats(statsPayload);
    setResults(resultsPayload);
    const latestBatch = batchPayload?.batches?.[0] || null;
    setActiveBatch((current) => current?.status === "running" || current?.status === "queued" ? current : latestBatch);
  }, []);

  const loadSites = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        offset: String(page * PAGE_SIZE),
        limit: String(PAGE_SIZE),
        language: filterLang,
        label: filterLabel,
        query: search,
      });
      const payload = await apiFetch(`/api/datasets/sites?${params.toString()}`);
      setSites(payload.sites || []);
      setTotal(payload.total || 0);
    } finally {
      setLoading(false);
    }
  }, [page, filterLang, filterLabel, search]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    loadSites();
  }, [loadSites]);

  useEffect(() => {
    if (!activeBatch?.batch_id) return undefined;
    if (!["queued", "running"].includes(String(activeBatch.status || ""))) return undefined;
    let alive = true;
    const timer = setInterval(() => {
      apiFetch(`/api/datasets/batches/${activeBatch.batch_id}`).then((payload) => {
        if (!alive) return;
        setActiveBatch(payload);
        if (!["queued", "running"].includes(String(payload.status || ""))) {
          loadSummary();
          loadSites();
        }
      }).catch(() => {});
    }, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [activeBatch?.batch_id, activeBatch?.status, loadSites, loadSummary]);

  useEffect(() => {
    setPage(0);
  }, [filterLang, filterLabel, search]);

  async function refreshAll() {
    await Promise.all([loadSummary(), loadSites()]);
  }

  async function updateSite(siteId, patch) {
    await apiFetch(`/api/datasets/sites/${siteId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    await Promise.all([loadSites(), loadSummary()]);
  }

  async function applyBulkUpdate() {
    if (!selected.size || (!bulkLang && !bulkLabel)) return;
    await apiFetch("/api/datasets/sites/bulk-update", {
      method: "POST",
      body: JSON.stringify({
        ids: [...selected].map(Number),
        language: bulkLang || null,
        label: bulkLabel || null,
      }),
    });
    setSelected(new Set());
    setBulkLang("");
    setBulkLabel("");
    await Promise.all([loadSites(), loadSummary()]);
  }

  async function runBatch() {
    const urls = batchUrls.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
    const payload = await apiFetch("/api/datasets/batches", {
      method: "POST",
      body: JSON.stringify({
        batch_name: batchName,
        language: batchLang,
        label: batchLabel,
        limit: batchLimit,
        urls,
      }),
    });
    setActiveBatch(payload);
    setBatchUrls("");
    setBatchName("");
    await refreshAll();
  }

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;
  const selectedCount = selected.size;
  const latestBatchRuns = activeBatch?.runs || [];
  const lastBatchStatus = String(activeBatch?.status || "").toLowerCase();
  const batchIsActive = lastBatchStatus === "queued" || lastBatchStatus === "running";
  const batchPassed = activeBatch?.passed_count || 0;
  const batchCompleted = activeBatch?.completed_count || 0;

  const languageOptions = useMemo(
    () => [{ value: "", label: "All languages" }, ...meta.languages.map((item) => ({ value: item, label: item }))],
    [meta.languages],
  );
  const labelOptions = useMemo(
    () => [{ value: "", label: "All labels" }, ...meta.labels.map((item) => ({ value: item, label: item }))],
    [meta.labels],
  );

  return (
    <div className="space-y-6 p-6 max-w-[1440px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-3">
            <Database size={22} style={{ color: "var(--signal)" }} />
            <h1 className="text-3xl font-semibold text-[var(--ink)]">Datasets</h1>
          </div>
          <p className="text-[13px]" style={{ color: "var(--mute-2)" }}>
            {stats?.total ?? "..."} sites · Postgres-backed import, labels, and batch test runs
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={refreshAll}>
            <RefreshCw size={14} className="mr-1.5" />
            Refresh
          </Button>
        </div>
      </div>

      {notice ? (
        <div
          className="rounded-[14px] border px-4 py-3 text-[12px]"
          style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)", color: notice.startsWith("Import failed") ? "var(--rose)" : "var(--ink-dim)" }}
        >
          {notice}
        </div>
      ) : null}

      {stats ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Total sites" value={stats.total} />
          <StatCard label="Unlabeled" value={stats.unlabeled} accent="warning" />
          <StatCard label="Tested" value={stats.tested || 0} />
          <StatCard label="Recorded runs" value={stats.total_runs || 0} />
          <StatCard label="Overall success" value={formatPercent((results?.success_rate || 0) / 100)} accent={results?.success_rate >= 70 ? "success" : "danger"} />
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search URL, notes, language, label..."
              className="h-11 min-w-[260px] flex-1 rounded-[12px] border px-3 text-[13px]"
              style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.12)", color: "var(--ink)" }}
            />
            <Select className="min-w-[220px]" value={filterLang} onChange={setFilterLang} options={languageOptions} />
            <Select className="min-w-[220px]" value={filterLabel} onChange={setFilterLabel} options={labelOptions} />
          </div>

          {selectedCount ? (
            <div
              className="flex flex-wrap items-center gap-2 rounded-[14px] border px-4 py-3"
              style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
            >
              <span className="text-[12px]" style={{ color: "var(--mute-2)" }}>{selectedCount} selected</span>
              <Select className="min-w-[200px]" value={bulkLang} onChange={setBulkLang} options={[{ value: "", label: "Leave language" }, ...languageOptions.slice(1)]} />
              <Select className="min-w-[200px]" value={bulkLabel} onChange={setBulkLabel} options={[{ value: "", label: "Leave label" }, ...labelOptions.slice(1)]} />
              <Button size="sm" onClick={applyBulkUpdate} disabled={!bulkLang && !bulkLabel}>
                <Tag size={13} className="mr-1.5" />
                Apply
              </Button>
            </div>
          ) : null}

          <div
            className="rounded-[16px] border overflow-hidden"
            style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
          >
            <div className="overflow-x-auto">
              <table className="min-w-full text-[12px]">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--line)", background: "rgba(255,255,255,0.02)" }}>
                    <th className="px-3 py-2 text-left w-8">
                      <input
                        type="checkbox"
                        checked={selected.size === sites.length && sites.length > 0}
                        onChange={(event) => setSelected(event.target.checked ? new Set(sites.map((site) => site.id)) : new Set())}
                      />
                    </th>
                    <th className="px-3 py-2 text-left" style={{ color: "var(--mute-2)" }}>URL</th>
                    <th className="px-3 py-2 text-left w-36" style={{ color: "var(--mute-2)" }}>Language</th>
                    <th className="px-3 py-2 text-left w-36" style={{ color: "var(--mute-2)" }}>Label</th>
                    <th className="px-3 py-2 text-left w-28" style={{ color: "var(--mute-2)" }}>Last tested</th>
                    <th className="px-3 py-2 text-left w-28" style={{ color: "var(--mute-2)" }}>Success</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={6} className="py-10 text-center"><Loader2 className="mx-auto animate-spin" size={18} /></td></tr>
                  ) : !sites.length ? (
                    <tr><td colSpan={6} className="py-10 text-center" style={{ color: "var(--mute-3)" }}>No dataset sites matched these filters.</td></tr>
                  ) : sites.map((site) => (
                    <tr key={site.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }} className="transition-colors hover:bg-white/[0.02]">
                      <td className="px-3 py-2">
                        <input type="checkbox" checked={selected.has(site.id)} onChange={() => {
                          setSelected((current) => {
                            const next = new Set(current);
                            next.has(site.id) ? next.delete(site.id) : next.add(site.id);
                            return next;
                          });
                        }} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="max-w-[420px] truncate font-mono text-[11px]" style={{ color: "var(--ink-dim)" }} title={site.url}>
                          {site.url}
                        </div>
                        {site.notes ? (
                          <div className="mt-0.5 max-w-[420px] truncate text-[11px]" style={{ color: "var(--mute-2)" }} title={site.notes}>
                            {site.notes}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-3 py-2">
                        <InlineSelect value={site.language || ""} options={["", ...meta.languages]} onChange={(value) => updateSite(site.id, { language: value })} />
                      </td>
                      <td className="px-3 py-2">
                        <InlineSelect value={site.label || ""} options={["", ...meta.labels]} onChange={(value) => updateSite(site.id, { label: value })} />
                      </td>
                      <td className="px-3 py-2 text-[11px]" style={{ color: "var(--mute)" }}>
                        {site.last_tested_at ? new Date(site.last_tested_at).toLocaleDateString() : "--"}
                      </td>
                      <td className="px-3 py-2 text-[11px] font-mono" style={{ color: Number(site.success_rate || 0) >= 70 ? "var(--mint)" : "var(--signal)" }}>
                        {Number(site.success_rate || 0).toFixed(1)}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between text-[12px]" style={{ color: "var(--mute-2)" }}>
            <span>{total} sites · page {page + 1} / {totalPages}</span>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>Prev</Button>
              <Button size="sm" variant="ghost" disabled={page >= totalPages - 1} onClick={() => setPage((value) => value + 1)}>Next</Button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div
            className="rounded-[16px] border p-4 space-y-3"
            style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
          >
            <div>
              <div className="text-[13.5px] font-medium text-[var(--ink)]">Batch test</div>
              <div className="mt-0.5 text-[12px]" style={{ color: "var(--mute)" }}>
                Enqueue workflow runs from the DB-backed dataset or a pasted URL list.
              </div>
            </div>

            <input
              value={batchName}
              onChange={(event) => setBatchName(event.target.value)}
              placeholder="Batch name (optional)"
              className="h-11 w-full rounded-[12px] border px-3 text-[13px]"
              style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.12)", color: "var(--ink)" }}
            />

            <Select value={batchLang} onChange={setBatchLang} options={languageOptions} label="Filter by language" />
            <Select value={batchLabel} onChange={setBatchLabel} options={labelOptions} label="Filter by label" />

            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--mute-2)" }}>
                Batch size from dataset
              </label>
              <div className="grid grid-cols-4 gap-2">
                {[10, 20, 50, 100].map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setBatchLimit(value)}
                    className="rounded-[10px] border py-2 text-[12px] font-medium transition-colors"
                    style={{
                      borderColor: batchLimit === value ? "color-mix(in oklch, var(--signal) 32%, transparent)" : "var(--line)",
                      background: batchLimit === value ? "color-mix(in oklch, var(--signal) 12%, transparent)" : "transparent",
                      color: batchLimit === value ? "var(--signal)" : "var(--mute-2)",
                    }}
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: "var(--mute-2)" }}>
                Or paste custom URLs
              </label>
              <textarea
                rows={5}
                value={batchUrls}
                onChange={(event) => setBatchUrls(event.target.value)}
                placeholder={"https://example.com\nhttps://other.com"}
                className="w-full rounded-[12px] border px-3 py-2 text-[12px] font-mono"
                style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.12)", color: "var(--ink)" }}
              />
            </div>

            <Button className="w-full" onClick={runBatch} disabled={batchIsActive}>
              {batchIsActive ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Running batch...</> : "Run batch"}
            </Button>
          </div>

          <div
            className="rounded-[16px] border p-4 space-y-3"
            style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-[13.5px] font-medium text-[var(--ink)]">Latest batch</div>
                <div className="mt-0.5 text-[12px]" style={{ color: "var(--mute)" }}>
                  {activeBatch?.batch_name || activeBatch?.batch_id || "No batch recorded yet"}
                </div>
              </div>
              <div className="text-[12px] font-medium" style={{ color: batchIsActive ? "var(--signal)" : "var(--ink-dim)" }}>
                {activeBatch?.status || "idle"}
              </div>
            </div>

            {activeBatch ? (
              <>
                <ProgressBar value={batchCompleted} total={activeBatch.requested_count || 0} />
                <div className="grid grid-cols-3 gap-2 text-center">
                  <StatCard label="Passed" value={batchPassed} accent="success" />
                  <StatCard label="Failed" value={activeBatch.failed_count || 0} accent="danger" />
                  <StatCard label="Cancelled" value={activeBatch.cancelled_count || 0} accent="warning" />
                </div>
                {latestBatchRuns.length ? (
                  <div className="max-h-[300px] space-y-2 overflow-auto rounded-[12px] border p-3" style={{ borderColor: "var(--line)" }}>
                    {latestBatchRuns.map((row) => (
                      <div key={row.run_id} className="rounded-[10px] border px-3 py-2" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.02)" }}>
                        <div className="truncate font-mono text-[11px]" style={{ color: "var(--ink-dim)" }}>{row.url}</div>
                        <div className="mt-1 flex items-center justify-between text-[11px]">
                          <span style={{ color: "var(--mute-2)" }}>{row.status || row.final_status || "queued"}</span>
                          <span style={{ color: "var(--mute-2)" }}>{row.total_cost_usd ? `$${Number(row.total_cost_usd).toFixed(4)}` : "--"}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="text-[12px]" style={{ color: "var(--mute)" }}>No batch runs yet.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
