"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, Loader2, RefreshCw, Tag } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { formatPercent } from "@/lib/utils";
import { PageHeader } from "@/components/console/common/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

function StatCard({ label, value, accent }) {
  const color =
    accent === "success"
      ? "var(--mint)"
      : accent === "warning"
        ? "var(--signal)"
        : accent === "danger"
          ? "var(--rose)"
          : "var(--ink)";

  return (
    <div
      className="rounded-xl border p-4"
      style={{
        borderColor: "var(--line)",
        background: "var(--card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div
        className="text-[10px] uppercase tracking-[0.12em]"
        style={{ color: "var(--mute-3)" }}
      >
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

function ProgressBar({ value, total }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>
          {value} / {total}
        </span>
        <span>{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
        <div
          className="h-full rounded-full"
          style={{ width: `${pct}%`, background: "var(--signal)" }}
        />
      </div>
    </div>
  );
}

function InlineSelect({ value, options, onChange }) {
  return (
    <Select
      className="min-w-[150px]"
      value={value}
      onChange={onChange}
      options={options.map((option) => ({
        value: option,
        label: option || "unlabeled",
      }))}
    />
  );
}

export function DatasetsPage() {
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
    const [metaPayload, statsPayload, resultsPayload, batchPayload] =
      await Promise.all([
        apiFetch("/api/datasets/meta"),
        apiFetch("/api/datasets/sites/stats"),
        apiFetch("/api/datasets/results"),
        apiFetch("/api/datasets/batches?limit=1&offset=0"),
      ]);
    setMeta({
      languages: metaPayload.languages || [],
      labels: metaPayload.labels || [],
    });
    setStats(statsPayload);
    setResults(resultsPayload);
    const latestBatch = batchPayload?.batches?.[0] || null;
    setActiveBatch((current) =>
      current?.status === "running" || current?.status === "queued"
        ? current
        : latestBatch,
    );
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
  }, [filterLabel, filterLang, page, search]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    loadSites();
  }, [loadSites]);

  useEffect(() => {
    if (!activeBatch?.batch_id) return undefined;
    if (!["queued", "running"].includes(String(activeBatch.status || ""))) {
      return undefined;
    }

    let alive = true;
    const timer = setInterval(() => {
      apiFetch(`/api/datasets/batches/${activeBatch.batch_id}`)
        .then((payload) => {
          if (!alive) return;
          setActiveBatch(payload);
          if (!["queued", "running"].includes(String(payload.status || ""))) {
            loadSummary();
            loadSites();
          }
        })
        .catch(() => {});
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
    const urls = batchUrls
      .split(/\r?\n/)
      .map((row) => row.trim())
      .filter(Boolean);
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
  const batchIsActive =
    lastBatchStatus === "queued" || lastBatchStatus === "running";
  const batchPassed = activeBatch?.passed_count || 0;
  const batchCompleted = activeBatch?.completed_count || 0;

  const languageOptions = useMemo(
    () => [
      { value: "", label: "All languages" },
      ...meta.languages.map((item) => ({ value: item, label: item })),
    ],
    [meta.languages],
  );
  const labelOptions = useMemo(
    () => [
      { value: "", label: "All labels" },
      ...meta.labels.map((item) => ({ value: item, label: item })),
    ],
    [meta.labels],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Datasets"
        description="Postgres-backed sites, labels, bulk edits, and batch workflow runs."
        icon={<Database className="h-6 w-6 text-primary" />}
        actions={(
          <Button size="sm" variant="outline" onClick={refreshAll}>
            <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
            Refresh
          </Button>
        )}
      />

      {notice ? (
        <Card>
          <CardContent className="px-4 py-3 text-sm text-muted-foreground">
            {notice}
          </CardContent>
        </Card>
      ) : null}

      {stats ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          <StatCard label="Total sites" value={stats.total} />
          <StatCard label="Unlabeled" value={stats.unlabeled} accent="warning" />
          <StatCard label="Tested" value={stats.tested || 0} />
          <StatCard label="Recorded runs" value={stats.total_runs || 0} />
          <StatCard
            label="Overall success"
            value={formatPercent((results?.success_rate || 0) / 100)}
            accent={results?.success_rate >= 70 ? "success" : "danger"}
          />
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1.4fr_0.9fr]">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search URL, notes, language, label..."
              className="h-11 min-w-[260px] flex-1 rounded-xl"
            />
            <Select
              className="min-w-[220px]"
              value={filterLang}
              onChange={setFilterLang}
              options={languageOptions}
            />
            <Select
              className="min-w-[220px]"
              value={filterLabel}
              onChange={setFilterLabel}
              options={labelOptions}
            />
          </div>

          {selectedCount ? (
            <Card>
              <CardContent className="flex flex-wrap items-center gap-2 px-4 py-3">
                <span className="text-sm text-muted-foreground">
                  {selectedCount} selected
                </span>
                <Select
                  className="min-w-[200px]"
                  value={bulkLang}
                  onChange={setBulkLang}
                  options={[
                    { value: "", label: "Leave language" },
                    ...languageOptions.slice(1),
                  ]}
                />
                <Select
                  className="min-w-[200px]"
                  value={bulkLabel}
                  onChange={setBulkLabel}
                  options={[
                    { value: "", label: "Leave label" },
                    ...labelOptions.slice(1),
                  ]}
                />
                <Button size="sm" onClick={applyBulkUpdate} disabled={!bulkLang && !bulkLabel}>
                  <Tag className="mr-1.5 h-3.5 w-3.5" />
                  Apply
                </Button>
              </CardContent>
            </Card>
          ) : null}

          <Card className="overflow-hidden">
            <Table className="min-w-full text-sm">
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="w-8">
                    <Checkbox
                      checked={selected.size === sites.length && sites.length > 0}
                      onCheckedChange={(checked) =>
                        setSelected(
                          checked === true ? new Set(sites.map((site) => site.id)) : new Set(),
                        )
                      }
                      aria-label="Select all dataset rows"
                    />
                  </TableHead>
                  <TableHead>URL</TableHead>
                  <TableHead className="w-44">Language</TableHead>
                  <TableHead className="w-44">Label</TableHead>
                  <TableHead className="w-32">Last tested</TableHead>
                  <TableHead className="w-28">Success</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center">
                      <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ) : !sites.length ? (
                  <TableRow>
                    <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                      No dataset sites matched these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  sites.map((site) => (
                    <TableRow key={site.id}>
                      <TableCell>
                        <Checkbox
                          checked={selected.has(site.id)}
                          onCheckedChange={() => {
                            setSelected((current) => {
                              const next = new Set(current);
                              next.has(site.id) ? next.delete(site.id) : next.add(site.id);
                              return next;
                            });
                          }}
                          aria-label={`Select ${site.url}`}
                        />
                      </TableCell>
                      <TableCell>
                        <div
                          className="max-w-[420px] truncate font-mono text-xs text-foreground"
                          title={site.url}
                        >
                          {site.url}
                        </div>
                        {site.notes ? (
                          <div
                            className="mt-0.5 max-w-[420px] truncate text-xs text-muted-foreground"
                            title={site.notes}
                          >
                            {site.notes}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <InlineSelect
                          value={site.language || ""}
                          options={["", ...meta.languages]}
                          onChange={(nextValue) => updateSite(site.id, { language: nextValue })}
                        />
                      </TableCell>
                      <TableCell>
                        <InlineSelect
                          value={site.label || ""}
                          options={["", ...meta.labels]}
                          onChange={(nextValue) => updateSite(site.id, { label: nextValue })}
                        />
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {site.last_tested_at ? new Date(site.last_tested_at).toLocaleDateString() : "--"}
                      </TableCell>
                      <TableCell
                        className="font-mono text-xs"
                        style={{
                          color:
                            Number(site.success_rate || 0) >= 70
                              ? "var(--mint)"
                              : "var(--signal)",
                        }}
                      >
                        {Number(site.success_rate || 0).toFixed(1)}%
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </Card>

          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              {total} sites / page {page + 1} of {totalPages}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                Prev
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Batch test</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Enqueue workflow runs from the DB-backed dataset or a pasted URL list.
              </p>

              <Input
                value={batchName}
                onChange={(event) => setBatchName(event.target.value)}
                placeholder="Batch name (optional)"
                className="h-11 rounded-xl"
              />

              <Select
                value={batchLang}
                onChange={setBatchLang}
                options={languageOptions}
                label="Filter by language"
              />
              <Select
                value={batchLabel}
                onChange={setBatchLabel}
                options={labelOptions}
                label="Filter by label"
              />

              <div className="space-y-2">
                <div className="text-sm font-medium text-foreground">
                  Batch size from dataset
                </div>
                <div className="grid grid-cols-4 gap-2">
                  {[10, 20, 50, 100].map((value) => (
                    <Button
                      key={value}
                      type="button"
                      variant={batchLimit === value ? "accent" : "outline"}
                      onClick={() => setBatchLimit(value)}
                    >
                      {value}
                    </Button>
                  ))}
                </div>
              </div>

              <Textarea
                rows={5}
                value={batchUrls}
                onChange={(event) => setBatchUrls(event.target.value)}
                placeholder={"https://example.com\nhttps://other.com"}
                mono
                label="Or paste custom URLs"
                className="min-h-[132px] rounded-xl"
              />

              <Button className="w-full" onClick={runBatch} disabled={batchIsActive}>
                {batchIsActive ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Running batch...
                  </>
                ) : (
                  "Run batch"
                )}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="text-base">Latest batch</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {activeBatch?.batch_name || activeBatch?.batch_id || "No batch recorded yet"}
                  </p>
                </div>
                <div
                  className="text-sm font-medium"
                  style={{ color: batchIsActive ? "var(--signal)" : "var(--ink-dim)" }}
                >
                  {activeBatch?.status || "idle"}
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {activeBatch ? (
                <>
                  <ProgressBar
                    value={batchCompleted}
                    total={activeBatch.requested_count || 0}
                  />
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <StatCard label="Passed" value={batchPassed} accent="success" />
                    <StatCard
                      label="Failed"
                      value={activeBatch.failed_count || 0}
                      accent="danger"
                    />
                    <StatCard
                      label="Cancelled"
                      value={activeBatch.cancelled_count || 0}
                      accent="warning"
                    />
                  </div>
                  {latestBatchRuns.length ? (
                    <div className="max-h-[300px] space-y-2 overflow-auto rounded-xl border border-border p-3">
                      {latestBatchRuns.map((row) => (
                        <div
                          key={row.run_id}
                          className="rounded-lg border border-border bg-background px-3 py-2"
                        >
                          <div className="truncate font-mono text-xs text-foreground">
                            {row.url}
                          </div>
                          <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                            <span>{row.status || row.final_status || "queued"}</span>
                            <span>
                              {row.total_cost_usd ? `$${Number(row.total_cost_usd).toFixed(4)}` : "--"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="text-sm text-muted-foreground">No batch runs yet.</div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
