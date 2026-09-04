"use client";

import React from "react";
import { cn } from "@/lib/utils";
import { StateFrame, resolveState } from "./StateFrame";
import type { ComponentState, PlanStep, PlanStepStatus } from "./types";

const STEP_TONE: Record<
  PlanStepStatus,
  { dot: string; text: string; label: string }
> = {
  pending: {
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    label: "pending",
  },
  in_progress: {
    dot: "bg-[var(--sky)] animate-pulse",
    text: "text-[var(--sky-text)]",
    label: "in progress",
  },
  done: {
    dot: "bg-[var(--mint)]",
    text: "text-[var(--mint-text)]",
    label: "done",
  },
  failed: {
    dot: "bg-[var(--rose)]",
    text: "text-[var(--rose-text)]",
    label: "failed",
  },
  skipped: {
    dot: "bg-[var(--signal)]",
    text: "text-[var(--signal-text)]",
    label: "skipped",
  },
};

export interface StepTimelineProps {
  steps?: PlanStep[];
  state?: ComponentState;
  title?: string;
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  className?: string;
}

/**
 * Vertical timeline over the RunPlan step shape
 * { id, title, criteria, budget, status } (src/orchestrator/run_plan.py).
 */
export function StepTimeline({
  steps,
  state,
  title = "Run plan",
  loadingLabel,
  errorLabel,
  emptyLabel = "Plan has no steps.",
  className,
}: StepTimelineProps) {
  const list = steps ?? [];
  const resolved = resolveState(state, list.length > 0);
  return (
    <StateFrame
      component="StepTimeline"
      state={resolved}
      loadingLabel={loadingLabel}
      errorLabel={errorLabel}
      emptyLabel={emptyLabel}
      className={className}
    >
      <div className="space-y-2 p-3">
        <h3 className="text-sm font-semibold">{title}</h3>
        <ol className="space-y-3" data-role="steps">
          {list.map((step, index) => {
            const tone = STEP_TONE[step.status] ?? STEP_TONE.pending;
            return (
              <li
                key={step.id}
                data-step-id={step.id}
                data-status={step.status}
                className="relative flex gap-3 pl-1"
              >
                <span
                  aria-hidden="true"
                  className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", tone.dot)}
                />
                <div className="min-w-0 flex-1 border-b border-border/50 pb-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <span className="text-sm font-medium">
                      <span className="mr-1.5 text-muted-foreground">
                        {index + 1}.
                      </span>
                      {step.title}
                    </span>
                    <span
                      data-role="step-status"
                      className={cn(
                        "text-xs font-semibold uppercase tracking-wide",
                        tone.text,
                      )}
                    >
                      {tone.label}
                    </span>
                  </div>
                  {step.criteria ? (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      <span className="font-medium">Criteria:</span>{" "}
                      {step.criteria}
                    </p>
                  ) : null}
                  {step.budget !== null && step.budget !== undefined ? (
                    <p
                      data-role="step-budget"
                      className="mt-0.5 text-xs text-muted-foreground"
                    >
                      <span className="font-medium">Budget:</span>{" "}
                      {String(step.budget)}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </StateFrame>
  );
}
