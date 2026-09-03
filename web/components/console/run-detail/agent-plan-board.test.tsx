/**
 * @vitest-environment node
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentPlanBoard } from "./agent-plan-board";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("AgentPlanBoard", () => {
  it("renders live todos with progress and done state", () => {
    const markup = html(
      <AgentPlanBoard
        events={[
          {
            kind: "tool_call_started",
            actor: "landing_page",
            details: {
              tool_name: "plan",
              tool_args: { op: "write", items: ["Inspect landing grid", "Open first match card"] },
            },
          },
          {
            kind: "tool_call_finished",
            actor: "landing_page",
            details: {
              tool_name: "plan",
              tool_args: { op: "complete", item_id: 0 },
              result_full: JSON.stringify({
                ok: true,
                plan_items: [
                  { id: 0, text: "Inspect landing grid", status: "done" },
                  { id: 1, text: "Open first match card", status: "pending" },
                ],
              }),
            },
          },
        ] as unknown as Array<Record<string, unknown>>}
      />,
    );
    expect(markup).toContain("Agent Action Plans");
    expect(markup).toContain("Inspect landing grid");
    expect(markup).toContain("Open first match card");
    expect(markup).toContain("1/2 (50%)");
    expect(markup).toContain("line-through");
  });

  it("renders nothing when no plan events exist", () => {
    expect(html(<AgentPlanBoard events={[]} />)).toBe("");
  });
});
