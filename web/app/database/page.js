"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Database, RefreshCcw } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { Button } from "@/components/ui/button";

function TableCards({ entries = [], selected, onSelect }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {entries.map((entry) => (
        <button
          key={entry.name}
          onClick={() => onSelect(entry.name)}
          type="button"
          className={`rounded-lg border px-3 py-2 text-left transition-colors ${
            selected === entry.name
              ? "border-signal/50 bg-signal/10"
              : "border-white/8 bg-white/[0.03] hover:border-white/20"
          }`}
        >
          <div className="font-mono text-xs text-white">{entry.name}</div>
          <div className="mt-1 text-[11px] text-slate-500">{entry.row_count || 0} rows</div>
        </button>
      ))}
    </div>
  );
}

export default function DatabasePage() {
  const [tables, setTables] = useState([]);
  const [entries, setEntries] = useState([]);
  const [table, setTable] = useState("");
  const [payload, setPayload] = useState({ columns: [], rows: [], total: 0 });
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(false);

  async function loadTables() {
    const p = await apiFetch("/ui/database/tables");
    const t = p.tables || [];
    const e = p.entries || [];
    setTables(t);
    setEntries(e);
    if (!table && t.length) setTable(t[0]);
  }

  async function loadTableData(nextTable = table, nextLimit = limit, nextOffset = offset) {
    if (!nextTable) return;
    const p = await apiFetch(`/ui/database/${nextTable}?limit=${nextLimit}&offset=${nextOffset}`);
    setPayload(p);
  }

  useEffect(() => {
    loadTables();
  }, []); // eslint-disable-line

  useEffect(() => {
    loadTableData(table, limit, offset);
  }, [table, limit, offset]); // eslint-disable-line

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      loadTables();
      loadTableData();
    }, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, table, limit, offset]); // eslint-disable-line

  const total = payload.total || 0;
  const tableSummary = useMemo(
    () => entries.find((item) => item.name === table) || null,
    [entries, table]
  );

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-spark">Database</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">Postgres explorer</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Read-only browse of runs, events, tools, evaluations, and memory with clean table-level summaries.
        </p>
      </div>

      <TableCards entries={entries} selected={table} onSelect={(name) => { setTable(name); setOffset(0); }} />

      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
        <Database className="h-3.5 w-3.5 text-slate-600 shrink-0" />
        <select
          value={table}
          onChange={(e) => { setTable(e.target.value); setOffset(0); }}
          className="rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-slate-300 focus:border-signal/50 focus:outline-none"
        >
          {tables.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          type="number"
          min="1"
          max="200"
          value={limit}
          onChange={(e) => { setLimit(Math.min(Math.max(Number(e.target.value || 25), 1), 200)); setOffset(0); }}
          className="w-20 rounded-lg border border-white/10 bg-black/20 px-3 py-1.5 text-sm text-slate-300 focus:border-signal/50 focus:outline-none"
        />
        <button
          type="button"
          onClick={() => setAutoRefresh((v) => !v)}
          className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs ${autoRefresh ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-300" : "border-white/10 text-slate-500"}`}
        >
          <RefreshCcw className="h-3 w-3" />
          auto
        </button>
        <span className="ml-auto text-xs text-slate-600">
          {offset + 1}–{Math.min(offset + limit, total)} of {total}
          {tableSummary ? ` · ${tableSummary.row_count || 0} total table rows` : ""}
        </span>
        <Button variant="ghost" onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0} className="border border-white/10 h-8 px-2">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" onClick={() => setOffset(offset + limit)} disabled={offset + limit >= total} className="border border-white/10 h-8 px-2">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <DataTable
          title={payload.table || table}
          description={`${payload.rows?.length || 0} rows shown · ${total} total`}
          columns={payload.columns || []}
          rows={payload.rows || []}
        />
        <JsonViewer label="Raw payload" value={payload} />
      </div>
    </div>
  );
}
