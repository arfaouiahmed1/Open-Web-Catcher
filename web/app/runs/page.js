"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { formatCurrency, formatNumber } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

const PAGE_TYPES = ["", "hosting_page", "landing_page", "embedded_page"];
const STATUSES = ["", "success", "partial", "failed"];

export default function RunsPage() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [pageType, setPageType] = useState("");
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(25);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setIsLoading(true);
      try {
        const payload = await apiFetch(
          `/ui/runs?limit=${limit}&offset=${offset}&status=${encodeURIComponent(status)}&page_type=${encodeURIComponent(pageType)}`
        );
        if (!cancelled) {
          setRows(payload.rows || []);
          setTotal(payload.total || 0);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [limit, offset, pageType, status]);

  return (
    <div className="space-y-6">
      <section className="max-w-4xl">
        <div className="text-xs uppercase tracking-[0.4em] text-signal">Runs Explorer</div>
        <h1 className="mt-3 text-4xl font-semibold">Trace every workflow run</h1>
        <p className="mt-4 text-base leading-7 text-slate-300">
          Filter persisted orchestrator runs, inspect status patterns, compare cost, and jump into the detailed event trail for each run.
        </p>
      </section>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Filters</CardTitle>
            <CardDescription>Status and page type slices for the normalized run store.</CardDescription>
          </div>
          <div className="text-sm text-slate-400">Total {formatNumber(total)}</div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-4">
          <Select value={status} onChange={(event) => { setStatus(event.target.value); setOffset(0); }}>
            {STATUSES.map((item) => (
              <option key={item || "all-statuses"} value={item}>
                {item || "All statuses"}
              </option>
            ))}
          </Select>
          <Select value={pageType} onChange={(event) => { setPageType(event.target.value); setOffset(0); }}>
            {PAGE_TYPES.map((item) => (
              <option key={item || "all-pages"} value={item}>
                {item || "All page types"}
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
          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => setOffset(Math.max(offset - limit, 0))} disabled={offset === 0}>
              Previous
            </Button>
            <Button variant="ghost" onClick={() => setOffset(offset + limit)} disabled={offset + limit >= total}>
              Next
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Run Grid</CardTitle>
            <CardDescription>Latest results from the pipeline store.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="overflow-auto">
          <table className="min-w-full text-left text-sm">
            <thead>
              <tr className="border-b border-white/10 text-slate-400">
                {["Run", "Status", "Page", "Streams", "LLM", "Tools", "Tokens", "Cost", "Duration"].map((column) => (
                  <th key={column} className="px-3 py-3 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length ? (
                rows.map((row) => (
                  <tr key={row.run_id} className="border-b border-white/5 text-slate-200">
                    <td className="px-3 py-4 align-top">
                      <Link href={`/runs/${row.run_id}`} className="font-medium text-signal transition hover:text-white">
                        {row.run_id}
                      </Link>
                      <div className="mt-1 max-w-[260px] text-xs text-slate-500">{row.url}</div>
                    </td>
                    <td className="px-3 py-4 align-top">
                      <Badge
                        tone={row.final_status === "success" ? "success" : row.final_status === "partial" ? "warning" : "danger"}
                      >
                        {row.final_status}
                      </Badge>
                    </td>
                    <td className="px-3 py-4 align-top">{row.page_type}</td>
                    <td className="px-3 py-4 align-top">{formatNumber(row.stream_count)}</td>
                    <td className="px-3 py-4 align-top">{formatNumber(row.total_llm_calls)}</td>
                    <td className="px-3 py-4 align-top">{formatNumber(row.total_tool_calls)}</td>
                    <td className="px-3 py-4 align-top">
                      {formatNumber((row.total_tokens_in || 0) + (row.total_tokens_out || 0))}
                    </td>
                    <td className="px-3 py-4 align-top">{formatCurrency(row.estimated_total_cost_usd)}</td>
                    <td className="px-3 py-4 align-top">{Number(row.duration_seconds || 0).toFixed(2)}s</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-3 py-8 text-slate-500" colSpan={9}>
                    {isLoading ? "Loading runs..." : "No runs matched this slice."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
