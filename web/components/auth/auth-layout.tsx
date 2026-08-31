"use client";

import Link from "next/link";
import { LogoMark } from "@/components/console/layout/navigation-config";

export function AuthLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="min-h-screen bg-[radial-gradient(1200px_600px_at_20%_-10%,color-mix(in_oklch,var(--signal)_6%,transparent),transparent_60%),radial-gradient(900px_500px_at_100%_0%,color-mix(in_oklch,var(--violet)_4%,transparent),transparent_60%)] bg-background">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background/80 px-6 backdrop-blur-md">
        <Link href="/" className="flex items-center gap-2.5">
          <span
            className="flex size-7 items-center justify-center rounded-lg text-primary"
            style={{
              background: "color-mix(in oklch, var(--signal) 13%, transparent)",
              boxShadow: "inset 0 0 0 1px color-mix(in oklch, var(--signal) 22%, transparent)",
            }}
          >
            <LogoMark className="size-3.5" />
          </span>
          <span className="text-sm font-semibold tracking-tight">OWC</span>
          <span className="hidden text-xs text-muted-foreground sm:inline">Operator Console</span>
        </Link>
        <div className="flex items-center gap-2">
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
      <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-[1100px] flex-col items-center justify-center px-6 py-10">
        {children}
      </main>
    </div>
  );
}
