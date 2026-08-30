/**
 * @vitest-environment node
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { RunTimelineTab } from "./run-timeline-tab";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("RunTimelineTab", () => {
  it("renders StepTimeline with plan steps live", () => {
    const markup = html(
      <RunTimelineTab
        plan={{
          steps: [
            { id: "s1", title: "Classify", criteria: "type known", budget: null, status: "done" },
            { id: "s2", title: "Probe", criteria: "streams reachable", budget: "3 calls", status: "in_progress" },
          ],
        }}
        isLive
      />,
    );
    expect(markup).toContain('data-component="StepTimeline"');
    expect(markup).toContain('data-step-id="s1"');
    expect(markup).toContain('data-status="in_progress"');
    expect(markup).toContain("Classify");
    expect(markup).toContain('data-live="true"');
    expect(markup).toContain("2 steps");
  });

  it("falls back to plan_step_update events when plan empty", () => {
    const markup = html(
      <RunTimelineTab
        plan={null}
        events={[
          { kind: "plan_step_update", details: { step_id: "p1", title: "Discover", status: "done" } },
          { kind: "plan_step_update", details: { step_id: "p2", title: "Judge", status: "pending" } },
        ] as unknown as Array<Record<string, unknown>>}
      />,
    );
    expect(markup).toContain('data-step-id="p1"');
    expect(markup).toContain('data-status="done"');
    expect(markup).toContain("Discover");
  });

  it("shows empty state when no steps", () => {
    const markup = html(<RunTimelineTab plan={{ steps: [] }} />);
    expect(markup).toContain('data-state="empty"');
    expect(markup).toContain("No plan recorded");
  });
});
