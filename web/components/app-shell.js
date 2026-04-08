import Link from "next/link";
import { Activity, Bot, Database, FlaskConical, Gauge, Network, PlaySquare, Settings2, Wrench } from "lucide-react";

const NAV_ITEMS = [
  { href: "/", label: "Overview", icon: Gauge },
  { href: "/live", label: "Live Workflow", icon: PlaySquare },
  { href: "/agents", label: "Agent Lab", icon: Bot },
  { href: "/tools", label: "Tool Playground", icon: Wrench },
  { href: "/providers", label: "Provider Intel", icon: Network },
  { href: "/runs", label: "Runs Explorer", icon: Activity },
  { href: "/evaluations", label: "Evaluations", icon: FlaskConical },
  { href: "/database", label: "Database", icon: Database },
  { href: "/settings", label: "Pricing", icon: Settings2 }
];

export function AppShell({ children }) {
  return (
    <div className="min-h-screen bg-[#050b13] text-white">
      <div className="grid min-h-screen grid-cols-1 xl:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="border-r border-white/10 bg-[radial-gradient(circle_at_top,_rgba(117,169,255,0.16),_transparent_32%),linear-gradient(180deg,#091522_0%,#07111c_100%)] p-6">
          <div className="rounded-[28px] border border-white/10 bg-white/5 p-5">
            <div className="text-xs uppercase tracking-[0.4em] text-spark">OWC</div>
            <h1 className="mt-3 text-2xl font-semibold">Operator Console</h1>
            <p className="mt-3 text-sm leading-6 text-slate-300">
              A node-driven control room for orchestrator runs, agent probes, tool tests, evaluations, and cost analytics.
            </p>
          </div>
          <nav className="mt-6 space-y-2">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="flex items-center gap-3 rounded-2xl border border-transparent bg-white/5 px-4 py-3 text-sm text-slate-200 transition hover:border-white/10 hover:bg-white/10"
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <main className="bg-[radial-gradient(circle_at_top_left,_rgba(22,184,166,0.15),_transparent_20%),radial-gradient(circle_at_top_right,_rgba(255,140,66,0.15),_transparent_24%),linear-gradient(180deg,#07101b_0%,#04080f_100%)] p-6 md:p-8">
          {children}
        </main>
      </div>
    </div>
  );
}
