"use client";

import * as React from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function RunDetailError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  React.useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[runs/[runId]/error]", error);
  }, [error]);

  const message = error?.message?.trim() ? error.message.trim() : "The run detail view failed to load.";
  const displayMessage = message.length > 600 ? `${message.slice(0, 600)}…` : message;

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <Card
        className="w-full max-w-lg overflow-hidden shadow-sm"
        style={{ borderColor: "var(--line)" }}
        role="alert"
        aria-live="assertive"
      >
        <CardHeader
          className="border-b px-6 py-5"
          style={{
            borderColor: "var(--line)",
            background:
              "linear-gradient(180deg, color-mix(in oklch, var(--rose) 7%, transparent), transparent 72%)",
          }}
        >
          <div className="flex items-start gap-3">
            <span
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
              style={{
                borderColor: "color-mix(in oklch, var(--rose) 22%, transparent)",
                background: "color-mix(in oklch, var(--rose) 10%, transparent)",
                color: "var(--rose)",
              }}
              aria-hidden
            >
              <AlertCircle className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <CardTitle className="text-base font-semibold leading-tight">Run detail failed to load</CardTitle>
              <CardDescription className="mt-1.5 text-sm leading-relaxed">
                This run view hit an unexpected error. Try resetting the view or return to the dashboard.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 px-6 py-5">
          <div
            className="rounded-lg border px-3.5 py-3"
            style={{
              borderColor: "color-mix(in oklch, var(--rose) 18%, transparent)",
              background: "color-mix(in oklch, var(--rose) 7%, transparent)",
            }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
              Error details
            </div>
            <p className="mt-1.5 break-words font-mono text-xs leading-relaxed" style={{ color: "var(--ink)" }}>
              {displayMessage}
            </p>
            {error?.digest ? (
              <p className="mt-2 break-all font-mono text-[11px] leading-relaxed text-muted-foreground">
                Digest: {error.digest}
              </p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => reset()} className="gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" />
              Reset View
            </Button>
            <Button asChild type="button" variant="outline" size="sm" className="gap-1.5">
              <Link href="/runs">
                <ArrowLeft className="h-3.5 w-3.5" />
                Back to Runs
              </Link>
            </Button>
            <Button asChild type="button" variant="ghost" size="sm">
              <Link href="/">Back to Dashboard</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
