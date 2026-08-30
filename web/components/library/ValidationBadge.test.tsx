import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ValidationBadge } from "./ValidationBadge";

// Field names mirror JudgeVerdict (src/models/judge.py).
const PASS = {
  verdict: "pass" as const,
  evidence_score: 0.92,
  playback_confidence: 0.87,
  channel_match: true,
};
const FAIL = {
  verdict: "fail" as const,
  evidence_score: 0.21,
  playback_confidence: 0.05,
  channel_match: false,
  required_fixes: ["no playable stream"],
  flagged_urls: ["http://a.example/1", "http://a.example/2"],
};

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("ValidationBadge", () => {
  it("renders pass verdict with score chips", () => {
    const markup = html(<ValidationBadge {...PASS} />);
    expect(markup).toContain('data-state="success"');
    expect(markup).toContain('data-verdict="pass"');
    expect(markup).toContain("evidence 92%");
    expect(markup).toContain("playback 87%");
    expect(markup).toContain("channel match ✓");
  });

  it("renders fail verdict with fixes and flagged URL counters", () => {
    const markup = html(<ValidationBadge {...FAIL} />);
    expect(markup).toContain('data-verdict="fail"');
    expect(markup).toContain("channel mismatch ✗");
    expect(markup).toContain('data-role="required-fixes"');
    expect(markup).toContain("1 fix needed");
    expect(markup).toContain('data-role="flagged-urls"');
    expect(markup).toContain("2 flagged URLs");
  });

  it("clamps out-of-range scores into 0..100%", () => {
    const markup = html(<ValidationBadge verdict="pass" evidence_score={1.5} />);
    expect(markup).toContain("evidence 100%");
  });

  it("renders replan verdict", () => {
    expect(html(<ValidationBadge verdict="replan" />)).toContain(
      'data-verdict="replan"',
    );
  });

  it("supports loading / error / empty states", () => {
    expect(html(<ValidationBadge state="loading" />)).toContain(
      'data-state="loading"',
    );
    expect(html(<ValidationBadge state="error" />)).toContain(
      'data-state="error"',
    );
    expect(html(<ValidationBadge />)).toContain('data-state="empty"');
  });
});
