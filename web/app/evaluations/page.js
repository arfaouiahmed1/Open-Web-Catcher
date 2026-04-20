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
  if (s === "running") return "warning";
  return "danger";
}

export default function EvaluationsPage() {
  const [suites, setSuites]           = useState([]);
  const [runs, setRuns]               = useState([]);
  const [selectedSuiteId, setSuiteId] = useState("");
  const [mode, setMode]               = useState("hybrid");
  const [selectedRun, setSelectedRun] = useState(null);
  const [isRunning, setIsRunning]     = useState(false);

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

      {/* page header */}
      <div>
        <span className="owc-eyebrow">evaluations · reliability lab</span>
        <h1 className="mt-2 font-['Inter_Tight',sans-serif] text-3xl font-medium tracking-tight text-[var(--ink)]">
          Benchmark suites
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          Score evidence discipline, tool accuracy, and operational reliability using DeepEval + OpenRouter.
        </p>
      </div>

      {/* launch card */}
      <div
        className="rounded-[14px] border p-4 space-y-3"
        style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
      >
        <div className="flex items-center gap-2">
          <FlaskConical className="h-3.5 w-3.5" style={{ color: "var(--signal)" }} />
          <span className="text-[13.5px] font-medium text-[var(--ink)]">Launch suite</span>
        </div>
        <div className="flex flex-wrap gap-3">
          <select
            value={selectedSuiteId}
            onChange={(e) => setSuiteId(e.target.value)}
            className="flex-1 rounded-lg border px-3 py-2 text-[13px] focus:outline-none"
            style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)", color: "var(--ink-dim)" }}
          >
            {suites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            {!suites.length && <option>No suites available</option>}
          </select>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="rounded-lg border px-3 py-2 text-[13px] focus:outline-none"
            style={{ borderColor: "var(--line)", background: "rgba(0,0,0,0.2)", color: "var(--ink-dim)" }}
          >
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <Button variant="accent" onClick={runSuite} disabled={isRunning || !activeSuite}>
            <Play className="mr-1.5 h-3.5 w-3.5" />
            {isRunning ? "Running…" : "Run evaluation"}
          </Button>
        </div>

        {activeSuite && (
          <div className="border-t pt-3" style={{ borderColor: "var(--line)" }}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-medium text-[var(--ink)]">{activeSuite.name}</span>
              {activeSuite.description && (
                <span className="text-[12px] text-[var(--mute)]">{activeSuite.description}</span>
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
        <div
          className="rounded-[14px] border overflow-hidden"
          style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
        >
          <div className="border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
            <span className="text-[13.5px] font-medium text-[var(--ink)]">Recent runs</span>
          </div>
          <div className="divide-y" style={{ borderColor: "var(--line)" }}>
            {runs.length ? runs.map((run) => (
              <button
                key={run.run_id}
                onClick={() => inspectRun(run.run_id)}
                className="w-full px-4 py-3 text-left transition-colors"
                onMouseEnter={(e) => e.currentTarget.style.background = "rgba(255,255,255,0.025)"}
                onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] font-medium text-[var(--ink)] truncate">{run.name || run.run_id?.slice(0, 12) + "…"}</span>
                  <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-[var(--mute)]">
                  <span>Pass {formatPercent(run.success_rate || 0)}</span>
                  <span>Halluc. {formatPercent(run.hallucination_rate || 0)}</span>
                  <span>Tools {formatPercent(run.tool_accuracy_rate || 0)}</span>
                  <span>Reliability {formatPercent(run.reliability_rate || 0)}</span>
                </div>
              </button>
            )) : (
              <div className="px-4 py-8 text-center text-[13px] text-[var(--mute)]">No evaluation runs yet</div>
            )}
          </div>
        </div>

        {/* selected result */}
        <div className="space-y-4">
          {selectedRun ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <KpiCard label="Pass rate"     value={formatPercent(selectedRun.success_rate || 0)}       accent="mint" />
                <KpiCard label="Hallucination" value={formatPercent(selectedRun.hallucination_rate || 0)} accent={(selectedRun.hallucination_rate || 0) > 0.2 ? "rose" : undefined} />
                <KpiCard label="Tool accuracy" value={formatPercent(selectedRun.tool_accuracy_rate || 0)} />
                <KpiCard label="Reliability"   value={formatPercent(selectedRun.reliability_rate || 0)} />
              </div>

              <div
                className="rounded-[14px] border overflow-hidden"
                style={{ borderColor: "var(--line)", background: "var(--card)", boxShadow: "var(--shadow-card)" }}
              >
                <div className="border-b px-[18px] py-3.5" style={{ borderColor: "var(--line)" }}>
                  <span className="text-[13.5px] font-medium text-[var(--ink)]">Case results</span>
                </div>
                <div className="divide-y" style={{ borderColor: "var(--line)" }}>
                  {(selectedRun.case_results || []).map((c, i) => (
                    <div key={`${c.case_name}-${i}`} className="px-[18px] py-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <div className="text-[13px] font-medium text-[var(--ink)]">{c.case_name || `Case ${i + 1}`}</div>
                          <div className="mt-0.5 text-[11px] text-[var(--mute)]">{c.target_type}</div>
                        </div>
                        <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-[12px] text-[var(--mute)] sm:grid-cols-4">
                        <span>Latency {Number(c.latency_ms || 0).toFixed(0)}ms</span>
                        <span>Cost {formatCurrency(c.total_cost_usd || 0)}</span>
                        <span>Halluc. {formatPercent(c.hallucination_score || 0)}</span>
                        <span>Tools {formatPercent(c.tool_accuracy_score || 0)}</span>
                      </div>
                    </div>
                  ))}
                  {!(selectedRun.case_results || []).length && (
                    <div className="px-4 py-6 text-center text-[13px] text-[var(--mute)]">No case results</div>
                  )}
                </div>
              </div>

              <JsonViewer label="Raw result" value={selectedRun} />
            </>
          ) : (
            <div
              className="flex h-48 items-center justify-center rounded-[14px] border border-dashed text-[13px] text-[var(--mute)]"
              style={{ borderColor: "var(--line)" }}
            >
              Select a run to inspect its case-level results
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
