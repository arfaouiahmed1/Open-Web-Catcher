"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { StateFrame, resolveState } from "./StateFrame";
import type { ComponentState, ReasoningEntry } from "./types";

export interface ReasoningTraceProps {
  entries?: ReasoningEntry[];
  state?: ComponentState;
  title?: string;
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  className?: string;
}

/**
 * Ordered chain-of-thought / agent reasoning feed. Entries render newest-last
 * with an optional collapsible thought body.
 */
export function ReasoningTrace({
  entries,
  state,
  title = "Reasoning trace",
  loadingLabel,
  errorLabel,
  emptyLabel = "No reasoning recorded yet.",
  className,
}: ReasoningTraceProps) {
  const list = entries ?? [];
  const resolved = resolveState(state, list.length > 0);
  return (
    <StateFrame
      component="ReasoningTrace"
      state={resolved}
      loadingLabel={loadingLabel}
      errorLabel={errorLabel}
      emptyLabel={emptyLabel}
      className={className}
    >
      <div className="space-y-1 p-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <ol className="space-y-2" data-role="entries">
          {list.map((entry, index) => (
            <li
              key={entry.id}
              data-entry-id={entry.id}
              className="rounded-md border border-border/60 bg-muted/30 p-2"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium">
                  <span className="mr-1.5 text-muted-foreground">
                    {index + 1}.
                  </span>
                  {entry.title}
                </span>
                {entry.timestamp ? (
                  <time
                    dateTime={entry.timestamp}
                    className="shrink-0 text-xs text-muted-foreground"
                  >
                    {entry.timestamp}
                  </time>
                ) : null}
              </div>
              {entry.thought ? (
                <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
                  {entry.thought}
                </p>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </StateFrame>
  );
}
