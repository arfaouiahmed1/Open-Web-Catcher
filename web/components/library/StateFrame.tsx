"use client";

import React from "react";
import { cn } from "@/lib/utils";
import type { ComponentState } from "./types";

export type {
  ComponentState,
  FeedEvent,
  JudgeVerdictFields,
  JudgeVerdictValue,
  PlanStep,
  PlanStepStatus,
  ReasoningEntry,
  RunCostFields,
} from "./types";

export function resolveState(
  state: ComponentState | undefined,
  hasData: boolean,
): ComponentState {
  if (state) return state;
  return hasData ? "success" : "empty";
}

export interface StateFrameProps {
  /** Short machine name used as data-component for tests/storybook tooling. */
  component: string;
  state: ComponentState;
  loadingLabel?: string;
  errorLabel?: string;
  emptyLabel?: string;
  surface?: boolean;
  className?: string;
  children?: React.ReactNode;
}

const NON_SUCCESS_LABEL: Record<
  Exclude<ComponentState, "success">,
  string
> = {
  loading: "Loading…",
  error: "Something went wrong.",
  empty: "Nothing to show yet.",
};

/**
 * Shared shell that renders every non-ready lifecycle (loading / error /
 * empty) uniformly and passes through children only in the success state.
 */
export function StateFrame({
  component,
  state,
  loadingLabel,
  errorLabel,
  emptyLabel,
  surface = true,
  className,
  children,
}: StateFrameProps) {
  const label =
    state === "loading"
      ? (loadingLabel ?? NON_SUCCESS_LABEL.loading)
      : state === "error"
        ? (errorLabel ?? NON_SUCCESS_LABEL.error)
        : state === "empty"
          ? (emptyLabel ?? NON_SUCCESS_LABEL.empty)
          : null;

  return (
    <div
      data-component={component}
      data-state={state}
      className={cn(
        surface && "rounded-lg border border-border bg-card text-card-foreground",
        state === "loading" && "animate-pulse",
        className,
      )}
    >
      {state === "success" ? (
        children
      ) : (
        <div
          data-role="state-message"
          className={cn(
            "flex min-h-[2.5rem] items-center gap-2 px-3 py-2 text-sm",
            state === "error" && "text-[var(--rose-text)]",
            state === "empty" && "text-muted-foreground",
            state === "loading" && "text-muted-foreground",
          )}
        >
          {state === "loading" ? (
            <span
              aria-hidden="true"
              className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--mute)] border-t-transparent"
            />
          ) : null}
          <span>{label}</span>
        </div>
      )}
    </div>
  );
}
