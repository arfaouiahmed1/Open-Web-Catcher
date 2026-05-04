"use client";

import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  Bot,
  Loader2,
  Play,
  Radio,
  Route,
  Waypoints,
  Workflow,
} from "lucide-react";

import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

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

const LIVE_VIEW_HINTS = [
  "Model running and waiting for a response",
  "Tool running against the current stage target",
  "Stage complete, failed, or cancelled with visible reason",
  "Single-agent runs launch here and stream into the same detail view",
];

export function RunLauncher({ defaultMode = "workflow" }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const initialMode = MODE_OPTIONS.some((option) => option.value === defaultMode)
    ? defaultMode
    : "workflow";
  const requestedMode = searchParams.get("mode");
  const mode = MODE_OPTIONS.some((option) => option.value === requestedMode)
    ? requestedMode
    : initialMode;
  const [agent, setAgent] = useState("classification");
  const [url, setUrl] = useState("");
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState("");

  function setMode(nextMode) {
    if (nextMode === mode) return;

    const params = new URLSearchParams(searchParams.toString());
    if (nextMode === initialMode) params.delete("mode");
    else params.set("mode", nextMode);

    const query = params.toString();
    router.push(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
    setError("");
  }

  const stages =
    mode === "workflow"
      ? [
          { label: "Classify", detail: "Read the page and route the workflow.", icon: Radio, tone: "var(--sky)" },
          { label: "Route", detail: "Decide landing, hosting, or embedded follow-up.", icon: Route, tone: "var(--violet)" },
          { label: "Parallelize", detail: "Landing, hosting, and embedded branches fan out in parallel.", icon: Waypoints, tone: "var(--mint)" },
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
        window.dispatchEvent(new CustomEvent("owc:track-run", { detail: { runId } }));
      }
      router.push(`/runs/${runId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setIsStarting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Live runs</h1>
        <p className="mt-1.5 max-w-[62ch] text-sm leading-relaxed text-muted-foreground">
          Start either the full workflow or a single-agent run from one page and jump directly into
          the live trace. The run detail view streams tool calls, model activity, screenshots,
          costs, and stage-level context usage as the run executes.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_340px]">
        {/* Launcher card */}
        <Card>
          <CardHeader className="space-y-3 border-b">
            <Tabs value={mode} onValueChange={(value) => { setMode(value); setError(""); }}>
              <TabsList>
                {MODE_OPTIONS.map((option) => {
                  const Icon = option.icon;
                  return (
                    <TabsTrigger key={option.value} value={option.value} className="gap-1.5">
                      <Icon className="h-3.5 w-3.5" />
                      {option.label}
                    </TabsTrigger>
                  );
                })}
              </TabsList>
            </Tabs>
            <CardDescription className="text-sm">
              {mode === "workflow"
                ? "One URL in, full pipeline out."
                : "Pick an agent below and run it in isolation."}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-6 pt-6">
            {mode === "agent" ? (
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Agent
                </Label>
                <div className="grid gap-3 md:grid-cols-2">
                  {AGENT_OPTIONS.map((option) => {
                    const active = agent === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => { setAgent(option.value); setError(""); }}
                        className={cn(
                          "group rounded-lg border bg-card p-4 text-left transition-all",
                          active
                            ? "border-primary/50 bg-primary/5 ring-1 ring-primary/30"
                            : "hover:bg-accent hover:border-border"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <Bot
                            className={cn(
                              "h-4 w-4 shrink-0",
                              active ? "text-primary" : "text-muted-foreground"
                            )}
                          />
                          <span className={cn(
                            "text-sm font-medium",
                            active ? "text-primary" : "text-foreground"
                          )}>
                            {option.label}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                          {option.detail}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label htmlFor="run-target-url" className="text-xs uppercase tracking-wider text-muted-foreground">
                Target URL
              </Label>
              <div className="flex flex-wrap gap-2">
                <Input
                  id="run-target-url"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") startRun(); }}
                  placeholder="https://streaming-site.example.com/watch/123"
                  className="min-w-[280px] flex-1"
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

            <Separator />

            {/* Stage strip */}
            <div className="grid gap-3 md:grid-cols-3">
              {stages.map((stage) => {
                const Icon = stage.icon;
                return (
                  <div key={stage.label} className="rounded-lg border bg-card p-3">
                    <div className="flex items-center gap-2">
                      <span
                        className="flex h-8 w-8 items-center justify-center rounded-md"
                        style={{
                          background: `color-mix(in oklch, ${stage.tone} 14%, transparent)`,
                          color: stage.tone,
                        }}
                      >
                        <Icon className="h-4 w-4" />
                      </span>
                      <div className="text-sm font-medium text-foreground">{stage.label}</div>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {stage.detail}
                    </p>
                  </div>
                );
              })}
            </div>

            {error ? (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="font-mono text-xs">{error}</span>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {/* Live view info */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Live run view</CardTitle>
            <CardDescription>
              The detail screen highlights the active model or tool call, shows explicit failure
              reasons, and tracks context usage per stage instead of blending the whole workflow
              into one meter.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {LIVE_VIEW_HINTS.map((item) => (
              <div
                key={item}
                className="rounded-md border bg-card px-3 py-2 text-xs text-foreground/80"
              >
                {item}
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
