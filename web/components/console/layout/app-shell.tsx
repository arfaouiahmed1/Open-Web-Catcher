"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import * as React from "react";
import { apiUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { NotificationBell } from "@/components/notification-provider";
import { Badge } from "@/components/ui/badge";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarSeparator,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { GROUP_COLORS, ICONS, LogoMark, NAV_GROUPS, NAV_ITEMS, type NavItem, type NavChild } from "@/components/console/layout/navigation-config";

function isActiveLink(item: NavItem, pathname: string): boolean {
  if (item.href === "/") return pathname === "/";
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

function isActiveNavItem(item: NavItem | NavChild, pathname: string, searchParams: URLSearchParams): boolean {
  const [path, queryString] = item.href.split("?");
  const matchesPath = path === "/" ? pathname === "/" : pathname === path || pathname.startsWith(`${path}/`);
  if (!matchesPath) return false;
  if (!queryString) return true;
  const expected = new URLSearchParams(queryString);
  for (const [key, value] of expected.entries()) {
    if (searchParams.get(key) !== value) return false;
  }
  return true;
}

interface NavChildListProps {
  items?: NavChild[];
  pathname: string;
  searchParams: URLSearchParams;
}

const NavChildList = React.memo(function NavChildList({ items, pathname, searchParams }: NavChildListProps): React.JSX.Element | null {
  if (!items?.length) return null;
  return (
    <div className="ml-4 space-y-0.5 border-l border-sidebar-border/40 pl-3 group-data-[collapsible=icon]:hidden">
      {items.map((item) => {
        const active = isActiveNavItem(item, pathname, searchParams);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "block rounded-md px-2.5 py-1.5 text-[11.5px] font-medium leading-tight transition-colors duration-150",
              active ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm" : "text-sidebar-foreground/55 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
});

interface SidebarNavigationProps {
  pathname: string;
  activeRuns: number;
}

function SidebarNavigation({ pathname, activeRuns }: SidebarNavigationProps): React.JSX.Element {
  const searchParams = useSearchParams();
  const topItem = NAV_ITEMS.find((item) => item.section === null)!;
  const topHref = topItem.children?.[0]?.href ?? topItem.href;
  const topActive = isActiveNavItem(topItem, pathname, searchParams) || (topItem.children?.some((c) => isActiveNavItem(c, pathname, searchParams)) ?? false);

  return (
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <div className="space-y-1">
                <SidebarMenuButton asChild isActive={topActive} tooltip={topItem.label}>
                  <Link href={topHref}>
                    <span className="size-4 shrink-0">{ICONS[topItem.key]}</span>
                    <span>{topItem.label}</span>
                  </Link>
                </SidebarMenuButton>
                <NavChildList items={topItem.children} pathname={pathname} searchParams={searchParams} />
              </div>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>

      {NAV_GROUPS.map((group) => {
        const items = NAV_ITEMS.filter((item) => item.section === group);
        return (
          <SidebarGroup key={group}>
            <SidebarGroupLabel>{group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => {
                  const active = isActiveNavItem(item, pathname, searchParams);
                  const childActive = item.children?.some((child) => isActiveNavItem(child, pathname, searchParams)) ?? false;
                  const showBadge = Boolean(item.badge && activeRuns > 0);
                  const navHref = item.children?.[0]?.href ?? item.href;
                  return (
                    <SidebarMenuItem key={item.href}>
                      <div className="space-y-1">
                        <div className="relative">
                          <SidebarMenuButton asChild isActive={active || childActive} tooltip={item.label}>
                            <Link href={navHref}>
                              <span className="size-4 shrink-0">{ICONS[item.key]}</span>
                              <span>{item.label}</span>
                            </Link>
                          </SidebarMenuButton>
                          {showBadge ? <SidebarMenuBadge className="bg-primary text-primary-foreground">{activeRuns}</SidebarMenuBadge> : null}
                        </div>
                        <NavChildList items={item.children} pathname={pathname} searchParams={searchParams} />
                      </div>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
    </SidebarContent>
  );
}

export interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps): React.JSX.Element {
  const pathname = usePathname();
  const [activeRuns, setActiveRuns] = React.useState(0);
  const [connected, setConnected] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    async function refreshActiveRuns(): Promise<void> {
      try {
        const res = await fetch(apiUrl("/ui/overview"), { cache: "no-store" });
        if (!res.ok || cancelled) {
          if (!cancelled) setConnected(false);
          return;
        }
        const payload: { active_runs?: Array<{ completed?: boolean }> } = await res.json();
        if (!cancelled) {
          setActiveRuns((payload?.active_runs || []).filter((item) => !item.completed).length);
          setConnected(true);
        }
      } catch {
        if (!cancelled) setConnected(false);
      }
    }
    function onVisibility(): void {
      if (document.visibilityState === "visible") void refreshActiveRuns();
    }
    window.addEventListener("owc:run-state-changed", refreshActiveRuns as EventListener);
    document.addEventListener("visibilitychange", onVisibility);
    void refreshActiveRuns();
    return () => {
      cancelled = true;
      window.removeEventListener("owc:run-state-changed", refreshActiveRuns as EventListener);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const currentSectionKey = pathname.split("/")[1] || "dashboard";
  const currentSection: string =
    (
      {
        dashboard: "dashboard",
        live: "live pipeline",
        runs: "view results",
        providers: "providers",
        settings: "settings",
      } as Record<string, string>
    )[currentSectionKey] || currentSectionKey.replace(/-/g, " ");

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <Link href="/" className="flex items-center gap-2.5 px-2 py-2">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-lg text-primary transition-colors"
              style={{
                background: "color-mix(in oklch, var(--signal) 13%, transparent)",
                boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--signal) 22%, transparent)",
              }}
            >
              <LogoMark className="size-3.5" />
            </span>
            <div className="flex min-w-0 flex-col leading-tight group-data-[collapsible=icon]:hidden">
              <span className="text-sm font-semibold tracking-tight text-sidebar-foreground">OWC</span>
              <span className="text-[10px] font-medium tracking-wide text-sidebar-foreground/45">Operator Console</span>
            </div>
            <span
              className="ml-auto size-1.5 shrink-0 rounded-full group-data-[collapsible=icon]:hidden"
              style={{
                background: connected ? "var(--mint)" : "var(--rose)",
                boxShadow: connected ? "0 0 8px color-mix(in oklch, var(--mint) 40%, transparent)" : undefined,
                animation: "breathe 2.2s ease-in-out infinite",
              }}
              title={connected ? "API connected" : "API unreachable"}
              aria-label={connected ? "API connected" : "API offline"}
            />
          </Link>
        </SidebarHeader>

        <SidebarSeparator />

        <React.Suspense fallback={<div className="flex-1 py-6"><div className="mx-2 h-4 animate-pulse rounded bg-muted" /></div>}>
          <SidebarNavigation pathname={pathname} activeRuns={activeRuns} />
        </React.Suspense>

        <SidebarFooter>
          <Button asChild variant="accent" size="sm" className="w-full justify-center gap-2 shadow-sm group-data-[collapsible=icon]:hidden hover:shadow">
            <Link href="/live">
              <span className="size-3.5">{ICONS.play}</span>
              New Run
            </Link>
          </Button>

          <div className="flex items-center justify-between gap-2 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-1.5 group-data-[collapsible=icon]:hidden">
            <div className="flex items-center gap-1.5">
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: connected ? "var(--mint)" : "var(--rose)" }} />
              <span className="text-[10.5px] font-medium text-sidebar-foreground/60">{connected ? "live" : "offline"}</span>
            </div>
            <ThemeToggle />
          </div>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset>
        <header className="sticky top-0 z-10 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/80 px-4 backdrop-blur-md supports-[backdrop-filter]:bg-background/60">
          <SidebarTrigger />
          <Separator orientation="vertical" className="mx-1 h-4" />
          <Breadcrumb className="hidden sm:flex">
            <BreadcrumbList className="text-xs">
              <BreadcrumbItem>
                <span className="text-muted-foreground">Console</span>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage className="capitalize font-medium">{currentSection}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <Badge tone="muted" className="sm:hidden font-sans text-[11px] tracking-wide">
            {currentSection}
          </Badge>
          <div className="ml-auto flex items-center gap-2">
            {activeRuns > 0 ? (
              <Badge tone="signal" className="gap-1.5 px-2.5 py-0.5 text-[10px] font-mono">
                <span className="relative flex h-[6px] w-[6px] shrink-0">
                  <span className="absolute inset-0 rounded-full opacity-55" style={{ background: "var(--signal)", animation: "ping 1.6s ease-in-out infinite" }} />
                  <span className="relative h-[6px] w-[6px] rounded-full bg-primary" />
                </span>
                {activeRuns} live
              </Badge>
            ) : null}
            <NotificationBell />
          </div>
        </header>

        <main className="flex-1 overflow-auto bg-[radial-gradient(1200px_400px_at_20%_-10%,color-mix(in_oklch,var(--signal)_4%,transparent),transparent_60%),radial-gradient(900px_300px_at_100%_0%,color-mix(in_oklch,var(--violet)_3%,transparent),transparent_60%)]">
          <div key={pathname} className={cn("mx-auto w-full px-5 sm:px-6 py-6 pb-20 animate-fade-up", "max-w-[var(--content-max)]")}>
            {children}
          </div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
