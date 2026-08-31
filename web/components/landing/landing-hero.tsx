"use client";

import Link from "next/link";
import { ArrowRight, Bot, Globe2, Eye, Activity, KeyRound, ShieldCheck, Sparkles, Play, Zap, Lock, BarChart3, Search, Cpu, Layers } from "lucide-react";

export function LandingHero(): React.JSX.Element {
  return (
    <div className="w-full" style={{ fontFamily: "'Inter', system-ui, -apple-system, sans-serif", fontFeatureSettings: '"cv01","ss03"' }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;510;590&family=JetBrains+Mono:wght@400;500&display=swap');`}</style>

      {/* Hero — Linear canvas #08090a */}
      <section className="relative overflow-hidden" style={{ background: "#08090a" }}>
        <div className="pointer-events-none absolute inset-0" style={{ background: "radial-gradient(800px 400px at 70% -10%, rgba(94,106,210,0.12), transparent 60%), radial-gradient(600px 300px at 10% 20%, rgba(113,112,255,0.07), transparent 60%)" }} />
        <div className="relative mx-auto max-w-[1200px] px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-[720px] text-center">
            <div className="mb-6 inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-medium" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#d0d6e0" }}>
              <span className="size-1.5 rounded-full" style={{ background: "#5e6ad2", boxShadow: "0 0 8px rgba(94,106,210,0.6)" }} />
              Operator Console — BYOK · SSE · no polling
              <span className="hidden rounded-full bg-white/10 px-2 py-0.5 text-[10px] tracking-wide sm:inline" style={{ color: "#8a8f98" }}>v0.1.0</span>
            </div>
            <h1 className="text-4xl font-[510] leading-[0.98] tracking-[-1.056px] sm:text-[48px]" style={{ color: "#f7f8f8", fontFeatureSettings: '"cv01","ss03"' }}>
              Research any page.
              <br />
              <span style={{ color: "#8a8f98" }}>Evidence you can audit.</span>
            </h1>
            <p className="mx-auto mt-5 max-w-[560px] text-[18px] leading-[1.6] tracking-[-0.165px]" style={{ color: "#8a8f98", fontWeight: 400 }}>
              Open Web Catcher runs an isolated Playwright pipeline — classify → landing → hosting → embedded. Every finding ships with screenshots, HLS streams & provider intel. Your keys stay in Settings.
            </p>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <Link
                href="/signup"
                className="inline-flex items-center gap-2 rounded-[6px] px-5 py-2.5 text-sm font-[510] text-white transition-colors"
                style={{ background: "#5e6ad2" }}
              >
                Create account <ArrowRight className="size-4" />
              </Link>
              <Link
                href="/login"
                className="inline-flex items-center gap-2 rounded-[6px] px-5 py-2.5 text-sm font-[510] transition-colors"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#f7f8f8" }}
              >
                Log in
              </Link>
              <a
                href="#demo"
                className="inline-flex items-center gap-2 rounded-[6px] px-4 py-2.5 text-sm font-[510]"
                style={{ color: "#8a8f98" }}
              >
                <Play className="size-3.5" /> See pipeline
              </a>
            </div>
            <p className="mt-3 text-xs" style={{ color: "#62666d" }}>
              First account is admin via <span style={{ fontFamily: "'JetBrains Mono', monospace", color: "#d0d6e0" }}>bootstrap-admin</span> (single winner). No default credentials.
            </p>
          </div>

          {/* Pipeline visual — 4 stages */}
          <div id="demo" className="mx-auto mt-14 grid max-w-[960px] gap-3 sm:grid-cols-4">
            {[
              { icon: Bot, label: "Classify", sub: "What page?", accent: "#5e6ad2" },
              { icon: Globe2, label: "Landing", sub: "Discover hosts", accent: "#7170ff" },
              { icon: Eye, label: "Hosting", sub: "Probe players", accent: "#8a8f98" },
              { icon: Activity, label: "Embedded", sub: "Extract HLS", accent: "#27a644" },
            ].map((s) => (
              <div
                key={s.label}
                className="rounded-[8px] p-4 text-center"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)" }}
              >
                <s.icon className="mx-auto size-5" style={{ color: s.accent }} />
                <div className="mt-2 text-sm font-[590] tracking-[-0.24px]" style={{ color: "#f7f8f8" }}>
                  {s.label}
                </div>
                <div className="text-xs" style={{ color: "#8a8f98" }}>
                  {s.sub}
                </div>
              </div>
            ))}
          </div>

          {/* Live URL demo */}
          <div
            className="mx-auto mt-6 max-w-[640px] rounded-[8px] p-4"
            style={{ background: "#191a1b", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            <div className="flex items-center justify-between text-xs" style={{ color: "#62666d", fontFamily: "'JetBrains Mono', monospace" }}>
              <span>Input</span>
              <span className="rounded-full px-2 py-0.5 text-[10px] font-[510]" style={{ background: "rgba(39,166,68,0.12)", color: "#27a644" }}>isolated</span>
            </div>
            <div className="mt-1 truncate font-mono text-sm" style={{ color: "#d0d6e0" }}>
              https://example.com/match/live/123
            </div>
            <div className="mt-3 flex flex-wrap gap-2 text-xs" style={{ color: "#8a8f98" }}>
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.05)" }}>
                <span className="size-1.5 rounded-full" style={{ background: "#27a644" }} /> 3 streams
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.05)" }}>
                4 screenshots
              </span>
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.05)" }}>
                Cloudinary evidence
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Features — Level 3 surface #191a1b cards */}
      <section className="border-t" style={{ background: "#0f1011", borderColor: "rgba(255,255,255,0.05)" }}>
        <div className="mx-auto max-w-[1200px] px-6 py-12">
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { icon: ShieldCheck, title: "Isolated browser", desc: "Playwright + uBOL, popup control, iframe recovery. No host pollution." },
              { icon: KeyRound, title: "BYOK per-agent", desc: "google | openai | anthropic | openrouter | nvidia | litellm — masked, runtime yaml." },
              { icon: BarChart3, title: "Full observability", desc: "Live pipeline, costs/tokens, provider lookups, SSE — no polling." },
              { icon: Search, title: "Memory + dedup", desc: "Site memory, stream dedup, abuse contacts. 1200+ sites profiled." },
              { icon: Layers, title: "Evidence first", desc: "Screenshots, stream URLs, HAR — every run is auditable." },
              { icon: Cpu, title: "Tuned runtimes", desc: "Per-agent timeouts, retries, context budgets. Thinking controls." },
            ].map((f) => (
              <div
                key={f.title}
                className="rounded-[8px] p-5"
                style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)" }}
              >
                <f.icon className="size-5" style={{ color: "#5e6ad2" }} />
                <div className="mt-3 text-sm font-[590] tracking-[-0.24px]" style={{ color: "#f7f8f8" }}>
                  {f.title}
                </div>
                <div className="mt-1 text-[15px] leading-[1.6] tracking-[-0.165px]" style={{ color: "#8a8f98" }}>
                  {f.desc}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* BYOK callout */}
      <section className="border-y" style={{ background: "#08090a", borderColor: "rgba(255,255,255,0.05)" }}>
        <div className="mx-auto flex max-w-[1200px] flex-col gap-4 px-6 py-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex size-8 items-center justify-center rounded-full" style={{ background: "rgba(94,106,210,0.12)", border: "1px solid rgba(94,106,210,0.2)" }}>
              <KeyRound className="size-4" style={{ color: "#828fff" }} />
            </span>
            <div>
              <div className="text-sm font-[590]" style={{ color: "#f7f8f8" }}>
                Set your provider keys (BYOK)
              </div>
              <div className="text-xs" style={{ color: "#8a8f98" }}>
                No key = no LLM calls. Add per-agent <span style={{ color: "#d0d6e0", fontWeight: 510 }}>provider/model</span> in Settings — never baked into images.
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            <Link href="/settings?tab=api-keys" className="rounded-[6px] px-4 py-2 text-sm font-[510] text-white" style={{ background: "#5e6ad2" }}>
              Open Settings
            </Link>
            <Link href="/login" className="rounded-[6px] px-4 py-2 text-sm font-[510]" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#d0d6e0" }}>
              I have keys
            </Link>
          </div>
        </div>
      </section>

      {/* Footer CTA */}
      <section className="py-10 text-center" style={{ background: "#0f1011" }}>
        <div className="mx-auto max-w-[720px] px-6">
          <div className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-[510] tracking-wide" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.05)", color: "#62666d" }}>
            <Zap className="size-3" /> Ready to run?
          </div>
          <h2 className="mt-4 text-2xl font-[510] tracking-[-0.704px]" style={{ color: "#f7f8f8" }}>
            Start in 30 seconds.
          </h2>
          <p className="mx-auto mt-2 max-w-[520px] text-sm leading-relaxed" style={{ color: "#8a8f98" }}>
            Create the first admin, add your provider key in Settings, paste a URL in Live Pipeline. Evidence in minutes.
          </p>
          <div className="mt-6 flex justify-center gap-3">
            <Link href="/signup" className="rounded-[6px] px-5 py-2.5 text-sm font-[510] text-white" style={{ background: "#5e6ad2" }}>
              Create account
            </Link>
            <Link href="/login" className="rounded-[6px] px-5 py-2.5 text-sm font-[510]" style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", color: "#f7f8f8" }}>
              Log in
            </Link>
          </div>
          <div className="mt-6 flex items-center justify-center gap-2 text-xs" style={{ color: "#62666d" }}>
            <Lock className="size-3" /> No default credentials · <span style={{ fontFamily: "'JetBrains Mono', monospace" }}>bootstrap-admin</span> is audited
          </div>
        </div>
      </section>
    </div>
  );
}
