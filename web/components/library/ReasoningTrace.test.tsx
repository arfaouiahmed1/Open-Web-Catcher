import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ReasoningTrace } from "./ReasoningTrace";
import type { ReasoningEntry } from "./types";

const ENTRIES: ReasoningEntry[] = [
  { id: "r1", title: "Enumerate sources", thought: "try portals first", timestamp: "2026-08-26T09:12:00Z" },
  { id: "r2", title: "Probe streams" },
];

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("ReasoningTrace", () => {
  it("renders ordered entries with thoughts and timestamps", () => {
    const markup = html(<ReasoningTrace entries={ENTRIES} />);
    expect(markup).toContain('data-state="success"');
    expect(markup).toContain('data-entry-id="r1"');
    expect(markup).toContain('data-entry-id="r2"');
    expect(markup).toContain("Enumerate sources");
    expect(markup).toContain("try portals first");
    expect(markup).toContain('dateTime="2026-08-26T09:12:00Z"');
  });

  it("supports loading / error / empty states", () => {
    expect(html(<ReasoningTrace state="loading" />)).toContain(
      'data-state="loading"',
    );
    const error = html(<ReasoningTrace state="error" errorLabel="boom" />);
    expect(error).toContain('data-state="error"');
    expect(error).toContain("boom");
    expect(html(<ReasoningTrace entries={[]} />)).toContain(
      'data-state="empty"',
    );
  });

  it("derives empty when entries are omitted", () => {
    expect(html(<ReasoningTrace />)).toContain('data-state="empty"');
  });
});
