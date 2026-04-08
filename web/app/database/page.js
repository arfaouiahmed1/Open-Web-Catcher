"use client";

import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { DataTable } from "@/components/data-table";
import { JsonViewer } from "@/components/json-viewer";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

export default function DatabasePage() {
  const [tables, setTables] = useState([]);
  const [table, setTable] = useState("");
  const [payload, setPayload] = useState({ columns: [], rows: [] });
  const [limit, setLimit] = useState(25);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    async function loadTables() {
      const tablePayload = await apiFetch("/ui/database/tables");
      const nextTables = tablePayload.tables || [];
      setTables(nextTables);
      if (!table && nextTables.length) {
        setTable(nextTables[0]);
      }
    }
    loadTables();
  }, [table]);

  useEffect(() => {
    if (!table) {
      return;
    }
    async function loadTable() {
      setPayload(await apiFetch(`/ui/database/${table}?limit=${limit}&offset=${offset}`));
    }
    loadTable();
  }, [limit, offset, table]);

  return (
    <div className="space-y-6">
      <section className="max-w-4xl">
        <div className="text-xs uppercase tracking-[0.4em] text-spark">Database Explorer</div>
        <h1 className="mt-3 text-4xl font-semibold">Read the observability store directly</h1>
        <p className="mt-4 text-base leading-7 text-slate-300">
          Browse the allowlisted Postgres tables behind the operator console with pagination, column awareness, and raw JSON inspection.
        </p>
      </section>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Explorer Controls</CardTitle>
            <CardDescription>Read-only table browsing for runs, events, tools, evaluations, and memory.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <Select value={table} onChange={(event) => { setTable(event.target.value); setOffset(0); }}>
            {tables.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
          <Input
            type="number"
            min="1"
            max="200"
            value={limit}
            onChange={(event) => {
              const next = Number(event.target.value || 25);
              setLimit(Math.min(Math.max(next, 1), 200));
              setOffset(0);
            }}
          />
          <Button variant="secondary" onClick={() => setOffset(Math.max(offset - limit, 0))} disabled={offset === 0}>
            Previous
          </Button>
          <Button variant="ghost" onClick={() => setOffset(offset + limit)} disabled={offset + limit >= (payload.total || 0)}>
            Next
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <DataTable
          title={payload.table || table || "Table"}
          description={`Showing ${payload.rows?.length || 0} row(s) of ${payload.total || 0}.`}
          columns={payload.columns || []}
          rows={payload.rows || []}
        />
        <JsonViewer label="Table Payload" value={payload} />
      </div>
    </div>
  );
}
