"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { StateFrame, resolveState } from "./StateFrame";
import type { ComponentState, FeedEvent } from "./types";

const LEVEL_DOT: Record<NonNullable<FeedEvent["level"]>, string> = {
  debug: "bg-muted-foreground/50",
  info: "bg-blue-500",
  warn: "bg-amber-500",
  error: "bg-red-500",
};

export interface EventFeedItemProps {
  event?: FeedEvent;
  state?: ComponentState;
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  className?: string;
}

/**
 * One row of the console event feed (SSE carrier events). Intended to be
 * stacked inside the consumer's own list container.
 */
export function EventFeedItem({
  event,
  state,
  loadingLabel,
  errorLabel,
  emptyLabel = "No events yet.",
  className,
}: EventFeedItemProps) {
  const resolved = resolveState(state, Boolean(event));
  return (
    <StateFrame
      component="EventFeedItem"
      state={resolved}
      loadingLabel={loadingLabel}
      errorLabel={errorLabel}
      emptyLabel={emptyLabel}
      className={className}
    >
      {event ? (
        <article
          data-event-id={event.id}
          data-level={event.level ?? "info"}
          data-kind={event.kind}
          className="flex items-start gap-2 p-3 text-sm"
        >
          <span
            aria-hidden="true"
            className={cn(
              "mt-1.5 h-2 w-2 shrink-0 rounded-full",
              LEVEL_DOT[event.level ?? "info"],
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span className="font-medium">{event.message}</span>
              {event.timestamp ? (
                <time
                  dateTime={event.timestamp}
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {event.timestamp}
                </time>
              ) : null}
            </div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              {event.kind}
            </p>
          </div>
        </article>
      ) : null}
    </StateFrame>
  );
}
