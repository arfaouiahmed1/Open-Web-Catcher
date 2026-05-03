"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { apiUrl } from "@/lib/api";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ConsoleSidebar } from "@/components/console/layout/console-sidebar";
import { ConsoleTopbar } from "@/components/console/layout/console-topbar";

const ACTIVE_RUNS_POLL_MS = 8000;

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
          setActiveRuns(
            (payload?.active_runs || []).filter((item) => !item.completed).length,
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

  return (
    <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <div className="grid min-h-screen md:grid-cols-[240px_1fr]">
        <aside className="hidden md:sticky md:top-0 md:block md:h-screen">
          <ConsoleSidebar
            pathname={pathname}
            activeRuns={activeRuns}
            connected={connected}
          />
        </aside>

        <SheetContent
          side="left"
          className="w-[240px] border-r p-0 md:hidden"
        >
          <ConsoleSidebar
            pathname={pathname}
            activeRuns={activeRuns}
            connected={connected}
            onNavigate={() => setSidebarOpen(false)}
          />
        </SheetContent>

        <div className="flex min-w-0 flex-col">
          <ConsoleTopbar
            pathname={pathname}
            connected={connected}
            onMenuClick={() => setSidebarOpen(true)}
          />
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
    </Sheet>
  );
}
