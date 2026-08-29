"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { StateFrame, resolveState } from "./StateFrame";
import type { ComponentState } from "./types";

export interface LogViewerProps {
  lines?: string[];
  title?: string;
  /** When set, only the LAST maxLines lines render, with a "+N earlier" head. */
  maxLines?: number;
  /** Render newest lines highlighted at the bottom (live-follow mode). */
  follow?: boolean;
  state?: ComponentState;
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  className?: string;
}

/** Monospace log tail for run output streams. */
export function LogViewer({
  lines,
  title = "Logs",
  maxLines,
  follow = false,
  state,
  loadingLabel = "Waiting for logs…",
  errorLabel,
  emptyLabel = "Log stream is empty.",
  className,
}: LogViewerProps) {
  const all = lines ?? [];
  const resolved = resolveState(state, all.length > 0);
  const visible = maxLines && all.length > maxLines ? all.slice(-maxLines) : all;
  const omitted = all.length - visible.length;
  const occurrences = new Map<string, number>();
  const keyedVisible = visible.map((line) => {
    const occurrence = occurrences.get(line) || 0;
    occurrences.set(line, occurrence + 1);
    return { key: `${line}\u0000${occurrence}`, line };
  });

  return (
    <StateFrame
      component="LogViewer"
      state={resolved}
      loadingLabel={loadingLabel}
      errorLabel={errorLabel}
      emptyLabel={emptyLabel}
      className={className}
    >
      <div className="space-y-1 p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <span className="text-xs text-muted-foreground" data-role="line-count">
            {all.length} line{all.length === 1 ? "" : "s"}
            {follow ? " · following" : ""}
          </span>
        </div>
        {omitted > 0 ? (
          <p className="text-xs text-muted-foreground">+{omitted} earlier</p>
        ) : null}
        <pre
          data-role="log-lines"
          className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-xs leading-relaxed"
        >
          {keyedVisible.map(({ key, line }, index) => (
            <div key={key} data-line={index} className="min-h-[1em]">
              {line || " "}
            </div>
          ))}
        </pre>
      </div>
    </StateFrame>
  );
}
