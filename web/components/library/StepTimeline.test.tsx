import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { StepTimeline } from "./StepTimeline";
import type { PlanStep } from "./types";

// Shape mirrors src/orchestrator/run_plan.py _normalize_steps output.
const STEPS: PlanStep[] = [
  { id: "s1", title: "Discover", criteria: "3 URLs", budget: "2 calls", status: "done" },
  { id: "s2", title: "Probe", criteria: "", budget: null, status: "in_progress" },
  { id: "s3", title: "Judge", criteria: "pass", budget: 1, status: "failed" },
  { id: "s4", title: "Report", criteria: "", budget: null, status: "pending" },
  { id: "s5", title: "Skip me", criteria: "", budget: null, status: "skipped" },
];

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("StepTimeline", () => {
  it("renders every plan step with status and budget", () => {
    const markup = html(<StepTimeline steps={STEPS} />);
    expect(markup).toContain('data-state="success"');
    for (const step of STEPS) {
      expect(markup).toContain(`data-step-id="${step.id}"`);
      expect(markup).toContain(`data-status="${step.status}"`);
      expect(markup).toContain(step.title);
    }
    expect(markup).toContain("Criteria:");
    expect(markup).toContain('data-role="step-budget"');
    expect(markup).toContain(String(1));
  });

  it("omits budget rows for null budgets", () => {
    const only = html(
      <StepTimeline
        steps={[{ id: "x", title: "T", criteria: "", budget: null, status: "pending" }]}
      />,
    );
    expect(only).not.toContain('data-role="step-budget"');
  });

  it("supports loading / error / empty states", () => {
    expect(html(<StepTimeline state="loading" />)).toContain(
      'data-state="loading"',
    );
    expect(html(<StepTimeline state="error" errorLabel="no plan" />)).toContain(
      "no plan",
    );
    expect(html(<StepTimeline steps={[]} />)).toContain('data-state="empty"');
  });
});
