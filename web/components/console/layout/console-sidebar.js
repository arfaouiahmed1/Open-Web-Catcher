"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  GROUP_COLORS,
  ICONS,
  LogoMark,
  NAV_GROUPS,
  NAV_ITEMS,
} from "@/components/console/layout/navigation-config";

function NavLink({ item, active, badge, onNavigate, accentColor }) {
  const accent = accentColor || "var(--signal)";

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        "group relative flex h-[34px] items-center gap-2.5 rounded-md px-2.5 text-[12.5px] font-medium transition-all duration-150",
        active
          ? "text-primary"
          : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
      style={
        active
          ? {
              paddingLeft: "calc(0.625rem - 2px)",
              background: `color-mix(in oklch, ${accent} 11%, transparent)`,
              borderLeft: `2px solid ${accent}`,
              color: accent,
            }
          : undefined
      }
    >
      <span
        className={cn(
          "h-[15px] w-[15px] shrink-0 transition-colors duration-150",
          active ? "" : "text-muted-foreground/50 group-hover:text-muted-foreground",
        )}
        style={active ? { color: accent } : undefined}
      >
        {ICONS[item.key]}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap leading-none">
        {item.label}
      </span>
      {badge ? (
        <span className="relative ml-auto flex h-[7px] w-[7px] shrink-0 items-center justify-center">
          <span
            className="absolute inset-0 rounded-full opacity-50"
            style={{ background: "var(--signal)", animation: "ping 1.6s ease-in-out infinite" }}
          />
          <span className="relative h-[7px] w-[7px] rounded-full bg-primary" />
        </span>
      ) : null}
    </Link>
  );
}

export function ConsoleSidebar({
  pathname,
  activeRuns,
  connected,
  onNavigate,
  className,
}) {
  const isActive = (item) =>
    item.href === "/"
      ? pathname === "/"
      : pathname === item.href || pathname.startsWith(`${item.href}/`);

  const topItem = NAV_ITEMS.find((item) => item.section === null);

  return (
    <div
      className={cn("flex h-full w-full flex-col overflow-hidden border-r bg-popover", className)}
    >
      {/* ambient gradient */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-32"
        style={{
          background:
            "linear-gradient(170deg, color-mix(in oklch, var(--signal) 5%, transparent) 0%, transparent 100%)",
        }}
      />

      {/* Header */}
      <div className="relative z-10 flex h-11 shrink-0 items-center gap-2.5 border-b px-4">
        <div
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-lg text-primary"
          style={{
            background: "color-mix(in oklch, var(--signal) 13%, transparent)",
            boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--signal) 26%, transparent)",
          }}
        >
          <LogoMark className="h-[14px] w-[14px]" />
        </div>
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-[12.5px] font-semibold tracking-tight text-foreground">OWC</span>
          <span className="text-[10px] font-medium text-muted-foreground/40">v0.1</span>
        </div>
        <span
          className="ml-auto h-[7px] w-[7px] shrink-0 rounded-full transition-colors animate-breathe"
          style={{
            background: connected ? "var(--mint)" : "var(--rose)",
            boxShadow: `0 0 0 2.5px color-mix(in oklch, ${connected ? "var(--mint)" : "var(--rose)"} 22%, transparent)`,
          }}
          title={connected ? "API connected" : "API unreachable"}
        />
      </div>

      {/* Nav */}
      <nav className="relative z-10 flex-1 overflow-y-auto px-2.5 py-3">
        {/* Dashboard (top-level, no group) */}
        <Link
          href={topItem.href}
          onClick={onNavigate}
          className={cn(
            "group flex h-[36px] items-center gap-2.5 rounded-md px-2.5 text-[13px] font-medium transition-all duration-150",
            isActive(topItem)
              ? "text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
          )}
          style={
            isActive(topItem)
              ? {
                  paddingLeft: "calc(0.625rem - 2px)",
                  background: "color-mix(in oklch, var(--signal) 11%, transparent)",
                  color: "var(--signal)",
                  borderLeft: "2px solid var(--signal)",
                }
              : undefined
          }
        >
          <span
            className={cn(
              "h-[15px] w-[15px] shrink-0 transition-colors duration-150",
              isActive(topItem) ? "text-primary" : "text-muted-foreground/50 group-hover:text-muted-foreground",
            )}
          >
            {ICONS[topItem.key]}
          </span>
          <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
            {topItem.label}
          </span>
        </Link>

        {NAV_GROUPS.map((group) => {
          const items = NAV_ITEMS.filter((item) => item.section === group);
          const isActiveGroup = items.some((item) => isActive(item));
          const groupColor = GROUP_COLORS[group];

          return (
            <div key={group} className="mt-5">
              <div className="mb-1 flex items-center gap-1.5 px-2.5">
                <span
                  className="h-[5px] w-[5px] shrink-0 rounded-full transition-colors duration-300"
                  style={{ background: isActiveGroup ? groupColor : "var(--muted-foreground)" }}
                />
                <span
                  className="text-[9.5px] font-semibold uppercase tracking-[0.14em] transition-colors duration-300"
                  style={{ color: isActiveGroup ? groupColor : "var(--muted-foreground)" }}
                >
                  {group}
                </span>
              </div>
              <div className="space-y-px">
                {items.map((item) => (
                  <NavLink
                    key={item.href}
                    item={item}
                    active={isActive(item)}
                    badge={item.badge && activeRuns > 0}
                    onNavigate={onNavigate}
                    accentColor={groupColor}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="relative z-10 flex shrink-0 flex-col gap-2 border-t bg-popover px-3 py-3">
        <Button asChild variant="accent" size="sm" className="w-full justify-center gap-2">
          <Link href="/live">
            <span className="h-3.5 w-3.5">{ICONS.play}</span>
            New Run
          </Link>
        </Button>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span
              className="h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ background: connected ? "var(--mint)" : "var(--rose)" }}
            />
            <span className="text-[10.5px] font-medium text-muted-foreground">
              {connected ? "live" : "offline"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {activeRuns > 0 ? (
              <Badge tone="signal" className="gap-1.5 px-2 py-0.5 text-[10px]">
                <span className="relative flex h-[6px] w-[6px] shrink-0">
                  <span
                    className="absolute inset-0 rounded-full opacity-55"
                    style={{ background: "var(--signal)", animation: "ping 1.6s ease-in-out infinite" }}
                  />
                  <span className="relative h-[6px] w-[6px] rounded-full bg-primary" />
                </span>
                {activeRuns}
              </Badge>
            ) : null}
            <ThemeToggle />
          </div>
        </div>
      </div>
    </div>
  );
}
