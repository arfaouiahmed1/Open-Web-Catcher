"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Database, RefreshCcw } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

function TableCards({ entries = [], selected, onSelect }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      {entries.map((entry) => (
        <button
          key={entry.name}
          onClick={() => onSelect(entry.name)}
          type="button"
          className="rounded-[10px] border px-3 py-2.5 text-left transition-colors"
          style={selected === entry.name
            ? { borderColor: "color-mix(in oklch, var(--signal) 55%, transparent)", background: "color-mix(in oklch, var(--signal) 9%, transparent)" }
            : { borderColor: "var(--line)", background: "var(--card)" }
          }
          onMouseEnter={(e) => { if (selected !== entry.name) e.currentTarget.style.borderColor = "var(--line-hi)"; }}
          onMouseLeave={(e) => { if (selected !== entry.name) e.currentTarget.style.borderColor = "var(--line)"; }}
        >
          <div className="font-mono text-[12px] text-[var(--ink)]">{entry.name}</div>
          <div className="mt-0.5 text-[11px] text-[var(--mute)]">{entry.row_count || 0} rows</div>
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

  useEffect(() => { loadTables(); }, []); // eslint-disable-line
  useEffect(() => { loadTableData(table, limit, offset); }, [table, limit, offset]); // eslint-disable-line

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => { loadTables(); loadTableData(); }, 5000);
    return () => clearInterval(timer);
  }, [autoRefresh, table, limit, offset]); // eslint-disable-line

  const total = payload.total || 0;
  const tableSummary = useMemo(() => entries.find((item) => item.name === table) || null, [entries, table]);

  return (
    <div className="space-y-5">

      {/* page header */}
      <div>
        <span className="owc-eyebrow">database · postgres explorer</span>
        <h1 className="mt-2 text-3xl font-semibold text-[var(--ink)]">
          Data explorer
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          Read-only browse of runs, events, tools, evaluations, and memory with clean table-level summaries.
        </p>
      </div>

      <TableCards entries={entries} selected={table} onSelect={(name) => { setTable(name); setOffset(0); }} />

      {/* toolbar */}
      <div
        className="flex flex-wrap items-center gap-3 rounded-[14px] border px-4 py-3"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        <Database className="h-3.5 w-3.5 shrink-0 text-[var(--mute)]" />
        <Select
          className="min-w-[220px]"
          value={table}
          onChange={(value) => { setTable(value); setOffset(0); }}
          options={tables.map((item) => ({
            value: item,
            label: item,
          }))}
        />
        <Input
          type="number"
          min="1"
          max="200"
          value={limit}
          onChange={(e) => { setLimit(Math.min(Math.max(Number(e.target.value || 25), 1), 200)); setOffset(0); }}
          className="w-24"
        />
        <button
          type="button"
          onClick={() => setAutoRefresh((v) => !v)}
          className="inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] transition-colors"
          style={autoRefresh
            ? { borderColor: "color-mix(in oklch, var(--mint) 35%, transparent)", background: "color-mix(in oklch, var(--mint) 12%, transparent)", color: "var(--mint)" }
            : { borderColor: "var(--line)", color: "var(--mute)" }
          }
        >
          <RefreshCcw className="h-3 w-3" />
          auto
        </button>
        <span className="ml-auto text-[12px] text-[var(--mute)]">
          {offset + 1}–{Math.min(offset + limit, total)} of {total}
          {tableSummary ? ` · ${tableSummary.row_count || 0} total` : ""}
        </span>
        <Button variant="ghost" onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0} className="border border-[var(--line)] h-8 px-2">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" onClick={() => setOffset(offset + limit)} disabled={offset + limit >= total} className="border border-[var(--line)] h-8 px-2">
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
