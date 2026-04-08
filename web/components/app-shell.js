"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Bot,
  Database,
  FlaskConical,
  Gauge,
  Network,
  PlaySquare,
  Settings2,
  Wrench,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/",            label: "Overview",      icon: Gauge,       section: null },
  { href: "/live",        label: "Live Pipeline", icon: PlaySquare,  section: "Run" },
  { href: "/agents",      label: "Agent Lab",     icon: Bot,         section: "Run" },
  { href: "/tools",       label: "Tool Playground",icon: Wrench,     section: "Run" },
  { href: "/runs",        label: "Run History",   icon: Activity,    section: "Inspect" },
  { href: "/providers",   label: "Provider Intel",icon: Network,     section: "Inspect" },
  { href: "/evaluations", label: "Evaluations",   icon: FlaskConical,section: "Inspect" },
  { href: "/database",    label: "Database",      icon: Database,    section: "System" },
  { href: "/settings",    label: "Settings",      icon: Settings2,   section: "System" },
];

function NavGroup({ label, items, pathname }) {
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

export function AppShell({ children }) {
  const pathname = usePathname();

  const groups = [
    { label: "Run",     items: NAV.filter((n) => n.section === "Run") },
    { label: "Inspect", items: NAV.filter((n) => n.section === "Inspect") },
    { label: "System",  items: NAV.filter((n) => n.section === "System") },
  ];

  const overviewItem = NAV.find((n) => n.section === null);
  const overviewActive = pathname === "/";

  return (
    <div className="flex min-h-screen bg-ink">
      {/* sidebar */}
      <aside className="flex w-56 shrink-0 flex-col border-r border-white/6 bg-surface">
        {/* logo */}
        <div className="flex items-center gap-2.5 border-b border-white/6 px-4 py-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-signal/20">
            <Shield className="h-4 w-4 text-signal" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white leading-none">OWC</div>
            <div className="text-[10px] text-slate-600 mt-0.5">Operator Console</div>
          </div>
        </div>

        {/* nav */}
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {/* overview */}
          <Link
            href="/"
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
            <NavGroup key={g.label} label={g.label} items={g.items} pathname={pathname} />
          ))}
        </nav>

        {/* footer */}
        <div className="border-t border-white/6 px-4 py-3">
          <div className="text-[10px] text-slate-700">Open Web Catcher v0.2</div>
        </div>
      </aside>

      {/* main */}
      <main className="flex-1 min-w-0 overflow-auto">
        <div className="mx-auto max-w-7xl px-6 py-6">
          {children}
        </div>
      </main>
    </div>
  );
}
