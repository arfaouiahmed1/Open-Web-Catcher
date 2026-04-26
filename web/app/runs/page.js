"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Filter, Search, Trash2, XCircle } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { canCancelRun, canDeleteRun, RUN_STATUSES, statusLabel, statusTone } from "@/lib/run-status";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";

const PAGE_TYPES = ["", "hosting_page", "landing_page", "embedded_page", "unknown"];
const ACTORS = ["", "orchestrator", "classification", "landing", "hosting", "embedded"];

const PROVIDER_COLORS = {
  google: "var(--sky)",
  openai: "var(--mint)",
  anthropic: "var(--signal)",
  openrouter: "var(--violet)",
};

function ModelBadge({ provider, model }) {
  const color = PROVIDER_COLORS[provider?.toLowerCase()] || "var(--mute)";
  const short = model?.split("/").pop() || model || "--";
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[10px] font-semibold uppercase tracking-wider" style={{ color }}>{provider || "--"}</span>
      <span className="max-w-[140px] truncate font-mono text-[11px]" style={{ color: "var(--ink-dim)" }} title={model}>{short}</span>
    </div>
  );
}

function ComparePanel({ rows = [] }) {
  if (rows.length < 2) return null;
  const maxDuration = Math.max(...rows.map((row) => Number(row.duration_seconds || 0)), 1);
  const sortedTools = [...rows].sort((a, b) => Number(b.total_tool_calls || 0) - Number(a.total_tool_calls || 0));
  const divergence = sortedTools[0]?.run_id !== sortedTools[rows.length - 1]?.run_id;

  return (
    <div
      className="rounded-[14px] border p-4 space-y-3"
      style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
    >
      <div className="text-[13.5px] font-medium text-[var(--ink)]">Compare runs</div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => (
          <div
            key={row.run_id}
            className="rounded-[10px] border px-3 py-2.5"
            style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)" }}
          >
            <div className="font-mono text-[12px] text-[var(--ink)]">{row.run_id?.slice(0, 12)}...</div>
            <div className="mt-0.5 text-[11px] text-[var(--mute)]">{row.page_type || "--"}</div>
            <div className="mt-2 space-y-1 text-[12px] text-[var(--ink-dim)]">
              <div>tools {formatNumber(row.total_tool_calls)}</div>
              <div>llm {formatNumber(row.total_llm_calls)}</div>
              <div>cost {formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}</div>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full" style={{ background: "var(--line)" }}>
              <div
                className="h-1.5 rounded-full"
                style={{ width: `${(Number(row.duration_seconds || 0) / maxDuration) * 100}%`, background: "color-mix(in oklch, var(--signal) 60%, transparent)" }}
              />
            </div>
            <div className="mt-1 text-[11px] text-[var(--mute)]">{Number(row.duration_seconds || 0).toFixed(1)}s</div>
          </div>
        ))}
      </div>
      <div className="text-[12px]" style={{ color: divergence ? "var(--signal)" : "var(--mute)" }}>
        {divergence
          ? "Divergence detected: selected runs have different tool-call intensity."
          : "No significant divergence in selected runs."}
      </div>
    </div>
  );
}

export default function RunsPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [pageType, setPageType] = useState("");
  const [actor, setActor] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [limit] = useState(25);
  const [isLoading, setLoading] = useState(true);
  const [selected, setSelected] = useState([]);
  const [reloadTick, setReloadTick] = useState(0);
  const [busyRunId, setBusyRunId] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
      status,
      page_type: pageType,
      actor,
      query: search,
    });
    apiFetch(`/ui/runs?${params.toString()}`)
      .then((payload) => {
        if (!cancelled) {
          setRows(payload.rows || []);
          setTotal(payload.total || 0);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [limit, offset, status, pageType, actor, search, reloadTick]);

  async function cancelRun(runId) {
    setBusyRunId(runId);
    try {
      await fetch(apiUrl(`/ui/runs/${runId}/cancel`), { method: "POST" });
      setReloadTick((value) => value + 1);
    } finally {
      setBusyRunId("");
    }
  }

  async function deleteRun(runId) {
    const confirmed = window.confirm("Delete this run and its persisted telemetry? This cannot be undone.");
    if (!confirmed) return;
    setBusyRunId(runId);
    try {
      await fetch(apiUrl(`/ui/runs/${runId}`), { method: "DELETE" });
      setSelected((current) => current.filter((item) => item !== runId));
      setReloadTick((value) => value + 1);
    } finally {
      setBusyRunId("");
    }
  }

  const pages = Math.ceil(total / limit) || 1;
  const page = Math.floor(offset / limit) + 1;
  const selectedRows = useMemo(() => rows.filter((row) => selected.includes(row.run_id)), [rows, selected]);

  return (
    <div className="space-y-5">
      <div>
        <span className="owc-eyebrow">run history · all workflows</span>
        <h1 className="mt-2 text-3xl font-semibold text-[var(--ink)]">Pipeline runs</h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          Filter, compare, cancel, delete, and drill into persisted workflow and agent runs from one consistent table.
        </p>
      </div>

      <div
        className="space-y-3 rounded-[14px] border px-4 py-3"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        <div className="flex flex-wrap items-center gap-3">
          <Filter className="h-3.5 w-3.5 shrink-0 text-[var(--mute)]" />
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--mute-2)]" />
            <input
              value={search}
              onChange={(event) => { setSearch(event.target.value); setOffset(0); }}
              placeholder="Search run ID, URL, actor, provider, model..."
              className="h-9 w-full rounded-[10px] border pl-9 pr-3 text-[12px]"
              style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.12)", color: "var(--ink)" }}
            />
          </div>
          <Select
            className="min-w-[180px]"
            value={status}
            onChange={(value) => { setStatus(value); setOffset(0); }}
            options={RUN_STATUSES.map((item) => ({
              value: item,
              label: item ? statusLabel(item) : "All statuses",
            }))}
          />
          <Select
            className="min-w-[200px]"
            value={pageType}
            onChange={(value) => { setPageType(value); setOffset(0); }}
            options={PAGE_TYPES.map((item) => ({
              value: item,
              label: item || "All page types",
            }))}
          />
          <Select
            className="min-w-[180px]"
            value={actor}
            onChange={(value) => { setActor(value); setOffset(0); }}
            options={ACTORS.map((item) => ({
              value: item,
              label: item || "All actors",
            }))}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant={status === "running" ? "accent" : "ghost"} size="sm" onClick={() => { setStatus("running"); setOffset(0); }} className="border border-[var(--line)]">
            Active
          </Button>
          <Button variant={status === "failed" ? "accent" : "ghost"} size="sm" onClick={() => { setStatus("failed"); setOffset(0); }} className="border border-[var(--line)]">
            Failed
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setStatus(""); setPageType(""); setActor(""); setSearch(""); setOffset(0); }} className="border border-[var(--line)]">
            Reset filters
          </Button>
          <span className="ml-auto text-[12px] text-[var(--mute)]">
            {formatNumber(total)} run{total !== 1 ? "s" : ""} · page {page} of {pages} · {selected.length} selected
          </span>
          <Button variant="ghost" size="sm" onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0} className="border border-[var(--line)] h-8 px-2">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setOffset(offset + limit)} disabled={offset + limit >= total} className="border border-[var(--line)] h-8 px-2">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ComparePanel rows={selectedRows} />

      <div
        className="rounded-[14px] border overflow-hidden"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        <div className="overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead>
              <tr className="border-b" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.012)" }}>
                {["", "Run", "Status", "Actor", "Model", "Page", "Parallel", "Tokens", "Cost", "Duration", "Actions", "Date"].map((heading) => (
                  <th key={heading || "select"} className="px-4 py-2.5 text-left text-[10.5px] font-medium uppercase tracking-[0.1em] whitespace-nowrap" style={{ color: "var(--mute)" }}>{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((row) => (
                <tr
                  key={row.run_id}
                  className="border-b transition-colors"
                  style={{ borderColor: "var(--line)" }}
                  onMouseEnter={(event) => { event.currentTarget.style.background = "rgba(255,255,255,0.02)"; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
                >
                  <td className="px-4 py-3 align-top">
                    <input
                      type="checkbox"
                      checked={selected.includes(row.run_id)}
                      onChange={(event) => {
                        setSelected((current) => {
                          if (event.target.checked) return Array.from(new Set([...current, row.run_id])).slice(0, 4);
                          return current.filter((item) => item !== row.run_id);
                        });
                      }}
                    />
                  </td>
                  <td className="px-4 py-3 align-top">
                    <Link href={`/runs/${row.run_id}`} className="font-mono text-[12px] transition-colors" style={{ color: "var(--signal)" }}>
                      {row.run_id?.slice(0, 12)}...
                    </Link>
                    <div className="mt-0.5 max-w-[220px] truncate text-[11px] text-[var(--mute)]" title={row.url}>{row.url}</div>
                  </td>
                  <td className="px-4 py-3 align-top">
                    <Badge tone={statusTone(row.final_status)}>{statusLabel(row.final_status)}</Badge>
                  </td>
                  <td className="px-4 py-3 align-top text-[12px] text-[var(--mute)]">
                    <div>{row.root_actor || "--"}</div>
                    {row.job?.status ? (
                      <div className="mt-0.5 font-mono text-[10.5px] text-[var(--mute-2)]">
                        {row.job.display_status || row.job.status}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 align-top">
                    {row.primary_model ? (
                      <ModelBadge provider={row.primary_provider} model={row.primary_model} />
                    ) : <span className="text-[11px] text-[var(--mute-3)]">--</span>}
                  </td>
                  <td className="px-4 py-3 align-top text-[12px] text-[var(--mute)]">{row.page_type || "--"}</td>
                  <td className="px-4 py-3 align-top text-[12px] text-[var(--ink-dim)]">
                    {formatNumber(row.max_parallel_agents || 0)}
                  </td>
                  <td className="px-4 py-3 align-top tabular-nums text-[var(--ink-dim)]">{formatNumber((row.total_tokens_in || 0) + (row.total_tokens_out || 0))}</td>
                  <td className="px-4 py-3 align-top tabular-nums text-[var(--ink-dim)]">{formatCurrency(row.total_cost_usd ?? row.estimated_total_cost_usd ?? 0)}</td>
                  <td className="px-4 py-3 align-top tabular-nums text-[12px] text-[var(--ink-dim)]">{Number(row.duration_seconds || 0).toFixed(1)}s</td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex flex-wrap gap-2">
                      {canCancelRun(row) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => cancelRun(row.run_id)}
                          disabled={busyRunId === row.run_id}
                          className="border border-[var(--line)]"
                        >
                          <XCircle className="mr-1.5 h-3.5 w-3.5" />
                          Cancel
                        </Button>
                      ) : null}
                      {canDeleteRun(row) ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => deleteRun(row.run_id)}
                          disabled={busyRunId === row.run_id}
                          className="border border-[var(--line)]"
                        >
                          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                          Delete
                        </Button>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top text-[11px] whitespace-nowrap text-[var(--mute)]">
                    {row.created_at ? new Date(row.created_at).toLocaleString() : "--"}
                  </td>
                </tr>
              )) : (
                <tr>
                  <td colSpan={12} className="px-4 py-12 text-center text-[13px] text-[var(--mute)]">
                    {isLoading ? "Loading..." : "No runs matched this filter"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
