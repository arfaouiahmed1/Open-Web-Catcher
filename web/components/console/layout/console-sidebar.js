"use client";

import Link from "next/link";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
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
        "group relative flex h-[34px] items-center gap-2.5 rounded-[9px] text-[12.5px] font-medium transition-all duration-150",
        active
          ? ""
          : "text-[var(--mute)] hover:bg-white/[0.04] hover:text-[var(--ink-dim)]",
      )}
      style={
        active
          ? {
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
      <span
        className={cn(
          "h-[15px] w-[15px] shrink-0 transition-colors duration-150",
          active ? "" : "text-[var(--mute-2)] group-hover:text-[var(--mute)]",
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
      className={cn("flex h-full w-full flex-col overflow-hidden border-r", className)}
      style={{ borderColor: "var(--line)", background: "var(--panel)" }}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-32"
        style={{
          background:
            "linear-gradient(170deg, color-mix(in oklch, var(--signal) 5%, transparent) 0%, transparent 100%)",
        }}
      />

      <div
        className="relative z-10 flex h-11 shrink-0 items-center gap-2.5 border-b px-4"
        style={{ borderColor: "var(--line)" }}
      >
        <div
          className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[7px]"
          style={{
            background: "color-mix(in oklch, var(--signal) 13%, transparent)",
            boxShadow:
              "inset 0 0 0 1px color-mix(in oklch, var(--signal) 26%, transparent), 0 2px 8px color-mix(in oklch, var(--signal) 12%, transparent)",
            color: "var(--signal)",
          }}
        >
          <LogoMark className="h-[14px] w-[14px]" />
        </div>
        <div className="flex min-w-0 items-baseline gap-1.5">
          <span className="text-[12.5px] font-semibold tracking-tight" style={{ color: "var(--ink)" }}>
            OWC
          </span>
          <span className="text-[10px] font-medium" style={{ color: "var(--mute-3)" }}>
            v0.1
          </span>
        </div>
        <span
          className="ml-auto h-[7px] w-[7px] shrink-0 rounded-full transition-colors"
          style={{
            background: connected ? "var(--mint)" : "var(--rose)",
            boxShadow: `0 0 0 2.5px color-mix(in oklch, ${connected ? "var(--mint)" : "var(--rose)"} 22%, transparent)`,
            animation: "breathe 2s ease-in-out infinite",
          }}
          title={connected ? "API connected" : "API unreachable"}
        />
      </div>

      <nav className="relative z-10 flex-1 overflow-y-auto px-2.5 py-3">
        <Link
          href={topItem.href}
          onClick={onNavigate}
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
                  background: "color-mix(in oklch, var(--signal) 11%, transparent)",
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

        {NAV_GROUPS.map((group) => {
          const items = NAV_ITEMS.filter((item) => item.section === group);
          const isActiveGroup = items.some((item) => isActive(item));
          const groupColor = GROUP_COLORS[group];

          return (
            <div key={group} className="mt-5">
              <div className="mb-1 flex items-center gap-1.5 px-2.5">
                <span
                  className="h-[5px] w-[5px] shrink-0 rounded-full transition-colors duration-300"
                  style={{ background: isActiveGroup ? groupColor : "var(--mute-3)" }}
                />
                <span
                  className="text-[9.5px] font-semibold uppercase tracking-[0.14em] transition-colors duration-300"
                  style={{ color: isActiveGroup ? groupColor : "var(--mute-3)" }}
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

      <div
        className="relative z-10 flex shrink-0 items-center justify-between border-t px-3 py-2.5"
        style={{
          borderColor: "var(--line)",
          background: "color-mix(in oklch, var(--panel) 92%, var(--bg))",
        }}
      >
        <div className="flex items-center gap-1.5">
          <span
            className="h-[6px] w-[6px] shrink-0 rounded-full"
            style={{ background: connected ? "var(--mint)" : "var(--rose)" }}
          />
          <span className="text-[10.5px] font-medium" style={{ color: "var(--mute)" }}>
            {connected ? "live" : "offline"}
          </span>
        </div>
        {activeRuns > 0 ? (
          <Badge tone="signal" className="gap-1.5 px-2 py-0.5 text-[10px]">
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
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
