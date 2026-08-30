"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { StateFrame, resolveState } from "./StateFrame";
import type { ComponentState, JudgeVerdictFields } from "./types";

const VERDICT_TONE = {
  pass: {
    badge:
      "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    dot: "bg-emerald-500",
  },
  replan: {
    badge: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  fail: {
    badge: "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-400",
    dot: "bg-red-500",
  },
} as const;

function pct(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

/**
 * Judge verdict summary.
 * TODO(plan-T38-types): props mirror JudgeVerdict (src/models/judge.py) JSON
 * keys — swap for the generated type when T38 lands.
 */
export interface ValidationBadgeProps {
  verdict?: JudgeVerdictFields["verdict"];
  evidence_score?: number;
  playback_confidence?: number;
  channel_match?: boolean;
  required_fixes?: string[];
  flagged_urls?: string[];
  state?: ComponentState;
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  className?: string;
}

export function ValidationBadge({
  verdict,
  evidence_score,
  playback_confidence,
  channel_match,
  required_fixes,
  flagged_urls,
  state,
  loadingLabel,
  errorLabel,
  emptyLabel = "No verdict yet.",
  className,
}: ValidationBadgeProps) {
  const resolved = resolveState(state, Boolean(verdict));
  const tone = verdict ? VERDICT_TONE[verdict] : VERDICT_TONE.fail;
  return (
    <StateFrame
      component="ValidationBadge"
      state={resolved}
      loadingLabel={loadingLabel}
      errorLabel={errorLabel}
      emptyLabel={emptyLabel}
      className={cn("w-fit", className)}
    >
      <div className="flex flex-wrap items-center gap-2 p-2">
        <span
          data-verdict={verdict}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide",
            tone.badge,
          )}
        >
          <span aria-hidden="true" className={cn("h-2 w-2 rounded-full", tone.dot)} />
          {verdict}
        </span>
        {typeof evidence_score === "number" ? (
          <span
            data-role="evidence-score"
            className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground"
          >
            evidence {pct(evidence_score)}
          </span>
        ) : null}
        {typeof playback_confidence === "number" ? (
          <span
            data-role="playback-confidence"
            className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground"
          >
            playback {pct(playback_confidence)}
          </span>
        ) : null}
        {typeof channel_match === "boolean" ? (
          <span
            data-role="channel-match"
            className={cn(
              "rounded px-1.5 py-0.5 text-xs",
              channel_match
                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                : "bg-red-500/10 text-red-700 dark:text-red-400",
            )}
          >
            channel {channel_match ? "match ✓" : "mismatch ✗"}
          </span>
        ) : null}
        {(required_fixes?.length ?? 0) > 0 ? (
          <span
            data-role="required-fixes"
            className="rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-700 dark:text-amber-400"
          >
            {required_fixes!.length} fix{required_fixes!.length === 1 ? "" : "es"} needed
          </span>
        ) : null}
        {(flagged_urls?.length ?? 0) > 0 ? (
          <span
            data-role="flagged-urls"
            className="rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-700 dark:text-red-400"
          >
            {flagged_urls!.length} flagged URL{flagged_urls!.length === 1 ? "" : "s"}
          </span>
        ) : null}
      </div>
    </StateFrame>
  );
}
