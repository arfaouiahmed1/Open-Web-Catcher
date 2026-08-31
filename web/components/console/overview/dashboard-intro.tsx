"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { KeyRound, X, Sparkles, Bot, Globe2, Eye, Activity, ArrowRight } from "lucide-react";
import { apiUrl } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

const INTRO_KEY = "owc_intro_seen";
const BYOK_DISMISS_KEY = "owc_byok_dismissed";

function useByokStatus(): { missing: boolean; loading: boolean } {
  const [missing, setMissing] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  useEffect(() => {
    let cancelled = false;
    async function check(): Promise<void> {
      try {
        const res = await fetch(apiUrl("/ui/config"), { cache: "no-store" });
        if (!res.ok) {
          if (!cancelled) setMissing(true);
          return;
        }
        const data: {
          agent_model_config?: Record<string, { provider?: string; model?: string }>;
          provider_model_catalog_cache?: Record<string, unknown>;
          settings_sources?: Record<string, { value: unknown; source_layer: string }>;
        } = (await res.json()) as {
          agent_model_config?: Record<string, { provider?: string; model?: string }>;
          provider_model_catalog_cache?: Record<string, unknown>;
          settings_sources?: Record<string, { value: unknown; source_layer: string }>;
        };
        // BYOK missing if no provider has a key-like source beyond default and no runtime override
        const sources = data.settings_sources;
        const hasKey = sources
          ? Object.entries(sources).some(
              ([k, v]) =>
                k.endsWith("_api_key") &&
                String((v as { value: unknown }).value || "").trim().length > 0 &&
                (v as { source_layer: string }).source_layer !== "default",
            )
          : false;
        const hasAgentConfig = Boolean(data.agent_model_config && Object.keys(data.agent_model_config).length > 0);
        if (!cancelled) setMissing(!hasKey && !hasAgentConfig);
      } catch {
        if (!cancelled) setMissing(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void check();
    return () => {
      cancelled = true;
    };
  }, []);
  return { missing, loading };
}

export function DashboardIntro(): React.JSX.Element | null {
  const [seen, setSeen] = useState<boolean>(true);
  const [byokDismissed, setByokDismissed] = useState<boolean>(true);
  const { missing: byokMissing, loading: byokLoading } = useByokStatus();
  const [step, setStep] = useState<number>(0);

  useEffect(() => {
    try {
      setSeen(localStorage.getItem(INTRO_KEY) === "1");
      setByokDismissed(localStorage.getItem(BYOK_DISMISS_KEY) === "1");
    } catch {
      setSeen(true);
      setByokDismissed(true);
    }
  }, []);

  function dismissIntro(): void {
    try {
      localStorage.setItem(INTRO_KEY, "1");
    } catch {}
    setSeen(true);
  }
  function dismissByok(): void {
    try {
      localStorage.setItem(BYOK_DISMISS_KEY, "1");
    } catch {}
    setByokDismissed(true);
  }

  const showIntro = !seen;
  const showByok = !byokLoading && byokMissing && !byokDismissed;

  if (!showIntro && !showByok) return null;

  const steps = [
    { icon: <Bot className="size-5 text-primary" />, title: "1. Classify", desc: "Is this a landing, hosting, or embedded page? The classifier decides." },
    { icon: <Globe2 className="size-5 text-sky-500" />, title: "2. Landing", desc: "Find hosting/page links, deduplicate, follow." },
    { icon: <Eye className="size-5 text-violet-500" />, title: "3. Hosting", desc: "Probe players, detect blocks, wait for streams." },
    { icon: <Activity className="size-5 text-emerald-500" />, title: "4. Embedded", desc: "Extract HLS/m3u8, screenshots, provider evidence." },
  ];

  return (
    <div className="space-y-3">
      {showIntro ? (
        <Card className="border-primary/30 bg-gradient-to-br from-primary/[0.06] via-transparent to-violet-500/[0.06]">
          <CardHeader className="pb-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="size-4 text-primary" /> Quick intro — how OWC works
                </CardTitle>
                <CardDescription>Isolated browser + BYOK LLM pipeline. No polling — SSE. Your keys, your cost.</CardDescription>
              </div>
              <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={dismissIntro} aria-label="Dismiss intro">
                <X className="size-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              {steps.map((s, i) => (
                <button
                  key={s.title}
                  onClick={() => setStep(i)}
                  className={`rounded-lg border p-3 text-left transition-colors ${step === i ? "border-primary/50 bg-primary/5" : "border-border bg-card hover:bg-muted/40"}`}
                >
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    {s.icon} {s.title}
                  </div>
                  <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{s.desc}</div>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href="/live">
                  Start a run <ArrowRight className="size-4" />
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link href="/settings?tab=api-keys">Set your BYOK keys</Link>
              </Button>
              <Button variant="ghost" onClick={dismissIntro}>
                Continue to dashboard
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Every run ships with screenshots (Cloudinary), stream URLs, and provider lookups. Check{" "}
              <Link href="/runs" className="text-primary hover:underline">
                View Results
              </Link>{" "}
              after your first run.
            </p>
          </CardContent>
        </Card>
      ) : null}
      {showByok ? (
        <Card className="border-amber-500/30 bg-amber-500/[0.07]">
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-3">
              <span className="flex size-8 items-center justify-center rounded-full bg-amber-500/15 text-amber-600">
                <KeyRound className="size-4" />
              </span>
              <div>
                <div className="text-sm font-semibold">Set your provider keys (BYOK)</div>
                <div className="text-xs text-muted-foreground">
                  No API key detected. Add per-agent <span className="font-medium text-foreground">provider/model</span> in Settings — keys are masked and stored in{" "}
                  <span className="font-mono">data/settings.runtime.yaml</span>, never baked.
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button asChild size="sm">
                <Link href="/settings?tab=api-keys">Open Settings</Link>
              </Button>
              <Button variant="ghost" size="icon" className="size-7" onClick={dismissByok} aria-label="Dismiss">
                <X className="size-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
