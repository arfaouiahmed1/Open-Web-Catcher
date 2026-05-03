"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  Loader2,
  Play,
  Radio,
  Route,
  Waypoints,
  Workflow,
} from "lucide-react";

import { apiUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";

const MODE_OPTIONS = [
  {
    value: "workflow",
    label: "Workflow",
    description: "Classification plus downstream landing, hosting, and embedded stages.",
    icon: Workflow,
  },
  {
    value: "agent",
    label: "Single agent",
    description: "Run one agent directly from the same /live page.",
    icon: Bot,
  },
];

const AGENT_OPTIONS = [
  {
    value: "classification",
    label: "Classification",
    detail: "Route the page and reset context once classification finishes.",
  },
  {
    value: "landing",
    label: "Landing",
    detail: "Inspect the landing-page branch without the full pipeline.",
  },
  {
    value: "hosting",
    label: "Hosting",
    detail: "Run hosting-page extraction directly, including parallel stream work.",
  },
  {
    value: "embedded",
    label: "Embedded",
    detail: "Test the embedded-player path in isolation.",
  },
];

export function RunLauncher({ defaultMode = "workflow" }) {
  const router = useRouter();
  const initialMode =
    MODE_OPTIONS.some((option) => option.value === defaultMode) ? defaultMode : "workflow";
  const [mode, setMode] = useState(initialMode);
  const [agent, setAgent] = useState("classification");
  const [url, setUrl] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState("");

  const stages =
    mode === "workflow"
      ? [
          {
            label: "Classify",
            detail: "Read the page and route the workflow.",
            icon: Radio,
            tone: "var(--sky)",
          },
          {
            label: "Route",
            detail: "Decide landing, hosting, or embedded follow-up.",
            icon: Route,
            tone: "var(--violet)",
          },
          {
            label: "Parallelize",
            detail: "Landing, hosting, and embedded branches can fan out in parallel.",
            icon: Waypoints,
            tone: "var(--mint)",
          },
        ]
      : AGENT_OPTIONS.map((option) => ({
          label: option.label,
          detail: option.detail,
          icon: option.value === agent ? Bot : Radio,
          tone: option.value === agent ? "var(--signal)" : "var(--mute-2)",
        }));

  async function startRun() {
    if (!url || isStarting) return;
    setIsStarting(true);
    setError("");
    try {
      const endpoint = mode === "workflow" ? "/ui/workflows/run" : "/ui/agents/test";
      const body = mode === "workflow" ? { url } : { agent, url };
      const response = await fetch(apiUrl(endpoint), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.detail || `Start failed (${response.status})`);
      }
      const runId = payload.run_id;
      if (!runId) throw new Error("Server did not return a run_id");
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent("owc:track-run", { detail: { runId } }),
        );
      }
      router.push(`/runs/${runId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setIsStarting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <span className="owc-eyebrow">launch</span>
        <h1 className="mt-2 text-3xl font-semibold text-[var(--ink)]">
          Live runs
        </h1>
        <p className="mt-1.5 max-w-[62ch] text-[13.5px] leading-relaxed text-[var(--mute)]">
          Start either the full workflow or a single-agent run from one page
          and jump directly into the live trace. The run detail view will stream
          tool calls, model activity, screenshots, costs, and stage-level
          context usage as the run executes.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_340px]">
        <div
          className="overflow-hidden rounded-[18px] border"
          style={{
            borderColor: "var(--line)",
            background:
              "linear-gradient(135deg, color-mix(in oklch, var(--signal) 9%, var(--card)) 0%, var(--card) 42%, color-mix(in oklch, var(--sky) 7%, var(--card)) 100%)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <div className="border-b px-5 py-4" style={{ borderColor: "var(--line)" }}>
            <div className="flex flex-wrap items-center gap-2">
              {MODE_OPTIONS.map((option) => {
                const Icon = option.icon;
                const active = mode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => {
                      setMode(option.value);
                      setError("");
                    }}
                    className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors"
                    style={{
                      borderColor: active
                        ? "color-mix(in oklch, var(--signal) 35%, transparent)"
                        : "var(--line)",
                      background: active
                        ? "color-mix(in oklch, var(--signal) 14%, transparent)"
                        : "transparent",
                      color: active ? "var(--signal)" : "var(--ink-dim)",
                    }}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {option.label}
                  </button>
                );
              })}
              <span className="text-[12px]" style={{ color: "var(--mute)" }}>
                {mode === "workflow"
                  ? "One URL in, full pipeline out."
                  : "Single-agent testing now launches from this same page."}
              </span>
            </div>
          </div>

          <div className="space-y-5 px-5 py-5">
            {mode === "agent" ? (
              <div>
                <label
                  className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                  style={{ color: "var(--mute-2)" }}
                >
                  Agent
                </label>
                <div className="mt-2 grid gap-3 md:grid-cols-2">
                  {AGENT_OPTIONS.map((option) => {
                    const active = agent === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          setAgent(option.value);
                          setError("");
                        }}
                        className="rounded-[14px] border px-4 py-3 text-left transition-colors"
                        style={{
                          borderColor: active
                            ? "color-mix(in oklch, var(--signal) 35%, transparent)"
                            : "var(--line)",
                          background: active
                            ? "color-mix(in oklch, var(--signal) 10%, var(--bg))"
                            : "color-mix(in oklch, var(--bg) 76%, transparent)",
                        }}
                      >
                        <div className="text-[12px] font-semibold text-[var(--ink)]">
                          {option.label}
                        </div>
                        <div
                          className="mt-1 text-[11.5px] leading-relaxed"
                          style={{ color: "var(--mute)" }}
                        >
                          {option.detail}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div>
              <label
                className="text-[10px] font-semibold uppercase tracking-[0.14em]"
                style={{ color: "var(--mute-2)" }}
              >
                Target URL
              </label>
              <div className="mt-2 flex flex-wrap gap-3">
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") startRun();
                  }}
                  placeholder="https://streaming-site.example.com/watch/123"
                  className="min-w-[280px] flex-1 rounded-[14px] border px-4 py-3 text-[13.5px]"
                  style={{
                    borderColor: "var(--line)",
                    background: "color-mix(in oklch, var(--bg) 72%, transparent)",
                    color: "var(--ink)",
                  }}
                />
                <Button
                  variant="accent"
                  onClick={startRun}
                  disabled={!url || isStarting}
                  className="min-w-[158px] justify-center"
                >
                  {isStarting ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="mr-1.5 h-4 w-4" />
                  )}
                  {isStarting ? "Launching" : mode === "workflow" ? "Run pipeline" : "Run agent"}
                </Button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              {stages.map((stage) => {
                const Icon = stage.icon;
                return (
                  <div
                    key={stage.label}
                    className="rounded-[14px] border px-4 py-3"
                    style={{
                      borderColor: "var(--line)",
                      background: "color-mix(in oklch, var(--bg) 76%, transparent)",
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className="flex h-8 w-8 items-center justify-center rounded-[10px]"
                        style={{
                          background: `color-mix(in oklch, ${stage.tone} 16%, transparent)`,
                          color: stage.tone,
                        }}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="text-[12px] font-semibold text-[var(--ink)]">
                        {stage.label}
                      </div>
                    </div>
                    <div
                      className="mt-2 text-[11.5px] leading-relaxed"
                      style={{ color: "var(--mute)" }}
                    >
                      {stage.detail}
                    </div>
                  </div>
                );
              })}
            </div>

            {error ? (
              <div
                className="rounded-[12px] border px-3 py-2 text-[12px] font-mono"
                style={{
                  borderColor: "color-mix(in oklch, var(--rose) 35%, transparent)",
                  background: "color-mix(in oklch, var(--rose) 10%, transparent)",
                  color: "var(--rose)",
                }}
              >
                {error}
              </div>
            ) : null}
          </div>
        </div>

        <div
          className="rounded-[18px] border p-5"
          style={{
            borderColor: "var(--line)",
            background: "var(--card)",
            boxShadow: "var(--shadow-card)",
          }}
        >
          <div className="text-[12px] font-semibold text-[var(--ink)]">
            Live run view
          </div>
          <div className="mt-1 text-[12px] leading-relaxed" style={{ color: "var(--mute)" }}>
            The detail screen highlights the active model or tool call, shows
            explicit failure reasons, and tracks context usage per stage instead
            of blending the whole workflow into one meter.
          </div>
          <div className="mt-4 space-y-2.5">
            {[
              "Model running and waiting for a response",
              "Tool running against the current stage target",
              "Stage complete, failed, or cancelled with visible reason",
              "Single-agent runs launch from this page and stream into the same detail view",
            ].map((item) => (
              <div
                key={item}
                className="rounded-[12px] border px-3 py-2 text-[11.5px]"
                style={{
                  borderColor: "var(--line)",
                  background: "color-mix(in oklch, var(--bg) 76%, transparent)",
                  color: "var(--ink-dim)",
                }}
              >
                {item}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
