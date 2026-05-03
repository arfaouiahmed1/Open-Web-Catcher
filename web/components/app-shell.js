"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/notification-provider";
import { ThemeToggle } from "@/components/theme-toggle";

const ACTIVE_RUNS_POLL_MS = 8000;

/** Accent colour per group — used for the separator dot/label and the active link treatment. */
const GROUP_COLORS = {
  Run: "var(--signal)",
  Inspect: "var(--sky)",
  System: "var(--violet)",
};

// ─────────────────────────────────────────────
// Logo mark
// ─────────────────────────────────────────────

function LogoMark({ className }) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        d="M16 3.5 L26.5 9.25 L26.5 22.75 L16 28.5 L5.5 22.75 L5.5 9.25 Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
        opacity="0.9"
      />
      <path
        d="M16 9.5 L21 12.25 L21 19.75 L16 22.5 L11 19.75 L11 12.25 Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
        opacity="0.55"
      />
      <path
        d="M3 16 H9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M23 16 H29"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="16" cy="16" r="2.1" fill="currentColor" />
    </svg>
  );
}

// ─────────────────────────────────────────────
// Icons
// ─────────────────────────────────────────────

const ICONS = {
  overview: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 13a9 9 0 1 1 18 0" />
      <path d="M12 13l4-5" />
      <circle cx="12" cy="13" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  live: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  ),
  agent: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="4" y="7" width="16" height="13" rx="2" />
      <path d="M12 4v3" />
      <circle cx="9" cy="13" r="1" fill="currentColor" />
      <circle cx="15" cy="13" r="1" fill="currentColor" />
      <path d="M10 17h4" />
    </svg>
  ),
  tools: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3a4 4 0 0 0-3 6.8L4 18l2 2 8.2-8.2A4 4 0 0 0 21 9l-3 1-2-2 1-3z" />
    </svg>
  ),
  runs: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18M3 12h18M3 18h12" />
    </svg>
  ),
  providers: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M8 6h8M8 8l4 8M16 8l-4 8" />
    </svg>
  ),
  evals: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9 3h6v3l-3 4 3 4v7H9v-7l3-4-3-4V3z" />
    </svg>
  ),
  database: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <ellipse cx="12" cy="5" rx="8" ry="2.5" />
      <path d="M4 5v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5V5" />
      <path d="M4 11v6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-6" />
    </svg>
  ),
  datasets: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="3" y="13" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
    </svg>
  ),
  prompts: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14 3v4a1 1 0 0 0 1 1h4" />
      <path d="M17 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h7l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M9 9h1M9 13h6M9 17h6" />
    </svg>
  ),
  settings: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
  play: (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
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

// ─────────────────────────────────────────────
// Navigation config
// ─────────────────────────────────────────────

const NAV = [
  { href: "/", label: "Overview", key: "overview", section: null },
  {
    href: "/live",
    label: "Live Pipeline",
    key: "live",
    section: "Run",
    badge: true,
  },
  { href: "/tools", label: "Tool Playground", key: "tools", section: "Run" },
  { href: "/runs", label: "Run History", key: "runs", section: "Inspect" },
  {
    href: "/providers",
    label: "Provider Intel",
    key: "providers",
    section: "Inspect",
  },
  {
    href: "/evaluations",
    label: "Evaluations",
    key: "evals",
    section: "Inspect",
  },
  { href: "/datasets", label: "Datasets", key: "datasets", section: "Inspect" },
  { href: "/database", label: "Database", key: "database", section: "System" },
  { href: "/prompts", label: "Prompts", key: "prompts", section: "System" },
  { href: "/settings", label: "Settings", key: "settings", section: "System" },
];

const GROUPS = ["Run", "Inspect", "System"];

const GROUP_META = {
  Run: { desc: "Execute & monitor" },
  Inspect: { desc: "Browse & analyze" },
  System: { desc: "Configure" },
};

// ─────────────────────────────────────────────
// NavLink component
// ─────────────────────────────────────────────

/**
 * A single sidebar navigation link.
 *
 * Active treatment: 2px left border in the group's accent colour,
 * matching tinted background, and icon/text coloured to match.
 * Inactive treatment: muted text with subtle hover lift — handled
 * entirely by Tailwind classes so CSS :hover can override colour
 * without fighting inline-style specificity.
 */
function NavLink({ item, active, badge, onClick, accentColor }) {
  const accent = accentColor || "var(--signal)";

  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn(
        "group relative flex h-[34px] items-center gap-2.5 rounded-[9px] text-[12.5px] font-medium transition-all duration-150",
        active
          ? ""
          : "text-[var(--mute)] hover:bg-white/[0.04] hover:text-[var(--ink-dim)]",
      )}
      style={
        active
          ? {
              /* Compensate border-left width so text stays aligned */
              paddingLeft: "calc(0.625rem - 2px)",
              paddingRight: "0.625rem",
              background: `color-mix(in oklch, ${accent} 11%, transparent)`,
              color: accent,
              borderLeft: `2px solid ${accent}`,
            }
          : {
              paddingLeft: "0.625rem",
              paddingRight: "0.625rem",
            }
      }
    >
      {/* Icon */}
      <span
        className={cn(
          "h-[15px] w-[15px] shrink-0 transition-colors duration-150",
          active ? "" : "text-[var(--mute-2)] group-hover:text-[var(--mute)]",
        )}
        style={active ? { color: accent } : undefined}
      >
        {ICONS[item.key]}
      </span>

      {/* Label */}
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap leading-none">
        {item.label}
      </span>

      {/* Active-run pulsing dot (Live Pipeline only) */}
      {badge ? (
        <span className="relative ml-auto flex h-[7px] w-[7px] shrink-0 items-center justify-center">
          <span
            className="absolute inset-0 rounded-full"
            style={{
              background: "var(--signal)",
              animation: "ping 1.6s ease-in-out infinite",
              opacity: 0.5,
            }}
          />
          <span
            className="relative h-[7px] w-[7px] rounded-full"
            style={{ background: "var(--signal)" }}
          />
        </span>
      ) : null}
    </Link>
  );
}

// ─────────────────────────────────────────────
// Breadcrumb helper
// ─────────────────────────────────────────────

function pathToCrumbs(pathname) {
  const map = {
    "/": ["overview"],
    "/live": ["run", "live-pipeline"],
    "/tools": ["run", "tool-playground"],
    "/runs": ["inspect", "runs"],
    "/providers": ["inspect", "provider-intel"],
    "/evaluations": ["inspect", "evaluations"],
    "/datasets": ["inspect", "datasets"],
    "/database": ["system", "database"],
    "/prompts": ["system", "prompts"],
    "/settings": ["system", "settings"],
  };
  const base = `/${pathname.split("/")[1] || ""}`;
  return map[base] || ["overview"];
}

// ─────────────────────────────────────────────
// AppShell
// ─────────────────────────────────────────────

export function AppShell({ children }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeRuns, setActiveRuns] = useState(0);
  const [connected, setConnected] = useState(true);

  /* Poll the overview endpoint to keep active-run count and connection status fresh */
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
          setActiveRuns(
            (payload?.active_runs || []).filter((r) => !r.completed).length,
          );
          setConnected(true);
        }
      } catch {
        if (!cancelled) setConnected(false);
      }
    }

    poll();
    const timer = setInterval(poll, ACTIVE_RUNS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const crumbs = pathToCrumbs(pathname);
  const isActive = (item) =>
    item.href === "/"
      ? pathname === "/"
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  const topItem = NAV.find((item) => item.section === null);

  /* ── render ─────────────────────────────── */
  return (
    <div
      className="md:grid-cols-[240px_1fr]"
      style={{
        display: "grid",
        minHeight: "100vh",
      }}
    >
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-20 bg-black/60 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* ════════════════════════════════════
          Sidebar
      ════════════════════════════════════ */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 flex w-[240px] flex-col overflow-hidden border-r",
          "md:sticky md:top-0 md:h-screen",
          "transition-transform duration-200",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
        style={{
          borderColor: "var(--line)",
          background: "var(--panel)",
        }}
      >
        {/* Subtle signal-tinted gradient at the very top */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-0 h-32"
          style={{
            background:
              "linear-gradient(170deg, color-mix(in oklch, var(--signal) 5%, transparent) 0%, transparent 100%)",
          }}
        />

        {/* ── Logo strip ── */}
        <div
          className="relative z-10 flex h-11 shrink-0 items-center gap-2.5 border-b px-4"
          style={{ borderColor: "var(--line)" }}
        >
          {/* Logo mark */}
          <div
            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]"
            style={{
              background: "color-mix(in oklch, var(--signal) 13%, transparent)",
              boxShadow:
                "inset 0 0 0 1px color-mix(in oklch, var(--signal) 26%, transparent), " +
                "0 2px 8px color-mix(in oklch, var(--signal) 12%, transparent)",
              color: "var(--signal)",
            }}
          >
            <LogoMark className="h-[14px] w-[14px]" />
          </div>

          {/* App name + version */}
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span
              className="text-[12.5px] font-semibold tracking-tight"
              style={{ color: "var(--ink)" }}
            >
              OWC
            </span>
            <span
              className="text-[10px] font-medium"
              style={{ color: "var(--mute-3)" }}
            >
              v0.1
            </span>
          </div>

          {/* Live connection dot */}
          <span
            className="ml-auto h-[7px] w-[7px] shrink-0 rounded-full transition-colors"
            style={{
              background: connected ? "var(--mint)" : "var(--rose)",
              boxShadow: `0 0 0 2.5px color-mix(in oklch, ${
                connected ? "var(--mint)" : "var(--rose)"
              } 22%, transparent)`,
              animation: "breathe 2s ease-in-out infinite",
            }}
            title={connected ? "API connected" : "API unreachable"}
          />
        </div>

        {/* ── Navigation ── */}
        <nav className="relative z-10 flex-1 overflow-y-auto px-2.5 py-3">
          {/* Overview — home button, slightly taller + larger text */}
          <Link
            href={topItem.href}
            onClick={() => setSidebarOpen(false)}
            className={cn(
              "group flex h-[36px] items-center gap-2.5 rounded-[9px] text-[13px] font-medium transition-all duration-150",
              isActive(topItem)
                ? ""
                : "text-[var(--mute)] hover:bg-white/[0.04] hover:text-[var(--ink-dim)]",
            )}
            style={
              isActive(topItem)
                ? {
                    paddingLeft: "calc(0.625rem - 2px)",
                    paddingRight: "0.625rem",
                    background:
                      "color-mix(in oklch, var(--signal) 11%, transparent)",
                    color: "var(--signal)",
                    borderLeft: "2px solid var(--signal)",
                  }
                : {
                    paddingLeft: "0.625rem",
                    paddingRight: "0.625rem",
                  }
            }
          >
            <span
              className={cn(
                "h-[15px] w-[15px] shrink-0 transition-colors duration-150",
                isActive(topItem)
                  ? ""
                  : "text-[var(--mute-2)] group-hover:text-[var(--mute)]",
              )}
              style={isActive(topItem) ? { color: "var(--signal)" } : undefined}
            >
              {ICONS[topItem.key]}
            </span>
            <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
              {topItem.label}
            </span>
          </Link>

          {/* ── Grouped sections ── */}
          {GROUPS.map((group) => {
            const items = NAV.filter((item) => item.section === group);
            const isActiveGrp = items.some((item) => isActive(item));
            const groupColor = GROUP_COLORS[group];

            return (
              <div key={group} className="mt-5">
                {/* Group separator: tiny dot + uppercase label */}
                <div className="mb-1 flex items-center gap-1.5 px-2.5">
                  <span
                    className="h-[5px] w-[5px] shrink-0 rounded-full transition-colors duration-300"
                    style={{
                      background: isActiveGrp ? groupColor : "var(--mute-3)",
                    }}
                  />
                  <span
                    className="text-[9.5px] font-semibold uppercase tracking-[0.14em] transition-colors duration-300"
                    style={{
                      color: isActiveGrp ? groupColor : "var(--mute-3)",
                    }}
                  >
                    {group}
                  </span>
                </div>

                {/* Nav links for this group */}
                <div className="space-y-px">
                  {items.map((item) => (
                    <NavLink
                      key={item.href}
                      item={item}
                      active={isActive(item)}
                      badge={item.badge && activeRuns > 0}
                      onClick={() => setSidebarOpen(false)}
                      accentColor={groupColor}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </nav>

        {/* ── Footer ── */}
        <div
          className="relative z-10 flex shrink-0 items-center justify-between border-t px-3 py-2.5"
          style={{
            borderColor: "var(--line)",
            background: "color-mix(in oklch, var(--panel) 92%, var(--bg))",
          }}
        >
          {/* Connection status */}
          <div className="flex items-center gap-1.5">
            <span
              className="h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ background: connected ? "var(--mint)" : "var(--rose)" }}
            />
            <span
              className="text-[10.5px] font-medium"
              style={{ color: "var(--mute)" }}
            >
              {connected ? "live" : "offline"}
            </span>
          </div>

          {/* Right side: active-run pill */}
          <div className="flex items-center gap-2">
            {activeRuns > 0 && (
              <span
                className="flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{
                  color: "var(--signal)",
                  background:
                    "color-mix(in oklch, var(--signal) 10%, transparent)",
                }}
              >
                {/* Pulsing dot */}
                <span className="relative flex h-[6px] w-[6px] shrink-0">
                  <span
                    className="absolute inset-0 rounded-full"
                    style={{
                      background: "var(--signal)",
                      animation: "ping 1.6s ease-in-out infinite",
                      opacity: 0.55,
                    }}
                  />
                  <span
                    className="relative h-[6px] w-[6px] rounded-full"
                    style={{ background: "var(--signal)" }}
                  />
                </span>
                {activeRuns}
              </span>
            )}
          </div>
        </div>
      </aside>

      {/* ════════════════════════════════════
          Main content area
      ════════════════════════════════════ */}
      <div className="flex min-w-0 flex-col">
        {/* ── Top bar ── */}
        <div
          className="sticky top-0 z-10 flex items-center gap-2 border-b px-6 py-3"
          style={{
            borderColor: "var(--line)",
            background: "color-mix(in oklch, var(--bg) 88%, transparent)",
            backdropFilter: "blur(16px)",
          }}
        >
          {/* Hamburger (mobile) */}
          <button
            type="button"
            onClick={() => setSidebarOpen((v) => !v)}
            className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md border transition-colors md:hidden"
            style={{ borderColor: "var(--line)", color: "var(--mute)" }}
            aria-label="Toggle sidebar"
          >
            <span className="h-3.5 w-3.5">{ICONS.hamburger}</span>
          </button>

          {/* Breadcrumb */}
          <div
            key={pathname}
            className="flex items-center gap-1 font-mono text-[10.5px] animate-fade-up"
            style={{ color: "var(--mute-2)" }}
          >
            <span style={{ color: "var(--mute-3)" }}>owc</span>
            {crumbs.map((crumb, index) => (
              <span key={crumb} className="flex items-center gap-1">
                <span style={{ color: "var(--mute-3)" }}>/</span>
                <span
                  style={{
                    color:
                      index === crumbs.length - 1
                        ? "var(--ink-dim)"
                        : "var(--mute-2)",
                  }}
                >
                  {crumb}
                </span>
              </span>
            ))}
          </div>

          <div className="flex-1" />

          {/* Connection pill */}
          <span
            className="hidden items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] sm:flex"
            style={{
              borderColor: "var(--line)",
              color: "var(--mute)",
              background: "var(--card)",
            }}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{
                background: connected ? "var(--mint)" : "var(--rose)",
                boxShadow: `0 0 6px ${connected ? "var(--mint)" : "var(--rose)"}`,
              }}
            />
            <span style={{ color: "var(--ink-dim)" }}>
              {connected ? "connected" : "offline"}
            </span>
          </span>

          {/* Theme toggle */}
          <ThemeToggle />

          {/* Notification bell */}
          <NotificationBell />

          {/* New Run button */}
          <Link
            href="/live"
            className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-semibold transition-all"
            style={{
              background: "var(--signal)",
              color: "#0d0a04",
              boxShadow:
                activeRuns === 0
                  ? "var(--shadow-glow), 0 0 20px color-mix(in oklch, var(--signal) 25%, transparent)"
                  : "var(--shadow-glow)",
            }}
          >
            <span className="h-3.5 w-3.5">{ICONS.play}</span>
            New Run
          </Link>
        </div>

        {/* ── Page content ── */}
        <main className="flex-1 overflow-auto">
          <div
            key={pathname}
            className="mx-auto max-w-[1340px] px-6 py-7 pb-20 animate-fade-up"
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
