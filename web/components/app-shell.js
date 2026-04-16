"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity,
  Bot,
  Database,
  FlaskConical,
  Gauge,
  Menu,
  Network,
  PlaySquare,
  Settings2,
  Wrench,
  Shield,
  FilePenLine,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { apiUrl } from "@/lib/api";

const NAV = [
  { href: "/",            label: "Overview",        icon: Gauge,        section: null },
  { href: "/live",        label: "Live Pipeline",   icon: PlaySquare,   section: "Run" },
  { href: "/agents",      label: "Agent Lab",       icon: Bot,          section: "Run" },
  { href: "/tools",       label: "Tool Playground", icon: Wrench,       section: "Run" },
  { href: "/runs",        label: "Run History",     icon: Activity,     section: "Inspect" },
  { href: "/providers",   label: "Provider Intel",  icon: Network,      section: "Inspect" },
  { href: "/evaluations", label: "Evaluations",     icon: FlaskConical, section: "Inspect" },
  { href: "/database",    label: "Database",        icon: Database,     section: "System" },
  { href: "/prompts",     label: "Prompts",         icon: FilePenLine,  section: "System" },
  { href: "/settings",    label: "Settings",        icon: Settings2,    section: "System" },
];

function NavGroup({ label, items, pathname, onNavigate }) {
  return (
    <div className="mt-5">
      <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-slate-600">
        {label}
      </div>
      {items.map((item) => {
        const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              active
                ? "bg-white/8 text-white font-medium"
                : "text-slate-500 hover:bg-white/4 hover:text-slate-300"
            )}
          >
            <Icon className={cn("h-4 w-4 shrink-0", active ? "text-signal" : "text-slate-600")} />
            {item.label}
            {active && (
              <div className="ml-auto h-1.5 w-1.5 rounded-full bg-signal" />
            )}
          </Link>
        );
      })}
    </div>
  );
}

function ShortcutHelp({ open, onClose }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-xl border border-white/10 bg-surface p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 text-sm font-semibold text-white">Keyboard shortcuts</div>
        <ul className="space-y-1.5 text-xs text-slate-300">
          <li><span className="font-mono text-signal">?</span> toggle this help</li>
          <li><span className="font-mono text-signal">R</span> run (on Live/Agent pages)</li>
          <li><span className="font-mono text-signal">C</span> cancel active run</li>
        </ul>
      </div>
    </div>
  );
}

export function AppShell({ children }) {
  const pathname = usePathname();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [activeRuns, setActiveRuns] = useState(0);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key === "?") {
        event.preventDefault();
        setShortcutOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadActiveRuns() {
      try {
        const res = await fetch(apiUrl("/ui/overview"), { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const payload = await res.json();
        if (!cancelled) setActiveRuns((payload?.active_runs || []).filter((item) => !item.completed).length);
      } catch {
        // ignore
      }
    }
    loadActiveRuns();
    const timer = setInterval(loadActiveRuns, 8000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const groups = [
    { label: "Run",     items: NAV.filter((n) => n.section === "Run") },
    { label: "Inspect", items: NAV.filter((n) => n.section === "Inspect") },
    { label: "System",  items: NAV.filter((n) => n.section === "System") },
  ];

  const overviewItem = NAV.find((n) => n.section === null);
  const overviewActive = pathname === "/";

  return (
    <div className="flex min-h-screen bg-ink">
      <ShortcutHelp open={shortcutOpen} onClose={() => setShortcutOpen(false)} />
      <button
        type="button"
        onClick={() => setSidebarOpen((v) => !v)}
        className="fixed left-3 top-3 z-40 rounded-md border border-white/10 bg-surface p-2 text-slate-300 md:hidden"
      >
        {sidebarOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
      </button>

      <aside className={cn(
        "fixed inset-y-0 left-0 z-30 flex w-64 shrink-0 flex-col border-r border-white/6 bg-surface transition-transform md:static md:translate-x-0",
        sidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="flex items-center gap-2.5 border-b border-white/6 px-4 py-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-signal/20">
            <Shield className="h-4 w-4 text-signal" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white leading-none">OWC</div>
            <div className="text-[10px] text-slate-600 mt-0.5">Operator Console</div>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3">
          <Link
            href={overviewItem?.href || "/"}
            onClick={() => setSidebarOpen(false)}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              overviewActive
                ? "bg-white/8 text-white font-medium"
                : "text-slate-500 hover:bg-white/4 hover:text-slate-300"
            )}
          >
            <Gauge className={cn("h-4 w-4 shrink-0", overviewActive ? "text-signal" : "text-slate-600")} />
            Overview
            {overviewActive && <div className="ml-auto h-1.5 w-1.5 rounded-full bg-signal" />}
          </Link>

          {groups.map((g) => (
            <NavGroup key={g.label} label={g.label} items={g.items} pathname={pathname} onNavigate={() => setSidebarOpen(false)} />
          ))}
        </nav>

        <div className="border-t border-white/6 px-4 py-3">
          <div className="mb-1.5 flex items-center gap-2 text-[10px] text-slate-500">
            <span className={cn("inline-block h-1.5 w-1.5 rounded-full", activeRuns > 0 ? "bg-emerald-400 animate-pulse" : "bg-slate-700")} />
            {activeRuns} active run{activeRuns !== 1 ? "s" : ""}
          </div>
          <a
            href="https://github.com/arfaouiahmed1/Open-Web-Catcher/releases"
            target="_blank"
            rel="noreferrer"
            className="text-[10px] text-slate-700 hover:text-slate-400"
          >
            Open Web Catcher v0.2
          </a>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-auto">
        <div className="mx-auto max-w-7xl px-6 py-6 pt-14 md:pt-6">
          {children}
        </div>
      </main>
    </div>
  );
}
