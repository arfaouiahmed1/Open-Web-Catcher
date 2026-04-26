"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/notification-provider";
import { ThemeToggle } from "@/components/theme-toggle";

const ACTIVE_RUNS_POLL_MS = 8000;

function LogoMark({ className }) {
  return (
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden>
      <path d="M16 3.5 L26.5 9.25 L26.5 22.75 L16 28.5 L5.5 22.75 L5.5 9.25 Z" stroke="currentColor" strokeWidth="1.35" strokeLinejoin="round" opacity="0.9" />
      <path d="M16 9.5 L21 12.25 L21 19.75 L16 22.5 L11 19.75 L11 12.25 Z" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" opacity="0.55" />
      <path d="M3 16 H9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M23 16 H29" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="16" cy="16" r="2.1" fill="currentColor" />
    </svg>
  );
}

const ICONS = {
  overview: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 13a9 9 0 1 1 18 0" />
      <path d="M12 13l4-5" />
      <circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  live: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  ),
  agent: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="7" width="16" height="13" rx="2" />
      <path d="M12 4v3" />
      <circle cx="9" cy="13" r="1" fill="currentColor" />
      <circle cx="15" cy="13" r="1" fill="currentColor" />
      <path d="M10 17h4" />
    </svg>
  ),
  tools: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3a4 4 0 0 0-3 6.8L4 18l2 2 8.2-8.2A4 4 0 0 0 21 9l-3 1-2-2 1-3z" />
    </svg>
  ),
  runs: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M3 12h18M3 18h12" />
    </svg>
  ),
  providers: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M8 6h8M8 8l4 8M16 8l-4 8" />
    </svg>
  ),
  evals: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 3h6v3l-3 4 3 4v7H9v-7l3-4-3-4V3z" />
    </svg>
  ),
  database: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5" rx="8" ry="2.5" />
      <path d="M4 5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5" />
      <path d="M4 11v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6" />
    </svg>
  ),
  datasets: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </svg>
  ),
  prompts: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M9 9h1M9 13h6M9 17h6" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
  play: (
    <svg viewBox="0 0 24 24" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" />
    </svg>
  ),
  hamburger: (
    <svg viewBox="0 0 16 16" fill="currentColor">
      <rect x="1" y="3" width="14" height="1.5" rx="1" />
      <rect x="1" y="7.25" width="14" height="1.5" rx="1" />
      <rect x="1" y="11.5" width="14" height="1.5" rx="1" />
    </svg>
  ),
};

const NAV = [
  { href: "/", label: "Overview", key: "overview", section: null },
  { href: "/live", label: "Live Pipeline", key: "live", section: "Run", badge: true },
  { href: "/agents", label: "Agent Lab", key: "agent", section: "Run" },
  { href: "/tools", label: "Tool Playground", key: "tools", section: "Run" },
  { href: "/runs", label: "Run History", key: "runs", section: "Inspect" },
  { href: "/providers", label: "Provider Intel", key: "providers", section: "Inspect" },
  { href: "/evaluations", label: "Evaluations", key: "evals", section: "Inspect" },
  { href: "/datasets", label: "Datasets", key: "datasets", section: "Inspect" },
  { href: "/database", label: "Database", key: "database", section: "System" },
  { href: "/prompts", label: "Prompts", key: "prompts", section: "System" },
  { href: "/settings", label: "Settings", key: "settings", section: "System" },
];

const GROUPS = ["Run", "Inspect", "System"];

const GROUP_META = {
  Run:     { desc: "Execute & monitor" },
  Inspect: { desc: "Browse & analyze" },
  System:  { desc: "Configure" },
};

function NavLink({ item, active, badge, onClick }) {
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn(
        "group relative flex items-center gap-[11px] rounded-[10px] px-3 py-[7px] text-[13px] transition-all duration-150",
        active
          ? "owc-side-link-active bg-[color-mix(in_oklch,var(--signal)_10%,transparent)] text-[var(--ink)]"
          : "text-[var(--mute)] hover:bg-white/[0.04] hover:text-[var(--ink-dim)]"
      )}
    >
      <span className={cn("h-3.5 w-3.5 shrink-0 transition-all duration-150", active ? "scale-110 text-[var(--signal)]" : "text-[var(--mute-2)] group-hover:text-[var(--mute)]")}>
        {ICONS[item.key]}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{item.label}</span>
      {badge ? (
        <span
          className="relative ml-auto rounded-full px-1.5 py-0.5 font-mono text-[10px]"
          style={{
            color: "var(--signal)",
            background: "color-mix(in oklch, var(--signal) 12%, transparent)",
          }}
        >
          <span
            className="absolute inset-0 rounded-full"
            style={{ animation: "ping-once 1.5s ease infinite", background: "color-mix(in oklch, var(--signal) 25%, transparent)" }}
          />
          {badge}
        </span>
      ) : null}
    </Link>
  );
}

function pathToCrumbs(pathname) {
  const map = {
    "/": ["overview"],
    "/live": ["run", "live-pipeline"],
    "/agents": ["run", "agent-lab"],
    "/tools": ["run", "tool-playground"],
    "/runs": ["inspect", "runs"],
    "/providers": ["inspect", "provider-intel"],
    "/evaluations": ["inspect", "evaluations"],
    "/database": ["system", "database"],
    "/prompts": ["system", "prompts"],
    "/settings": ["system", "settings"],
  };
  const base = `/${pathname.split("/")[1] || ""}`;
  return map[base] || ["overview"];
}

export function AppShell({ children }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeRuns, setActiveRuns] = useState(0);
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(apiUrl("/ui/overview"), { cache: "no-store" });
        if (!res.ok || cancelled) {
          if (!cancelled) setConnected(false);
          return;
        }
        const payload = await res.json();
        if (!cancelled) {
          setActiveRuns((payload?.active_runs || []).filter((run) => !run.completed).length);
          setConnected(true);
        }
      } catch {
        if (!cancelled) setConnected(false);
      }
    }
    poll();
    const timer = setInterval(poll, ACTIVE_RUNS_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const crumbs = pathToCrumbs(pathname);
  const isActive = (item) => (item.href === "/" ? pathname === "/" : pathname === item.href || pathname.startsWith(`${item.href}/`));
  const topItem = NAV.find((item) => item.section === null);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "252px 1fr", minHeight: "100vh" }}>
      {sidebarOpen && <div className="fixed inset-0 z-20 bg-black/60 md:hidden" onClick={() => setSidebarOpen(false)} />}

      {/* ── Sidebar ── */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-[252px] flex-col border-r md:static transition-transform duration-200",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
        )}
        style={{
          borderColor: "var(--line)",
          background: "linear-gradient(180deg, color-mix(in oklch, var(--signal) 4%, var(--panel)) 0%, var(--panel) 28%)",
        }}
      >
        {/* Logo */}
        <div className="border-b px-5 py-4" style={{ borderColor: "var(--line)" }}>
          <div className="flex items-center gap-3">
            <div
              className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px]"
              style={{
                background: "color-mix(in oklch, var(--signal) 14%, transparent)",
                boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--signal) 32%, transparent), 0 4px 12px color-mix(in oklch, var(--signal) 18%, transparent)",
                color: "var(--signal)",
              }}
            >
              <LogoMark className="h-4.5 w-4.5" />
            </div>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold leading-tight text-[var(--ink)]">Open Web Catcher</div>
              <div className="text-[10.5px] text-[var(--mute)]">Operator console</div>
            </div>
            <span
              className="ml-auto h-[7px] w-[7px] shrink-0 rounded-full"
              style={{
                background: connected ? "var(--mint)" : "var(--rose)",
                boxShadow: `0 0 0 3px color-mix(in oklch, ${connected ? "var(--mint)" : "var(--rose)"} 20%, transparent)`,
                animation: "breathe 2s ease-in-out infinite",
              }}
              title={connected ? "API connected" : "API unreachable"}
            />
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-3">
          <NavLink item={topItem} active={isActive(topItem)} onClick={() => setSidebarOpen(false)} />

          {GROUPS.map((group) => {
            const items = NAV.filter((item) => item.section === group);
            return (
              <div key={group} className="mt-4">
                <div className="mb-1.5 flex items-center gap-2 px-3">
                  <span className="text-[9.5px] font-semibold uppercase tracking-[0.18em] text-[var(--mute-3)]">{group}</span>
                  <span className="h-px flex-1" style={{ background: "var(--line)" }} />
                </div>
                <div className="space-y-px">
                  {items.map((item) => (
                    <NavLink
                      key={item.href}
                      item={item}
                      active={isActive(item)}
                      badge={item.badge && activeRuns > 0 ? String(activeRuns) : null}
                      onClick={() => setSidebarOpen(false)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        {/* Bottom status */}
        <div className="border-t px-4 py-2.5" style={{ borderColor: "var(--line)", background: "rgba(255,255,255,0.012)" }}>
          <div className="flex items-center justify-between text-[11px]">
            <span className="inline-flex items-center gap-1.5 text-[var(--mute)]">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: connected ? "var(--mint)" : "var(--rose)" }} />
              {connected ? "connected" : "offline"}
            </span>
            {activeRuns > 0 && (
              <span
                className="rounded-full px-2 py-0.5 font-mono text-[10px]"
                style={{ color: "var(--signal)", background: "color-mix(in oklch, var(--signal) 12%, transparent)" }}
              >
                {activeRuns} live
              </span>
            )}
          </div>
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="flex min-w-0 flex-col">
        {/* Top bar */}
        <div
          className="sticky top-0 z-10 flex items-center gap-2 border-b px-6 py-3"
          style={{
            borderColor: "var(--line)",
            background: "color-mix(in oklch, var(--bg) 88%, transparent)",
            backdropFilter: "blur(16px)",
          }}
        >
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors md:hidden"
            style={{ borderColor: "var(--line)", color: "var(--mute)" }}
            aria-label="Toggle sidebar"
          >
            <span className="h-3.5 w-3.5">{ICONS.hamburger}</span>
          </button>

          <div key={pathname} className="flex items-center gap-1 font-mono text-[10.5px] animate-fade-up" style={{ color: "var(--mute-2)" }}>
            <span style={{ color: "var(--mute-3)" }}>owc</span>
            {crumbs.map((crumb, index) => (
              <span key={crumb} className="flex items-center gap-1">
                <span style={{ color: "var(--mute-3)" }}>/</span>
                <span style={{ color: index === crumbs.length - 1 ? "var(--ink-dim)" : "var(--mute-2)" }}>{crumb}</span>
              </span>
            ))}
          </div>

          <div className="flex-1" />

          {/* Connection pill */}
          <span
            className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] sm:flex"
            style={{ borderColor: "var(--line)", color: "var(--mute)", background: "var(--card)" }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: connected ? "var(--mint)" : "var(--rose)", boxShadow: `0 0 6px ${connected ? "var(--mint)" : "var(--rose)"}` }}
            />
            <span style={{ color: "var(--ink-dim)" }}>{connected ? "connected" : "offline"}</span>
          </span>

          {/* Notification bell */}
          <NotificationBell />

          <ThemeToggle />

          <Link
            href="/live"
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-all"
            style={{
              background: "var(--signal)",
              color: "#0d0a04",
              boxShadow: activeRuns === 0
                ? "var(--shadow-glow), 0 0 20px color-mix(in oklch, var(--signal) 25%, transparent)"
                : "var(--shadow-glow)",
            }}
          >
            <span className="h-3.5 w-3.5">{ICONS.play}</span>
            New Run
          </Link>
        </div>

        <main className="flex-1 overflow-auto">
          <div key={pathname} className="mx-auto max-w-[1340px] px-6 py-7 pb-20 animate-fade-up">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
