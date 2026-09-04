"use client";

import Link from "next/link";
import * as React from "react";
import { NotificationBell } from "@/components/notification-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { ICONS, pathToCrumbs } from "@/components/console/layout/navigation-config";

export interface ConsoleTopbarProps {
  pathname: string;
  connected: boolean;
  onMenuClick?: () => void;
}

export const ConsoleTopbar = React.memo(function ConsoleTopbar({
  pathname,
  connected,
  onMenuClick,
}: ConsoleTopbarProps): React.JSX.Element {
  const crumbs = pathToCrumbs(pathname);

  return (
    <div
      className="sticky top-0 z-10 flex items-center gap-2 border-b px-6 py-3"
      style={{
        borderColor: "var(--line)",
        background: "color-mix(in oklch, var(--bg) 88%, transparent)",
        backdropFilter: "blur(16px)",
      }}
    >
      <Button
        type="button"
        onClick={onMenuClick}
        variant="ghost"
        size="icon-sm"
        className="mr-1 md:hidden"
        aria-label="Toggle sidebar"
      >
        <span className="h-3.5 w-3.5">{ICONS.hamburger}</span>
      </Button>

      <div key={pathname} className="flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground animate-fade-up">
        <span className="text-muted-foreground">owc</span>
        {crumbs.map((crumb, index) => (
          <span key={crumb} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            <span className={index === crumbs.length - 1 ? "text-foreground/80" : "text-muted-foreground"}>{crumb.replace(/-/g, " ")}</span>
          </span>
        ))}
      </div>

      <div className="flex-1" />

      <span className="hidden items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[10.5px] text-muted-foreground sm:flex">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{
            background: connected ? "var(--mint)" : "var(--rose)",
            boxShadow: `0 0 6px ${connected ? "var(--mint)" : "var(--rose)"}`,
          }}
        />
        <span className="text-foreground/80">{connected ? "connected" : "offline"}</span>
      </span>

      <ThemeToggle />
      <NotificationBell />

      <Button asChild variant="accent" size="sm" className="shadow-sm">
        <Link href="/live">
          <span className="h-3.5 w-3.5">{ICONS.play}</span>
          New Run
        </Link>
      </Button>
    </div>
  );
});
