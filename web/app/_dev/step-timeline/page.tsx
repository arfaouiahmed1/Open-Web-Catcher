"use client";

import React from "react";
import { StepTimeline } from "@/components/library";
import type { PlanStep } from "@/components/library";

// Fixtures match the RunPlan step shape from src/orchestrator/run_plan.py.
const STEPS: PlanStep[] = [
  {
    id: "s1",
    title: "Discover sources",
    criteria: "≥3 candidate portal URLs collected",
    budget: "2 LLM calls",
    status: "done",
  },
  {
    id: "s2",
    title: "Probe streams",
    criteria: "each stream answers HEAD/GET <5s",
    budget: null,
    status: "in_progress",
  },
  {
    id: "s3",
    title: "Judge evidence",
    criteria: "verdict pass with channel_match true",
    budget: 1,
    status: "pending",
  },
  {
    id: "s4",
    title: "Draft takedown email",
    criteria: "",
    budget: null,
    status: "skipped",
  },
  {
    id: "s5",
    title: "Submit report",
    criteria: "provider abuse endpoint accepted payload",
    budget: null,
    status: "failed",
  },
];

export default function StepTimelineStory() {
  return (
    <>
      <StepTimeline state="loading" loadingLabel="Loading plan…" />
      <StepTimeline state="error" errorLabel="Plan unavailable." />
      <StepTimeline steps={[]} />
      <StepTimeline steps={STEPS} />
    </>
  );
}
