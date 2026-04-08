"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Database } from "lucide-react";

import { apiFetch } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { Button } from "@/components/ui/button";

export default function DatabasePage() {
  const [tables, setTables]   = useState([]);
  const [table, setTable]     = useState("");
  const [payload, setPayload] = useState({ columns: [], rows: [], total: 0 });
  const [limit, setLimit]     = useState(25);
  const [offset, setOffset]   = useState(0);

  useEffect(() => {
    apiFetch("/ui/database/tables").then((p) => {
      const t = p.tables || [];
      setTables(t);
      if (!table && t.length) setTable(t[0]);
    });
  }, []); // eslint-disable-line

  useEffect(() => {
    if (!table) return;
    apiFetch(`/ui/database/${table}?limit=${limit}&offset=${offset}`).then(setPayload);
  }, [table, limit, offset]);

  const total = payload.total || 0;

  return (
    <div className="space-y-5">

      {/* header */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-spark">Database</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">Postgres explorer</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Read-only browse of the observability store — runs, events, tools, evaluations, and memory.
        </p>
      </div>

      {/* controls */}
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
        <span className="ml-auto text-xs text-slate-600">
          {offset + 1}–{Math.min(offset + limit, total)} of {total}
        </span>
        <Button variant="ghost" onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0} className="border border-white/10 h-8 px-2">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="ghost" onClick={() => setOffset(offset + limit)} disabled={offset + limit >= total} className="border border-white/10 h-8 px-2">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>

      {/* table + raw */}
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
