"use client";

import { useEffect, useState } from "react";
import { FlaskConical, Play } from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { JsonViewer } from "@/components/json-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { KpiCard } from "@/components/kpi-card";

const MODES = ["hybrid", "synthetic", "mocked", "live"];

function statusTone(s) {
  if (s === "completed" || s === "passed") return "success";
  if (s === "running")  return "warning";
  return "danger";
}

export default function EvaluationsPage() {
  const [suites, setSuites]             = useState([]);
  const [runs, setRuns]                 = useState([]);
  const [selectedSuiteId, setSuiteId]   = useState("");
  const [mode, setMode]                 = useState("hybrid");
  const [selectedRun, setSelectedRun]   = useState(null);
  const [isRunning, setIsRunning]       = useState(false);

  async function loadAll() {
    const [sp, rp] = await Promise.all([
      apiFetch("/ui/evaluations/suites"),
      apiFetch("/ui/evaluations/runs?limit=20"),
    ]);
    const s = sp.suites || [];
    setSuites(s);
    setRuns(rp.runs || []);
    if (!selectedSuiteId && s.length) setSuiteId(String(s[0].id));
  }

  useEffect(() => { loadAll(); }, []); // eslint-disable-line

  async function runSuite() {
    setIsRunning(true);
    try {
      const res = await fetch(apiUrl("/ui/evaluations/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ suite_id: selectedSuiteId ? Number(selectedSuiteId) : null, mode }),
      });
      const payload = await res.json();
      setSelectedRun(payload);
      const rp = await apiFetch("/ui/evaluations/runs?limit=20");
      setRuns(rp.runs || []);
    } finally {
      setIsRunning(false);
    }
  }

  async function inspectRun(runId) {
    setSelectedRun(await apiFetch(`/ui/evaluations/runs/${runId}`));
  }

  const activeSuite = suites.find((s) => String(s.id) === String(selectedSuiteId)) || suites[0];
  const cases = activeSuite?.cases || [];

  return (
    <div className="space-y-6">

      {/* header */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-spark">Evaluations</p>
        <h1 className="mt-1 text-2xl font-semibold text-white">Reliability & hallucination lab</h1>
        <p className="mt-0.5 text-sm text-slate-500">
          Run benchmark suites to score evidence discipline, tool accuracy, and operational reliability using DeepEval + OpenRouter.
        </p>
      </div>

      {/* launch card */}
      <div className="rounded-xl border border-white/8 bg-white/[0.03] p-4 space-y-3">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-spark" />
          <span className="text-sm font-semibold text-white">Launch suite</span>
        </div>
        <div className="flex flex-wrap gap-3">
          <select
            value={selectedSuiteId}
            onChange={(e) => setSuiteId(e.target.value)}
            className="flex-1 rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-300 focus:border-signal/50 focus:outline-none"
          >
            {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {!suites.length && <option>No suites available</option>}
          </select>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="rounded-lg border border-white/10 bg-black/20 px-3 py-2 text-sm text-slate-300 focus:border-signal/50 focus:outline-none"
          >
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <Button variant="accent" onClick={runSuite} disabled={isRunning || !activeSuite}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {isRunning ? "Running…" : "Run evaluation"}
          </Button>
        </div>

        {activeSuite && (
          <div className="border-t border-white/6 pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-white">{activeSuite.name}</span>
              {activeSuite.description && (
                <span className="text-xs text-slate-500">{activeSuite.description}</span>
              )}
              <Badge tone="signal" className="ml-auto">{activeSuite.mode || mode}</Badge>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-4">
              <KpiCard label="Total cases"  value={formatNumber(cases.length)} />
              <KpiCard label="Synthetic"    value={formatNumber(cases.filter((c) => c.mode === "synthetic").length)} />
              <KpiCard label="Mocked"       value={formatNumber(cases.filter((c) => c.mode === "mocked").length)} />
              <KpiCard label="Live targets" value={formatNumber(cases.filter((c) => c.mode === "live").length)} />
            </div>
          </div>
        )}
      </div>

      {/* runs + results */}
      <div className="grid gap-5 xl:grid-cols-[320px_1fr]">

        {/* run list */}
        <div className="rounded-xl border border-white/8 bg-white/[0.03] overflow-hidden">
          <div className="border-b border-white/6 px-4 py-3">
            <span className="text-xs font-semibold text-white">Recent runs</span>
          </div>
          <div className="divide-y divide-white/4">
            {runs.length ? runs.map((run) => (
              <button
                key={run.run_id}
                onClick={() => inspectRun(run.run_id)}
                className="w-full px-4 py-3 text-left transition-colors hover:bg-white/[0.04]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-white truncate">{run.name || run.run_id?.slice(0, 12) + "…"}</span>
                  <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span>Pass {formatPercent(run.success_rate || 0)}</span>
                  <span>Halluc. {formatPercent(run.hallucination_rate || 0)}</span>
                  <span>Tools {formatPercent(run.tool_accuracy_rate || 0)}</span>
                  <span>Reliability {formatPercent(run.reliability_rate || 0)}</span>
                </div>
              </button>
            )) : (
              <div className="px-4 py-8 text-center text-sm text-slate-600">No evaluation runs yet</div>
            )}
          </div>
        </div>

        {/* selected result */}
        <div className="space-y-4">
          {selectedRun ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <KpiCard label="Pass rate"     value={formatPercent(selectedRun.success_rate || 0)}       accent="text-surge" />
                <KpiCard label="Hallucination" value={formatPercent(selectedRun.hallucination_rate || 0)} accent={(selectedRun.hallucination_rate || 0) > 0.2 ? "text-ember" : undefined} />
                <KpiCard label="Tool accuracy" value={formatPercent(selectedRun.tool_accuracy_rate || 0)} />
                <KpiCard label="Reliability"   value={formatPercent(selectedRun.reliability_rate || 0)} />
              </div>

              <div className="rounded-xl border border-white/8 bg-white/[0.03] overflow-hidden">
                <div className="border-b border-white/6 px-4 py-3 text-xs font-semibold text-white">Case results</div>
                <div className="divide-y divide-white/4">
                  {(selectedRun.case_results || []).map((c, i) => (
                    <div key={`${c.case_name}-${i}`} className="px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium text-white">{c.case_name || `Case ${i + 1}`}</div>
                          <div className="mt-0.5 text-xs text-slate-600">{c.target_type}</div>
                        </div>
                        <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-500 sm:grid-cols-4">
                        <span>Latency {Number(c.latency_ms || 0).toFixed(0)}ms</span>
                        <span>Cost {formatCurrency(c.total_cost_usd || 0)}</span>
                        <span>Halluc. {formatPercent(c.hallucination_score || 0)}</span>
                        <span>Tools {formatPercent(c.tool_accuracy_score || 0)}</span>
                      </div>
                    </div>
                  ))}
                  {!(selectedRun.case_results || []).length && (
                    <div className="px-4 py-6 text-center text-sm text-slate-600">No case results</div>
                  )}
                </div>
              </div>

              <JsonViewer label="Raw result" value={selectedRun} />
            </>
          ) : (
            <div className="flex h-48 items-center justify-center rounded-xl border border-dashed border-white/8 text-sm text-slate-600">
              Select a run to inspect its case-level results
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
