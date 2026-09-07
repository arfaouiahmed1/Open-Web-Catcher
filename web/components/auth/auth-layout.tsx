"use client";

import Link from "next/link";
import { LogoMark } from "@/components/console/layout/navigation-config";
import { AuthBackdrop } from "./auth-backdrop";

export function AuthLayout({ children, fullWidth = false }: { children: React.ReactNode; fullWidth?: boolean }): React.JSX.Element {
  return (
    <div className="relative min-h-screen bg-background">
      <AuthBackdrop />
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background/80 px-6 backdrop-blur-md">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-lg text-primary bg-[color-mix(in_oklch,var(--signal)_13%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--signal)_22%,transparent)]">
            <LogoMark className="size-3.5" />
          </span>
          <span className="text-sm font-semibold tracking-tight">OWC</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">Operator Console</span>
        </Link>
        <div className="flex items-center gap-2">
          <Link href="/" className="text-xs font-medium text-muted-foreground hover:text-foreground">
            Overview
          </Link>
          <Link href="/login" className="text-xs font-medium text-muted-foreground hover:text-foreground">
            Log in
          </Link>
          <Link
            href="/signup"
            className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Create account
          </Link>
        </div>
      </header>
      <main
        className={
          fullWidth
            ? "relative mx-auto flex min-h-[calc(100vh-3.5rem)] w-full flex-col items-center justify-center p-0"
            : "relative mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-[1100px] flex-col items-center justify-center px-6 py-10"
        }
      >
        {children}
      </main>
    </div>
  );
}
