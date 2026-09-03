/**
 * @vitest-environment node
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ContextWindowMonitor } from "./context-window-monitor";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("ContextWindowMonitor", () => {
  it("renders token utilization with cached and reasoning breakdown", () => {
    const markup = html(
      <ContextWindowMonitor
        events={[
          {
            kind: "agent_loop_started",
            actor: "hosting_page",
            details: { model_name: "gpt-4o", context_window: 128000 },
          },
          {
            kind: "llm_turn_finished",
            actor: "hosting_page",
            details: {
              model_name: "gpt-4o",
              context_window: 128000,
              input_tokens: 64000,
              output_tokens: 2000,
              cached_tokens: 10000,
              reasoning_tokens: 500,
            },
          },
        ] as unknown as Array<Record<string, unknown>>}
      />,
    );
    expect(markup).toContain("Agent Context Windows");
    expect(markup).toContain("gpt-4o");
    expect(markup).toContain("52%");
    expect(markup).toContain("utilized");
    expect(markup).toContain("In:");
    expect(markup).toContain("Out:");
    expect(markup).toContain("Cached:");
    expect(markup).toContain("Thinking:");
  });

  it("renders nothing when no token events exist", () => {
    expect(html(<ContextWindowMonitor events={[]} />)).toBe("");
  });
});
