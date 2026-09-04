"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { StateFrame, resolveState } from "./StateFrame";
import type { ComponentState } from "./types";

export type StatusTone =
  | "neutral"
  | "info"
  | "sky"
  | "signal"
  | "success"
  | "warning"
  | "danger";

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: "bg-muted text-muted-foreground border-border",
  info: "border-[color-mix(in_oklch,var(--sky)_28%,transparent)] bg-[color-mix(in_oklch,var(--sky)_12%,transparent)] text-[var(--sky-text)]",
  sky: "border-[color-mix(in_oklch,var(--sky)_28%,transparent)] bg-[color-mix(in_oklch,var(--sky)_12%,transparent)] text-[var(--sky-text)]",
  signal: "border-[color-mix(in_oklch,var(--signal)_28%,transparent)] bg-[color-mix(in_oklch,var(--signal)_12%,transparent)] text-[var(--signal-text)]",
  success:
    "border-[color-mix(in_oklch,var(--mint)_28%,transparent)] bg-[color-mix(in_oklch,var(--mint)_12%,transparent)] text-[var(--mint-text)]",
  warning:
    "border-[color-mix(in_oklch,var(--signal)_28%,transparent)] bg-[color-mix(in_oklch,var(--signal)_12%,transparent)] text-[var(--signal-text)]",
  danger: "border-[color-mix(in_oklch,var(--rose)_28%,transparent)] bg-[color-mix(in_oklch,var(--rose)_12%,transparent)] text-[var(--rose-text)]",
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
      surface={false}
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
