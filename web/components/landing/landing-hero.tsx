"use client";

import Link from "next/link";
import { ArrowRight, Check, Eye, KeyRound, Play, Search, ShieldCheck, Sparkles } from "lucide-react";
import { LogoMark } from "@/components/console/layout/navigation-config";

const STAGES = [
  { code: "01", title: "Classify", note: "Detect the page type", color: "var(--signal)" },
  { code: "02", title: "Discover", note: "Trace landing and hosts", color: "var(--sky)" },
  { code: "03", title: "Inspect", note: "Probe player contexts", color: "var(--violet)" },
  { code: "04", title: "Evidence", note: "Verify streams and capture", color: "var(--mint)" },
];

export function LandingHero(): React.JSX.Element {
  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <div className="mx-auto max-w-[var(--content-max)] px-5 sm:px-6">
        <section className="grid min-h-[min(720px,calc(100vh-3.5rem))] items-center gap-10 py-12 lg:grid-cols-[minmax(0,1.08fr)_minmax(420px,.92fr)] lg:py-16">
          {/* Decide/Learn: asymmetric editorial story, not a dashboard-card grid. */}
          <div className="max-w-[660px]">
            <div className="mb-7 flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--mute)]">
              <span className="flex size-8 items-center justify-center rounded-lg bg-[color-mix(in_oklch,var(--signal)_12%,transparent)] text-[var(--signal)] ring-1 ring-[color-mix(in_oklch,var(--signal)_25%,transparent)]">
                <LogoMark className="size-4" />
              </span>
              Open Web Catcher <span className="text-[var(--mute-3)]">/</span> operator console
            </div>
            <p className="mb-4 font-mono text-[11px] tracking-[0.08em] text-[var(--signal)]">AUTONOMOUS WEB RESEARCH · EVIDENCE FIRST</p>
            <h1 className="max-w-[620px] text-balance text-5xl font-semibold leading-[.96] tracking-[-0.055em] text-[var(--ink)] sm:text-6xl lg:text-7xl">
              Follow the page.
              <span className="block text-[var(--mute)]">Keep the proof.</span>
            </h1>
            <p className="mt-6 max-w-[550px] text-pretty text-base leading-7 text-[var(--mute)] sm:text-lg">
              OWC drives an isolated browser through the web&apos;s dead ends — classifying pages, tracing embeds, and collecting the screenshots, streams, and provider evidence that explain every result.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/signup" className="inline-flex h-11 items-center gap-2 rounded-lg bg-[var(--signal)] px-5 text-sm font-semibold text-[var(--bg)] transition-transform hover:-translate-y-0.5 hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--signal)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]">
                Create account <ArrowRight className="size-4" />
              </Link>
              <Link href="/login" className="inline-flex h-11 items-center rounded-lg border border-[var(--line-hi)] bg-[var(--card)] px-5 text-sm font-medium text-[var(--ink)] transition-colors hover:bg-[var(--card-hi)]">
                Log in
              </Link>
            </div>
            <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[var(--mute-2)]">
              <span className="inline-flex items-center gap-1.5"><ShieldCheck className="size-3.5 text-[var(--mint)]" /> Isolated browser</span>
              <span className="inline-flex items-center gap-1.5"><KeyRound className="size-3.5 text-[var(--signal)]" /> Bring your own key</span>
              <span className="inline-flex items-center gap-1.5"><Eye className="size-3.5 text-[var(--sky)]" /> Auditable output</span>
            </div>
          </div>

          {/* The product metaphor: a single vertical evidence trace. */}
          <div className="relative mx-auto w-full max-w-[510px]">
            <div className="absolute -inset-5 rounded-[32px] bg-[radial-gradient(circle_at_50%_30%,color-mix(in_oklch,var(--signal)_12%,transparent),transparent_62%)] blur-2xl" />
            <div className="relative overflow-hidden rounded-2xl border border-[var(--line-hi)] bg-[var(--panel)] shadow-[0_24px_70px_rgba(0,0,0,.28)]">
              <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="size-2 rounded-full bg-[var(--rose)]" />
                  <span className="size-2 rounded-full bg-[var(--signal)]" />
                  <span className="size-2 rounded-full bg-[var(--mint)]" />
                  <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--mute-2)]">run / trace_01</span>
                </div>
                <span className="rounded-full bg-[color-mix(in_oklch,var(--mint)_12%,transparent)] px-2 py-1 font-mono text-[10px] text-[var(--mint)]">LIVE</span>
              </div>
              <div className="p-4 sm:p-5">
                <div className="rounded-lg border border-[var(--line)] bg-[var(--bg)] p-3">
                  <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--mute-2)]"><Search className="size-3" /> Target URL</div>
                  <div className="mt-1.5 truncate font-mono text-xs text-[var(--ink-dim)]">https://example.com/event/player</div>
                </div>
                <div className="relative my-3 ml-4 border-l border-dashed border-[var(--line-hi)]">
                  {STAGES.map((stage, index) => (
                    <div key={stage.code} className="relative pb-4 pl-7 last:pb-0">
                      <span className="absolute -left-[5px] top-1 size-2.5 rounded-full ring-4 ring-[var(--panel)]" style={{ background: stage.color }} />
                      <div className="flex items-baseline justify-between gap-3">
                        <div className="text-sm font-semibold text-[var(--ink)]"><span className="mr-2 font-mono text-[10px] text-[var(--mute-2)]">{stage.code}</span>{stage.title}</div>
                        <span className="font-mono text-[10px] text-[var(--mute-2)]">{index === 3 ? "00:24" : "done"}</span>
                      </div>
                      <div className="mt-0.5 text-xs text-[var(--mute)]">{stage.note}</div>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-[var(--line)] bg-[var(--line)]">
                  {["3 streams", "4 captures", "2 hosts"].map((item) => (
                    <div key={item} className="bg-[var(--card)] px-2 py-3 text-center font-mono text-[10px] text-[var(--mute)]">{item}</div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-[var(--line)] py-8 sm:py-10">
          <div className="grid gap-7 lg:grid-cols-[.8fr_1.2fr] lg:gap-12">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.13em] text-[var(--signal)]">Your key. Your routing.</p>
              <h2 className="mt-3 text-2xl font-semibold tracking-[-0.035em] text-[var(--ink)] sm:text-3xl">Configure a model for each agent — not one global black box.</h2>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <p className="text-sm leading-6 text-[var(--mute)]">Choose a provider and model for classification, landing, hosting, embedded, and orchestration. Keys are masked in the console and persisted to the local runtime configuration.</p>
              <Link href="/settings?tab=api-keys" className="group rounded-xl border border-[var(--line-hi)] bg-[var(--card)] p-4 transition-colors hover:bg-[var(--card-hi)]">
                <span className="inline-flex size-8 items-center justify-center rounded-lg bg-[color-mix(in_oklch,var(--violet)_12%,transparent)] text-[var(--violet)]"><KeyRound className="size-4" /></span>
                <div className="mt-3 text-sm font-semibold text-[var(--ink)]">Set up BYOK <ArrowRight className="ml-1 inline size-3 transition-transform group-hover:translate-x-0.5" /></div>
                <p className="mt-1 text-xs text-[var(--mute)]">No provider key is baked into an image.</p>
              </Link>
            </div>
          </div>
        </section>

        <section className="grid gap-0 py-10 sm:grid-cols-3 sm:py-14">
          {[
            ["Observe", "Live SSE activity, runs, costs, context windows, and tool reliability without polling."],
            ["Operate", "Launch a workflow or inspect one agent. Cancel safely, then follow the evidence trail."],
            ["Review", "Compare results and capture exact streams, screenshots, and provider lookup history."],
          ].map(([title, copy], index) => (
            <div key={title} className="border-[var(--line)] py-5 sm:px-6 sm:first:pl-0 sm:not-last:border-r sm:last:pr-0">
              <span className="font-mono text-[11px] text-[var(--mute-2)]">0{index + 1}</span>
              <h3 className="mt-3 text-lg font-semibold text-[var(--ink)]">{title}</h3>
              <p className="mt-2 text-sm leading-6 text-[var(--mute)]">{copy}</p>
            </div>
          ))}
        </section>

        <section className="grid gap-8 border-t border-[var(--line)] py-12 lg:grid-cols-[.72fr_1.28fr] lg:py-16">
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.13em] text-[var(--sky)]">How a trace becomes a result</p>
            <h2 className="mt-3 text-3xl font-semibold leading-tight tracking-[-0.04em] text-[var(--ink)]">The result is a chain of decisions, not an unexplained answer.</h2>
            <p className="mt-4 text-sm leading-6 text-[var(--mute)]">OWC keeps the context that led an agent from a public URL to a validated stream or a defensible failure state. That lets an operator inspect what happened instead of trusting a black box.</p>
          </div>
          <div className="space-y-0 overflow-hidden rounded-xl border border-[var(--line-hi)] bg-[var(--card)]">
            {[
              ["Target and context", "The run records the URL, page type, browser profile, selected provider/model, and runtime budget before any agent acts."],
              ["Observed evidence", "Screenshots, page state, DOM observations, intercepted media, and provider lookup data are attached to the run rather than reduced to a bare conclusion."],
              ["Validation and outcome", "The validator rejects poisoned URLs and reports whether the pipeline found usable streams, hit a real blocker, or needs a human follow-up."],
            ].map(([label, copy], index) => (
              <div key={label} className="grid gap-3 border-b border-[var(--line)] p-5 last:border-0 sm:grid-cols-[34px_1fr]">
                <span className="font-mono text-[11px] text-[var(--signal)]">0{index + 1}</span>
                <div>
                  <h3 className="text-sm font-semibold text-[var(--ink)]">{label}</h3>
                  <p className="mt-1 text-sm leading-6 text-[var(--mute)]">{copy}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-7 border-t border-[var(--line)] py-12 lg:grid-cols-2 lg:py-16">
          <div className="rounded-2xl bg-[color-mix(in_oklch,var(--signal)_8%,var(--card))] p-6 ring-1 ring-[color-mix(in_oklch,var(--signal)_20%,transparent)]">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]"><KeyRound className="size-4 text-[var(--signal)]" /> Bring your own intelligence</div>
            <p className="mt-3 text-sm leading-6 text-[var(--mute)]">Use one provider for fast classification and another for deep extraction. The five agent roles can each select their own provider, model, temperature and token limits in Settings.</p>
            <Link href="/settings?tab=models" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[var(--signal)] hover:brightness-110">Configure agent routing <ArrowRight className="size-4" /></Link>
          </div>
          <div className="rounded-2xl border border-[var(--line-hi)] bg-[var(--panel)] p-6">
            <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]"><Play className="size-4 text-[var(--mint)]" /> A practical first run</div>
            <ol className="mt-4 space-y-3 text-sm leading-6 text-[var(--mute)]">
              <li className="flex gap-3"><Check className="mt-1 size-3.5 shrink-0 text-[var(--mint)]" />Create the first admin account, then add an API key under Settings.</li>
              <li className="flex gap-3"><Check className="mt-1 size-3.5 shrink-0 text-[var(--mint)]" />Paste an allowed public URL in Live Pipeline and select workflow mode.</li>
              <li className="flex gap-3"><Check className="mt-1 size-3.5 shrink-0 text-[var(--mint)]" />Follow the live trace, then review screenshots and streams in View Results.</li>
            </ol>
            <Link href="/live" className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-[var(--mint)] hover:brightness-110">Open Live Pipeline <ArrowRight className="size-4" /></Link>
          </div>
        </section>

        <footer className="flex flex-col gap-4 border-t border-[var(--line)] py-7 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 text-[var(--mute)]"><Sparkles className="size-4 text-[var(--signal)]" /> Start with a provider key, then run your first trace.</div>
          <div className="flex gap-4">
            <Link href="/signup" className="font-medium text-[var(--ink)] hover:text-[var(--signal)]">Create account</Link>
            <Link href="/login" className="font-medium text-[var(--mute)] hover:text-[var(--ink)]">Log in</Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
