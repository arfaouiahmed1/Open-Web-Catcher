"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  BookOpen,
  Database,
  FlaskConical,
  Loader2,
  Play,
  Sparkles,
} from "lucide-react";

import { apiFetch, apiUrl } from "@/lib/api";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/utils";
import { KpiCard } from "@/components/kpi-card";
import { StructuredDataCard } from "@/components/structured-data-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const SUITE_MODES = ["hybrid", "synthetic", "mocked", "live"];
const SAMPLE_URLS = [
  "https://example.com/watch/live-match",
  "https://example.org/stream/channel-1",
].join("\n");

const MODE_DETAILS = {
  hybrid: {
    label: "Use the suite as written",
    description:
      "Each saved case keeps its own mode. This is the safest default for saved suites.",
  },
  synthetic: {
    label: "Fixture replay only",
    description:
      "No real websites are opened. The suite replays stored artifacts and expected outputs.",
  },
  mocked: {
    label: "Mocked browser behavior",
    description:
      "Good for scoring logic and tool-handling checks without touching live websites.",
  },
  live: {
    label: "Real website run",
    description:
      "Open the real website with the real browser workflow and score the result.",
  },
};

function statusTone(status) {
  if (status === "completed" || status === "passed" || status === "ready")
    return "success";
  if (status === "running" || status === "warning") return "warning";
  return "danger";
}

function modeOptions(modes) {
  return modes.map((mode) => ({
    value: mode,
    label: mode,
    description: MODE_DETAILS[mode]?.description || "",
  }));
}

function runLabel(run, index) {
  if (run.name) return run.name;
  return run.run_id ? `${run.run_id.slice(0, 12)}...` : `Run ${index + 1}`;
}

function caseTarget(caseResult) {
  return caseResult?.output?.url || caseResult?.output?.input?.url || "";
}

function caseLabel(caseResult, index) {
  return caseResult.case_name || caseTarget(caseResult) || `Case ${index + 1}`;
}

function uniqueUrls(urls = []) {
  const seen = new Set();
  const normalized = [];
  for (const value of urls) {
    const url = String(value || "").trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    normalized.push(url);
  }
  return normalized;
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function InfoCard({ icon: Icon, title, children, tone = "signal" }) {
  const color =
    tone === "violet"
      ? "var(--violet)"
      : tone === "mint"
        ? "var(--mint)"
        : "var(--signal)";
  return (
    <div
      className="rounded-[14px] border p-4"
      style={{
        borderColor: `color-mix(in oklch, ${color} 20%, var(--line))`,
        borderTopColor: `color-mix(in oklch, ${color} 50%, transparent)`,
        borderTopWidth: "2px",
        background: "var(--card)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]"
          style={{
            background: `color-mix(in oklch, ${color} 14%, transparent)`,
            border: `1px solid color-mix(in oklch, ${color} 25%, transparent)`,
          }}
        >
          <Icon className="h-3.5 w-3.5" style={{ color }} />
        </div>
        <span className="text-[13.5px] font-semibold text-[var(--ink)]">
          {title}
        </span>
      </div>
      <div className="mt-3 text-[12.5px] leading-relaxed text-[var(--mute)]">
        {children}
      </div>
    </div>
  );
}

function SourceRow({ row, onAdd }) {
  const tone = statusTone(row.final_status || row.status || "failed");
  const initials = hostFromUrl(row.url || "")
    .slice(0, 2)
    .toUpperCase();
  return (
    <div
      className="group flex items-center gap-3 rounded-[12px] border px-3 py-2.5 transition-colors"
      style={{
        borderColor: "var(--line)",
        background: "rgba(255,255,255,0.018)",
      }}
    >
      <div
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] font-mono text-[11px] font-bold"
        style={{
          background: "rgba(255,255,255,0.04)",
          color: "var(--mute-2)",
          border: "1px solid var(--line)",
        }}
      >
        {initials}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="truncate text-[12.5px] font-medium"
          style={{ color: "var(--ink)" }}
        >
          {hostFromUrl(row.url || "")}
        </div>
        <div
          className="mt-0.5 truncate font-mono text-[10px]"
          style={{ color: "var(--mute-2)" }}
        >
          {row.url || "No URL"}
        </div>
      </div>
      <Badge tone={tone}>{row.final_status || row.status || "unknown"}</Badge>
      <Button
        size="sm"
        variant="ghost"
        className="shrink-0 border border-[var(--line)] opacity-0 transition-opacity group-hover:opacity-100"
        onClick={() => onAdd(row.url)}
      >
        Add
      </Button>
    </div>
  );
}

export default function EvaluationsPage() {
  const [suites, setSuites] = useState([]);
  const [runs, setRuns] = useState([]);
  const [sourceRuns, setSourceRuns] = useState([]);
  const [lab, setLab] = useState({
    ready: false,
    metrics: [],
    commands: {},
    warnings: [],
  });
  const [selectedSuiteId, setSelectedSuiteId] = useState("");
  const [suiteMode, setSuiteMode] = useState("hybrid");
  const [batchName, setBatchName] = useState("");
  const [urlsText, setUrlsText] = useState(SAMPLE_URLS);
  const [selectedRun, setSelectedRun] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSuiteRunning, setIsSuiteRunning] = useState(false);
  const [isBatchRunning, setIsBatchRunning] = useState(false);
  const [error, setError] = useState("");

  async function refreshEvaluationRuns() {
    const payload = await apiFetch("/ui/evaluations/runs?limit=20");
    setRuns(payload.runs || []);
    return payload.runs || [];
  }

  async function refreshSourceRuns() {
    const payload = await apiFetch("/ui/runs?limit=12&offset=0");
    const rows = payload.rows || [];
    const deduped = [];
    const seen = new Set();
    for (const row of rows) {
      const url = String(row.url || "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      deduped.push(row);
    }
    setSourceRuns(deduped);
    return deduped;
  }

  async function loadAll() {
    setIsLoading(true);
    const [suitePayload, runPayload, labPayload, sourcePayload] =
      await Promise.all([
        apiFetch("/ui/evaluations/suites"),
        apiFetch("/ui/evaluations/runs?limit=20"),
        apiFetch("/ui/evaluations/lab"),
        apiFetch("/ui/runs?limit=12&offset=0"),
      ]);

    const nextSuites = suitePayload.suites || [];
    const sourceRows = sourcePayload.rows || [];

    setSuites(nextSuites);
    setRuns(runPayload.runs || []);
    setLab(labPayload || {});
    setSourceRuns(
      uniqueUrls(sourceRows.map((row) => row.url))
        .map((url) => sourceRows.find((row) => row.url === url))
        .filter(Boolean),
    );

    if (!selectedSuiteId && nextSuites.length) {
      setSelectedSuiteId(String(nextSuites[0].id));
    }
    setIsLoading(false);
  }

  useEffect(() => {
    loadAll().catch((err) => {
      setError(err.message || "Failed to load evaluations.");
      setIsLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setBatchUrls(nextUrls, { replace = false } = {}) {
    const current = replace
      ? []
      : urlsText
          .split(/\r?\n/)
          .map((value) => value.trim())
          .filter(Boolean);
    const merged = uniqueUrls([...current, ...nextUrls]);
    setUrlsText(merged.join("\n"));
  }

  async function submitRun(payload) {
    const response = await fetch(apiUrl("/ui/evaluations/run"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) {
      throw new Error(body.detail || `Status ${response.status}`);
    }
    setSelectedRun(body);
    await refreshEvaluationRuns();
    return body;
  }

  async function runSuite() {
    if (!selectedSuiteId) return;
    setError("");
    setIsSuiteRunning(true);
    try {
      await submitRun({
        suite_id: Number(selectedSuiteId),
        mode: suiteMode,
      });
    } catch (err) {
      setError(err.message || "Suite run failed.");
    } finally {
      setIsSuiteRunning(false);
    }
  }

  async function runBatch() {
    const urls = urlsText
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (!urls.length) {
      setError("Add at least one website URL before starting a manual batch.");
      return;
    }

    setError("");
    setIsBatchRunning(true);
    try {
      await submitRun({
        batch_name: batchName,
        mode: "live",
        urls,
      });
    } catch (err) {
      setError(err.message || "Manual batch failed.");
    } finally {
      setIsBatchRunning(false);
    }
  }

  async function inspectRun(runId) {
    setError("");
    try {
      setSelectedRun(await apiFetch(`/ui/evaluations/runs/${runId}`));
    } catch (err) {
      setError(err.message || "Could not load evaluation run.");
    }
  }

  const suiteOptions = useMemo(
    () =>
      suites.map((suite) => ({
        value: String(suite.id),
        label: suite.name,
        description:
          suite.description ||
          `${formatNumber((suite.cases || []).length)} cases`,
        meta: `${formatNumber((suite.cases || []).length)} cases`,
      })),
    [suites],
  );

  const activeSuite =
    suites.find((suite) => String(suite.id) === String(selectedSuiteId)) ||
    suites[0];
  const activeCases = activeSuite?.cases || [];
  const batchTargets = urlsText
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  const selectedModeDetails = MODE_DETAILS[suiteMode] || MODE_DETAILS.hybrid;

  const topKpis = selectedRun
    ? [
        {
          label: "Pass rate",
          value: formatPercent(selectedRun.success_rate || 0),
          accent: "mint",
        },
        {
          label: "Hallucination",
          value: formatPercent(selectedRun.hallucination_rate || 0),
          accent:
            (selectedRun.hallucination_rate || 0) > 0.2 ? "rose" : undefined,
        },
        {
          label: "Tool accuracy",
          value: formatPercent(selectedRun.tool_accuracy_rate || 0),
        },
        {
          label: "Reliability",
          value: formatPercent(selectedRun.reliability_rate || 0),
          accent: "mint",
        },
      ]
    : [
        {
          label: "Saved suites",
          value: formatNumber(suites.length),
          description: "Reusable eval packs",
        },
        {
          label: "Suite cases",
          value: formatNumber(activeCases.length),
          description: "Cases in the selected suite",
        },
        {
          label: "Batch targets",
          value: formatNumber(batchTargets.length),
          description: "Websites queued manually",
        },
        {
          label: "Recent eval runs",
          value: formatNumber(runs.length),
          description: "Stored results",
        },
      ];

  return (
    <div className="space-y-6">
      <div>
        <span className="owc-eyebrow">evaluations · testing lab</span>
        <h1 className="mt-2 text-3xl font-semibold text-[var(--ink)]">
          Evaluation Lab
        </h1>
        <p className="mt-2 max-w-[68ch] text-[14px] leading-relaxed text-[var(--mute)]">
          Use a saved suite when you want repeatable regression tests. Use a
          manual batch when you just want to throw a list of websites at the
          workflow and see what happens.
        </p>
      </div>

      {error && (
        <div
          className="flex items-start gap-2 rounded-[12px] border px-3 py-3 text-[13px]"
          style={{
            borderColor: "color-mix(in oklch, var(--rose) 30%, transparent)",
            background: "color-mix(in oklch, var(--rose) 10%, transparent)",
            color: "var(--rose)",
          }}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-3">
        <InfoCard icon={BookOpen} title="What is a suite?">
          A suite is a saved set of test cases and scoring rules. Think of it as
          a reusable benchmark pack for the pipeline.
        </InfoCard>
        <InfoCard
          icon={FlaskConical}
          title="What do the modes mean?"
          tone="violet"
        >
          <span className="block">
            <strong className="text-[var(--ink)]">hybrid</strong>: keep each
            saved case in its own mode.
          </span>
          <span className="mt-1 block">
            <strong className="text-[var(--ink)]">synthetic</strong>: replay
            fixture data only.
          </span>
          <span className="mt-1 block">
            <strong className="text-[var(--ink)]">mocked</strong>: use fake
            traces and fake tool results.
          </span>
          <span className="mt-1 block">
            <strong className="text-[var(--ink)]">live</strong>: hit the real
            website with the real workflow.
          </span>
        </InfoCard>
        <InfoCard
          icon={Database}
          title="Where can I get websites to test?"
          tone="mint"
        >
          Pull URLs from your recent pipeline runs below, copy targets from{" "}
          <Link
            href="/runs"
            className="text-[var(--signal)] hover:text-[var(--ink)]"
          >
            Run History
          </Link>
          , or paste your own list into the manual batch box.
        </InfoCard>
      </div>

      {isLoading ? (
        <div
          className="flex h-48 items-center justify-center rounded-[14px] border text-[13px] text-[var(--mute)]"
          style={{
            borderColor: "var(--line)",
            background: "var(--card)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Loading evaluation lab...
        </div>
      ) : (
        <>
          <div className="grid gap-5 xl:grid-cols-[1.2fr_0.8fr]">
            <div className="space-y-5">
              <div
                className="rounded-[14px] border p-4"
                style={{
                  borderColor: "var(--line)",
                  background: "var(--card)",
                  boxShadow: "var(--shadow-card)",
                }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]"
                    style={{
                      background:
                        "color-mix(in oklch, var(--signal) 12%, transparent)",
                      border:
                        "1px solid color-mix(in oklch, var(--signal) 22%, transparent)",
                    }}
                  >
                    <FlaskConical
                      className="h-3.5 w-3.5"
                      style={{ color: "var(--signal)" }}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-[13.5px] font-semibold"
                      style={{ color: "var(--ink)" }}
                    >
                      Run saved suite
                    </div>
                    <div
                      className="text-[11px]"
                      style={{ color: "var(--mute)" }}
                    >
                      Score test cases against the pipeline
                    </div>
                  </div>
                  <Badge tone="signal">{activeSuite?.mode || suiteMode}</Badge>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-[1fr_240px_auto]">
                  <Select
                    label="Suite"
                    value={selectedSuiteId}
                    onChange={(value) => setSelectedSuiteId(value)}
                    options={suiteOptions}
                    placeholder="Choose a suite"
                    emptyMessage="No suites available"
                    searchable
                    searchPlaceholder="Search suites"
                  />
                  <Select
                    label="Mode"
                    value={suiteMode}
                    onChange={(value) => setSuiteMode(value)}
                    options={modeOptions(SUITE_MODES)}
                  />
                  <div className="flex items-end">
                    <Button
                      variant="accent"
                      className="h-11 w-full md:w-auto"
                      onClick={runSuite}
                      disabled={isSuiteRunning || !activeSuite}
                    >
                      {isSuiteRunning ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="h-3.5 w-3.5" />
                      )}
                      {isSuiteRunning ? "Running" : "Run suite"}
                    </Button>
                  </div>
                </div>

                {(() => {
                  const modeAccent = {
                    hybrid: "var(--signal)",
                    synthetic: "var(--violet)",
                    mocked: "var(--sky)",
                    live: "var(--mint)",
                  };
                  const accent = modeAccent[suiteMode] || "var(--signal)";
                  return (
                    <div
                      className="mt-3 rounded-[12px] border px-3 py-2.5"
                      style={{
                        borderColor: `color-mix(in oklch, ${accent} 22%, var(--line))`,
                        background: `color-mix(in oklch, ${accent} 5%, rgba(255,255,255,0.02))`,
                        borderLeft: `3px solid color-mix(in oklch, ${accent} 55%, transparent)`,
                      }}
                    >
                      <div
                        className="text-[12.5px] font-semibold"
                        style={{ color: "var(--ink)" }}
                      >
                        {selectedModeDetails.label}
                      </div>
                      <div
                        className="mt-0.5 text-[12px]"
                        style={{ color: "var(--mute)" }}
                      >
                        {selectedModeDetails.description}
                      </div>
                    </div>
                  );
                })()}

                {activeSuite && (
                  <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <KpiCard
                      label="Cases"
                      value={formatNumber(activeCases.length)}
                    />
                    <KpiCard
                      label="Synthetic"
                      value={formatNumber(
                        activeCases.filter((item) => item.mode === "synthetic")
                          .length,
                      )}
                    />
                    <KpiCard
                      label="Mocked"
                      value={formatNumber(
                        activeCases.filter((item) => item.mode === "mocked")
                          .length,
                      )}
                    />
                    <KpiCard
                      label="Live"
                      value={formatNumber(
                        activeCases.filter((item) => item.mode === "live")
                          .length,
                      )}
                    />
                  </div>
                )}
              </div>

              <div
                className="rounded-[14px] border p-4"
                style={{
                  borderColor: "var(--line)",
                  background: "var(--card)",
                  boxShadow: "var(--shadow-card)",
                }}
              >
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]"
                    style={{
                      background:
                        "color-mix(in oklch, var(--violet) 12%, transparent)",
                      border:
                        "1px solid color-mix(in oklch, var(--violet) 22%, transparent)",
                    }}
                  >
                    <Sparkles
                      className="h-3.5 w-3.5"
                      style={{ color: "var(--violet)" }}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className="text-[13.5px] font-semibold"
                      style={{ color: "var(--ink)" }}
                    >
                      Manual website batch
                    </div>
                    <div
                      className="text-[11px]"
                      style={{ color: "var(--mute)" }}
                    >
                      Run any URLs through the full live workflow
                    </div>
                  </div>
                  <Badge tone="violet">live workflow</Badge>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <Input
                    label="Batch name"
                    value={batchName}
                    onChange={(event) => setBatchName(event.target.value)}
                    placeholder="April smoke batch"
                  />
                  <div
                    className="rounded-[12px] border px-3 py-2.5"
                    style={{
                      borderColor:
                        "color-mix(in oklch, var(--mint) 22%, var(--line))",
                      background:
                        "color-mix(in oklch, var(--mint) 5%, rgba(255,255,255,0.02))",
                      borderLeft:
                        "3px solid color-mix(in oklch, var(--mint) 55%, transparent)",
                    }}
                  >
                    <div
                      className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                      style={{ color: "var(--mute-2)" }}
                    >
                      Mode
                    </div>
                    <div
                      className="mt-1 text-[12.5px] font-semibold"
                      style={{ color: "var(--mint)" }}
                    >
                      live
                    </div>
                    <div
                      className="mt-1 text-[11.5px]"
                      style={{ color: "var(--mute)" }}
                    >
                      Manual batches always run real websites with the real
                      browser workflow.
                    </div>
                  </div>
                </div>

                <div className="mt-3">
                  <Textarea
                    label="Websites"
                    value={urlsText}
                    onChange={(event) => setUrlsText(event.target.value)}
                    placeholder="https://example.com/watch/live-match"
                    className="min-h-[160px]"
                  />
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-[var(--mute)]">
                    <span>
                      {formatNumber(batchTargets.length)} website
                      {batchTargets.length !== 1 ? "s" : ""} queued
                    </span>
                    <span>One URL per line</span>
                    <span>One bad site will not stop the rest</span>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="accent"
                    className="h-11"
                    onClick={runBatch}
                    disabled={isBatchRunning}
                  >
                    {isBatchRunning ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Play className="h-3.5 w-3.5" />
                    )}
                    {isBatchRunning ? "Running batch" : "Run batch"}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-11 border border-[var(--line)]"
                    onClick={() =>
                      setBatchUrls(
                        sourceRuns.map((row) => row.url),
                        { replace: true },
                      )
                    }
                  >
                    Use recent URLs
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-11 border border-[var(--line)]"
                    onClick={() => setUrlsText("")}
                  >
                    Clear list
                  </Button>
                </div>
              </div>
            </div>

            <div className="space-y-5">
              <div
                className="rounded-[14px] border p-4"
                style={{
                  borderColor: "var(--line)",
                  background: "var(--card)",
                  boxShadow: "var(--shadow-card)",
                }}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px]"
                    style={{
                      background:
                        "color-mix(in oklch, var(--mint) 12%, transparent)",
                      border:
                        "1px solid color-mix(in oklch, var(--mint) 22%, transparent)",
                    }}
                  >
                    <Database
                      className="h-3.5 w-3.5"
                      style={{ color: "var(--mint)" }}
                    />
                  </div>
                  <span
                    className="text-[13.5px] font-semibold"
                    style={{ color: "var(--ink)" }}
                  >
                    Recent pipeline URLs
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto border border-[var(--line)]"
                    onClick={refreshSourceRuns}
                  >
                    Refresh
                  </Button>
                </div>

                <div className="mt-3 space-y-2">
                  {sourceRuns.length ? (
                    sourceRuns.map((row) => (
                      <SourceRow
                        key={row.run_id || row.url}
                        row={row}
                        onAdd={(url) => setBatchUrls([url])}
                      />
                    ))
                  ) : (
                    <div
                      className="rounded-[12px] border px-3 py-4 text-[12.5px] text-[var(--mute)]"
                      style={{ borderColor: "var(--line)" }}
                    >
                      No recent pipeline URLs yet. Run a workflow first, then
                      you can pull targets from here.
                    </div>
                  )}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    variant="ghost"
                    className="border border-[var(--line)]"
                    onClick={() =>
                      setBatchUrls(sourceRuns.map((row) => row.url))
                    }
                  >
                    Add all
                  </Button>
                  <Button
                    variant="ghost"
                    asChild
                    className="border border-[var(--line)]"
                  >
                    <Link href="/runs">Open Run History</Link>
                  </Button>
                </div>
              </div>

              <div
                className="rounded-[14px] border p-4"
                style={{
                  borderColor: "var(--line)",
                  background: "var(--card)",
                  boxShadow: "var(--shadow-card)",
                }}
              >
                <div className="flex items-center gap-2">
                  <span className="text-[13.5px] font-medium text-[var(--ink)]">
                    DeepEval status
                  </span>
                  <Badge
                    tone={lab.ready ? "success" : "warning"}
                    className="ml-auto"
                  >
                    {lab.ready ? "ready" : "needs setup"}
                  </Badge>
                </div>

                <div className="mt-4 flex flex-wrap gap-2">
                  <Badge tone={lab.deepeval_available ? "success" : "danger"}>
                    deepeval {lab.deepeval_available ? "installed" : "missing"}
                  </Badge>
                  <Badge
                    tone={lab.openai_package_available ? "success" : "danger"}
                  >
                    openai{" "}
                    {lab.openai_package_available ? "installed" : "missing"}
                  </Badge>
                  <Badge
                    tone={
                      lab.openrouter_api_key_configured ? "success" : "danger"
                    }
                  >
                    OpenRouter key{" "}
                    {lab.openrouter_api_key_configured ? "set" : "missing"}
                  </Badge>
                </div>

                <div className="mt-4 space-y-2">
                  <div
                    className="rounded-[12px] border px-3 py-2.5"
                    style={{
                      borderColor: "var(--line)",
                      background: "rgba(255,255,255,0.02)",
                    }}
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
                      Run with pytest
                    </div>
                    <div className="mt-1 font-mono text-[11.5px] text-[var(--ink-dim)]">
                      {lab.commands?.pytest ||
                        "pytest tests/test_deepeval_metrics.py -v"}
                    </div>
                  </div>
                  <div
                    className="rounded-[12px] border px-3 py-2.5"
                    style={{
                      borderColor: "var(--line)",
                      background: "rgba(255,255,255,0.02)",
                    }}
                  >
                    <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--mute-2)]">
                      Run with DeepEval CLI
                    </div>
                    <div className="mt-1 font-mono text-[11.5px] text-[var(--ink-dim)]">
                      {lab.commands?.deepeval ||
                        "deepeval test run tests/test_deepeval_metrics.py"}
                    </div>
                  </div>
                </div>

                {!!lab.warnings?.length && (
                  <div className="mt-4 space-y-2">
                    {lab.warnings.map((warning) => (
                      <div
                        key={warning}
                        className="rounded-[12px] border px-3 py-2.5 text-[12.5px]"
                        style={{
                          borderColor:
                            "color-mix(in oklch, var(--signal) 30%, transparent)",
                          background:
                            "color-mix(in oklch, var(--signal) 8%, transparent)",
                          color: "var(--ink-dim)",
                        }}
                      >
                        {warning}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {topKpis.map((kpi) => (
              <KpiCard key={kpi.label} {...kpi} />
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-[320px_1fr]">
            <div
              className="overflow-hidden rounded-[14px] border"
              style={{
                borderColor: "var(--line)",
                background: "var(--card)",
                boxShadow: "var(--shadow-card)",
              }}
            >
              <div
                className="border-b px-[18px] py-3.5"
                style={{ borderColor: "var(--line)" }}
              >
                <span className="text-[13.5px] font-medium text-[var(--ink)]">
                  Recent evaluation runs
                </span>
              </div>
              <div className="divide-y" style={{ borderColor: "var(--line)" }}>
                {runs.length ? (
                  runs.map((run, index) => (
                    <button
                      key={run.run_id}
                      onClick={() => inspectRun(run.run_id)}
                      className="w-full px-4 py-3 text-left transition-colors hover:bg-white/[0.025]"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-[var(--ink)]">
                          {runLabel(run, index)}
                        </span>
                        <Badge tone={statusTone(run.status)}>
                          {run.status}
                        </Badge>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-[var(--mute)]">
                        <span>Pass {formatPercent(run.success_rate || 0)}</span>
                        <span>
                          Halluc. {formatPercent(run.hallucination_rate || 0)}
                        </span>
                        <span>
                          Tools {formatPercent(run.tool_accuracy_rate || 0)}
                        </span>
                        <span>
                          Reliability {formatPercent(run.reliability_rate || 0)}
                        </span>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="px-4 py-8 text-center text-[13px] text-[var(--mute)]">
                    No evaluation runs yet
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-4">
              {selectedRun ? (
                <>
                  <div
                    className="rounded-[14px] border p-4"
                    style={{
                      borderColor: "var(--line)",
                      background: "var(--card)",
                      boxShadow: "var(--shadow-card)",
                    }}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[14px] font-medium text-[var(--ink)]">
                        {selectedRun.name || "Selected run"}
                      </span>
                      <Badge tone={statusTone(selectedRun.status)}>
                        {selectedRun.status}
                      </Badge>
                      {selectedRun.summary?.source && (
                        <Badge
                          tone={
                            selectedRun.summary.source === "manual_batch"
                              ? "violet"
                              : "signal"
                          }
                        >
                          {selectedRun.summary.source === "manual_batch"
                            ? "manual batch"
                            : "saved suite"}
                        </Badge>
                      )}
                      <span className="ml-auto text-[12px] text-[var(--mute)]">
                        {formatNumber(selectedRun.case_count || 0)} case
                        {selectedRun.case_count === 1 ? "" : "s"} · avg latency{" "}
                        {Number(selectedRun.avg_latency_ms || 0).toFixed(0)}ms
                      </span>
                    </div>
                    {!!selectedRun.summary?.input_urls?.length && (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {selectedRun.summary.input_urls
                          .slice(0, 5)
                          .map((url) => (
                            <span
                              key={url}
                              className="rounded-full border px-2 py-0.5 font-mono text-[10.5px]"
                              style={{
                                borderColor: "var(--line)",
                                background: "rgba(255,255,255,0.02)",
                                color: "var(--mute)",
                              }}
                              title={url}
                            >
                              {hostFromUrl(url)}
                            </span>
                          ))}
                      </div>
                    )}
                  </div>

                  <div
                    className="overflow-hidden rounded-[14px] border"
                    style={{
                      borderColor: "var(--line)",
                      background: "var(--card)",
                      boxShadow: "var(--shadow-card)",
                    }}
                  >
                    <div
                      className="border-b px-[18px] py-3.5"
                      style={{ borderColor: "var(--line)" }}
                    >
                      <span className="text-[13.5px] font-medium text-[var(--ink)]">
                        Case results
                      </span>
                    </div>
                    <div
                      className="divide-y"
                      style={{ borderColor: "var(--line)" }}
                    >
                      {(selectedRun.case_results || []).length ? (
                        selectedRun.case_results.map((caseResult, index) => (
                          <div
                            key={`${caseLabel(caseResult, index)}-${index}`}
                            className="px-[18px] py-3"
                          >
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <div className="truncate text-[13px] font-medium text-[var(--ink)]">
                                  {caseLabel(caseResult, index)}
                                </div>
                                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--mute)]">
                                  <span>{caseResult.target_type}</span>
                                  {caseTarget(caseResult) && (
                                    <span className="truncate font-mono">
                                      {caseTarget(caseResult)}
                                    </span>
                                  )}
                                </div>
                              </div>
                              <Badge tone={statusTone(caseResult.status)}>
                                {caseResult.status}
                              </Badge>
                            </div>
                            <div className="mt-2 grid gap-x-6 gap-y-1 text-[12px] text-[var(--mute)] sm:grid-cols-4">
                              <span>
                                Latency{" "}
                                {Number(caseResult.latency_ms || 0).toFixed(0)}
                                ms
                              </span>
                              <span>
                                Cost{" "}
                                {formatCurrency(caseResult.total_cost_usd || 0)}
                              </span>
                              <span>
                                Halluc.{" "}
                                {formatPercent(
                                  caseResult.hallucination_score || 0,
                                )}
                              </span>
                              <span>
                                Tools{" "}
                                {formatPercent(
                                  caseResult.tool_accuracy_score || 0,
                                )}
                              </span>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="px-4 py-6 text-center text-[13px] text-[var(--mute)]">
                          No case results
                        </div>
                      )}
                    </div>
                  </div>

                  <StructuredDataCard
                    title="Run summary"
                    description="Structured evaluation metadata and aggregate results."
                    data={{
                      run_id: selectedRun.run_id,
                      name: selectedRun.name,
                      status: selectedRun.status,
                      source: selectedRun.summary?.source || "unknown",
                      case_count: selectedRun.case_count || 0,
                      success_rate: formatPercent(
                        selectedRun.success_rate || 0,
                      ),
                      hallucination_rate: formatPercent(
                        selectedRun.hallucination_rate || 0,
                      ),
                      tool_accuracy_rate: formatPercent(
                        selectedRun.tool_accuracy_rate || 0,
                      ),
                      reliability_rate: formatPercent(
                        selectedRun.reliability_rate || 0,
                      ),
                      avg_latency_ms: Number(
                        selectedRun.avg_latency_ms || 0,
                      ).toFixed(0),
                      input_urls: selectedRun.summary?.input_urls || [],
                    }}
                  />
                </>
              ) : (
                <div
                  className="flex h-48 items-center justify-center rounded-[14px] border border-dashed text-[13px] text-[var(--mute)]"
                  style={{ borderColor: "var(--line)" }}
                >
                  Select an evaluation run to inspect its case-level results.
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
