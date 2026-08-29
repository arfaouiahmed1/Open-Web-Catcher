"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { StateFrame, resolveState } from "./StateFrame";
import type { ComponentState } from "./types";

export type StatusTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger";

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  info: "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-400",
  success:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  warning:
    "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  danger: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
};

export interface StatusBadgeProps {
  /** Optional: omitted when the badge is in a non-success lifecycle. */
  label?: string;
  tone?: StatusTone;
  state?: ComponentState;
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  className?: string;
}

/** Compact pill for run / step / verdict statuses. */
export function StatusBadge({
  label,
  tone = "neutral",
  state,
  loadingLabel,
  errorLabel,
  emptyLabel,
  className,
}: StatusBadgeProps) {
  const resolved = resolveState(state, Boolean(label));
  return (
    <StateFrame
      component="StatusBadge"
      state={resolved}
      loadingLabel={loadingLabel}
      errorLabel={errorLabel}
      emptyLabel={emptyLabel}
      className={cn("inline-flex w-fit", className)}
    >
      <span
        data-tone={tone}
        className={cn(
          "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium uppercase tracking-wide",
          TONE_CLASS[tone],
        )}
      >
        {label}
      </span>
    </StateFrame>
  );
}
