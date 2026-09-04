"use client";

import React from "react";
import { cn, formatNumber } from "@/lib/utils";
import { StateFrame, resolveState } from "./StateFrame";
import type { ComponentState } from "./types";

export interface MetricDelta {
  value: number;
  direction: "up" | "down" | "flat";
}

export interface MetricCardProps {
  /** Optional: omitted when the card is in a non-success lifecycle. */
  label?: string;
  value?: number | string;
  unit?: string;
  delta?: MetricDelta;
  hint?: string;
  state?: ComponentState;
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  className?: string;
}

const DELTA_CLASS: Record<MetricDelta["direction"], string> = {
  up: "text-[var(--mint-text)]",
  down: "text-[var(--rose-text)]",
  flat: "text-muted-foreground",
};

/** Single KPI tile (value + optional unit/delta/hint). */
export function MetricCard({
  label,
  value,
  unit,
  delta,
  hint,
  state,
  loadingLabel,
  errorLabel,
  emptyLabel = "Metric unavailable.",
  className,
}: MetricCardProps) {
  const hasValue = value !== null && value !== undefined && value !== "";
  const resolved = resolveState(state, hasValue);
  const display =
    typeof value === "number"
      ? formatNumber(value)
      : String(value ?? "");
  return (
    <StateFrame
      component="MetricCard"
      state={resolved}
      loadingLabel={loadingLabel}
      errorLabel={errorLabel}
      emptyLabel={emptyLabel}
      className={className}
    >
      <div className="space-y-1 p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        <p className="text-2xl font-semibold tabular-nums">
          {display}
          {unit ? (
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              {unit}
            </span>
          ) : null}
          {delta ? (
            <span
              data-delta-direction={delta.direction}
              className={cn(
                "ml-2 align-middle text-xs font-medium",
                DELTA_CLASS[delta.direction],
              )}
            >
              {delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "•"}
              {" "}
              {formatNumber(Math.abs(delta.value))}
            </span>
          ) : null}
        </p>
        {hint ? (
          <p className="text-xs text-muted-foreground">{hint}</p>
        ) : null}
      </div>
    </StateFrame>
  );
}
