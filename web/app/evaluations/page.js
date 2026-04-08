"use client";

import { useEffect, useState } from "react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { JsonViewer } from "@/components/json-viewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";

const MODES = ["hybrid", "synthetic", "mocked", "live"];

export default function EvaluationsPage() {
  const [suites, setSuites] = useState([]);
  const [runs, setRuns] = useState([]);
  const [selectedSuiteId, setSelectedSuiteId] = useState("");
  const [mode, setMode] = useState("hybrid");
  const [selectedRun, setSelectedRun] = useState(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    async function load() {
      const [suitePayload, runPayload] = await Promise.all([
        apiFetch("/ui/evaluations/suites"),
        apiFetch("/ui/evaluations/runs?limit=20")
      ]);
      setSuites(suitePayload.suites || []);
      setRuns(runPayload.runs || []);
      if (!selectedSuiteId && suitePayload.suites?.length) {
        setSelectedSuiteId(String(suitePayload.suites[0].id));
      }
    }
    load();
  }, [selectedSuiteId]);

  async function runSuite() {
    setIsRunning(true);
    try {
      const response = await fetch(apiUrl("/ui/evaluations/run"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          suite_id: selectedSuiteId ? Number(selectedSuiteId) : null,
          mode
        })
      });
      const payload = await response.json();
      setSelectedRun(payload);
      const refreshed = await apiFetch("/ui/evaluations/runs?limit=20");
      setRuns(refreshed.runs || []);
    } finally {
      setIsRunning(false);
    }
  }

  async function inspectRun(runId) {
    setSelectedRun(await apiFetch(`/ui/evaluations/runs/${runId}`));
  }

  const activeSuite = suites.find((suite) => String(suite.id) === String(selectedSuiteId)) || suites[0];

  return (
    <div className="space-y-6">
      <section className="max-w-4xl">
        <div className="text-xs uppercase tracking-[0.4em] text-spark">Evaluations</div>
        <h1 className="mt-3 text-4xl font-semibold">Reliability and hallucination lab</h1>
        <p className="mt-4 text-base leading-7 text-slate-300">
          Run synthetic, mocked, hybrid, or live evaluation suites to score evidence discipline, tool usage accuracy, and operational reliability.
        </p>
      </section>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Launch Suite</CardTitle>
            <CardDescription>Start a benchmark run and persist the result set into Postgres.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px_180px]">
          <Select value={selectedSuiteId} onChange={(event) => setSelectedSuiteId(event.target.value)}>
            {suites.map((suite) => (
              <option key={suite.id} value={suite.id}>
                {suite.name}
              </option>
            ))}
          </Select>
          <Select value={mode} onChange={(event) => setMode(event.target.value)}>
            {MODES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </Select>
          <Button variant="accent" onClick={runSuite} disabled={isRunning || !activeSuite}>
            {isRunning ? "Running..." : "Run evaluation"}
          </Button>
        </CardContent>
      </Card>

      {activeSuite ? (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>{activeSuite.name}</CardTitle>
              <CardDescription>{activeSuite.description}</CardDescription>
            </div>
            <Badge tone="signal">{activeSuite.mode}</Badge>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard label="Cases" value={formatNumber((activeSuite.cases || []).length)} />
            <MetricCard
              label="Synthetic"
              value={formatNumber((activeSuite.cases || []).filter((item) => item.mode === "synthetic").length)}
            />
            <MetricCard
              label="Mocked"
              value={formatNumber((activeSuite.cases || []).filter((item) => item.mode === "mocked").length)}
            />
            <MetricCard
              label="Live Targets"
              value={formatNumber((activeSuite.cases || []).filter((item) => item.mode === "live").length)}
            />
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Recent Benchmark Runs</CardTitle>
              <CardDescription>Persisted suite results with success, hallucination, and reliability scores.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {runs.length ? (
              runs.map((run) => (
                <button
                  key={run.run_id}
                  type="button"
                  onClick={() => inspectRun(run.run_id)}
                  className="w-full rounded-[24px] border border-white/10 bg-black/20 p-4 text-left transition hover:border-signal/50 hover:bg-black/30"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium text-white">{run.name || run.run_id}</div>
                      <div className="mt-1 text-xs text-slate-500">{run.run_id}</div>
                    </div>
                    <Badge tone={run.status === "completed" ? "success" : run.status === "running" ? "warning" : "danger"}>
                      {run.status}
                    </Badge>
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-300">
                    <div>Success {formatPercent(run.success_rate || 0)}</div>
                    <div>Hallucination {formatPercent(run.hallucination_rate || 0)}</div>
                    <div>Tool Accuracy {formatPercent(run.tool_accuracy_rate || 0)}</div>
                    <div>Reliability {formatPercent(run.reliability_rate || 0)}</div>
                  </div>
                </button>
              ))
            ) : (
              <div className="rounded-[24px] border border-dashed border-white/10 p-8 text-sm text-slate-500">
                No evaluation runs yet.
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Selected Result</CardTitle>
              <CardDescription>Case-level assertion outcomes, latency, and cost breakdowns.</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {selectedRun ? (
              <>
                <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                  <MetricCard label="Success" value={formatPercent(selectedRun.success_rate || 0)} />
                  <MetricCard label="Hallucination" value={formatPercent(selectedRun.hallucination_rate || 0)} />
                  <MetricCard label="Tool Accuracy" value={formatPercent(selectedRun.tool_accuracy_rate || 0)} />
                  <MetricCard label="Reliability" value={formatPercent(selectedRun.reliability_rate || 0)} />
                </div>
                <div className="grid gap-3">
                  {(selectedRun.case_results || []).map((caseResult, index) => (
                    <div key={`${caseResult.case_name}-${index}`} className="rounded-[24px] border border-white/10 bg-black/20 p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="font-medium text-white">{caseResult.case_name || `Case ${index + 1}`}</div>
                          <div className="mt-1 text-xs text-slate-500">{caseResult.target_type}</div>
                        </div>
                        <Badge tone={caseResult.status === "passed" ? "success" : "danger"}>{caseResult.status}</Badge>
                      </div>
                      <div className="mt-4 grid gap-3 text-sm text-slate-300 md:grid-cols-2">
                        <div>Latency {Number(caseResult.latency_ms || 0).toFixed(1)}ms</div>
                        <div>Cost {formatCurrency(caseResult.total_cost_usd || 0)}</div>
                        <div>Hallucination score {formatPercent(caseResult.hallucination_score || 0)}</div>
                        <div>Tool accuracy {formatPercent(caseResult.tool_accuracy_score || 0)}</div>
                      </div>
                    </div>
                  ))}
                </div>
                <JsonViewer label="Evaluation Run" value={selectedRun} />
              </>
            ) : (
              <div className="rounded-[24px] border border-dashed border-white/10 p-8 text-sm text-slate-500">
                Select a run or start a new benchmark to inspect its case results.
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function MetricCard({ label, value }) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-black/20 p-4">
      <div className="text-xs uppercase tracking-[0.3em] text-slate-500">{label}</div>
      <div className="mt-3 text-2xl font-semibold text-white">{value}</div>
    </div>
  );
}
