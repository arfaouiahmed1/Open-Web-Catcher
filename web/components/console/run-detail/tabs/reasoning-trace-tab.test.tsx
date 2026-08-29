/**
 * @vitest-environment node
 */
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ReasoningTraceTab } from "./reasoning-trace-tab";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("ReasoningTraceTab", () => {
  it("derives entries from SSE reasoning events", () => {
    const markup = html(
      <ReasoningTraceTab
        events={[
          { seq: 1, kind: "llm_turn_started", actor: "hosting_page", timestamp: "2026-08-29T10:00:00Z", details: {} },
          { seq: 2, kind: "llm_response", actor: "hosting_page", details: { content_preview: "thinking: try server A", thinking_content: "try server A" }, timestamp: "2026-08-29T10:00:05Z" },
          { seq: 3, kind: "orchestrator_decision", actor: "orchestrator", details: { reasoning: "hosting looks promising" }, message: "decide hosting" },
        ] as unknown as Array<Record<string, unknown>>}
      />,
    );
    expect(markup).toContain('data-component="ReasoningTrace"');
    expect(markup).toContain('data-entry-id="r-2"');
    expect(markup).toContain("try server A");
    expect(markup).toContain("orchestrator_decision");
    expect(markup).toMatch(/3 entries/);
    // At least one reasoning entry should render
    expect(markup).toContain('data-state="success"');
  });

  it("uses explicit entries when provided", () => {
    const markup = html(
      <ReasoningTraceTab entries={[{ id: "e1", title: "Probe", thought: "check landing" }]} />,
    );
    expect(markup).toContain("Probe");
    expect(markup).toContain("check landing");
  });

  it("shows empty when no reasoning events", () => {
    const markup = html(<ReasoningTraceTab events={[{ seq: 1, kind: "server_activated", details: {} } as unknown as Record<string, unknown>]} />);
    expect(markup).toContain('data-state="empty"');
    expect(markup).toContain("No reasoning recorded");
  });
});
