import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/live",
  useSearchParams: () => new URLSearchParams("mode=workflow"),
}));

import { RunLauncher } from "./run-launcher";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("RunLauncher workflow workspace", () => {
  it("renders the interactive four-stage pipeline canvas with inspector", () => {
    const markup = html(<RunLauncher defaultMode="workflow" />);
    expect(markup).toContain("Classification &amp; Ingestion");
    expect(markup).toContain("Orchestration &amp; Routing");
    expect(markup).toContain("Parallel Agent Extraction");
    expect(markup).toContain("Validation &amp; Machine Evidence");
    expect(markup).toContain("Pipeline canvas");
    // inspector defaults to the first stage: agents, tools, artifacts, model
    expect(markup).toContain("classification");
    expect(markup).toContain("MCP tools");
    expect(markup).toContain("Artifacts");
    expect(markup).toContain("Model");
  });

  it("renders quick-start presets that load target URLs", () => {
    const markup = html(<RunLauncher defaultMode="workflow" />);
    expect(markup).toContain("Quick-start presets");
    expect(markup).toContain("Live Sports Portal");
    expect(markup).toContain("Streaming Schedule");
    expect(markup).toContain("Embedded Player Test");
    expect(markup).toContain("Sandboxed Iframe Test");
    expect(markup).toContain("https://freeshot.live/live-tv");
    expect(markup).toContain("https://streamed.pk/");
  });

  it("renders advanced options toggle and live preflight with re-check", () => {
    const markup = html(<RunLauncher defaultMode="workflow" />);
    expect(markup).toContain("Advanced run options");
    expect(markup).toContain("Live preflight");
    expect(markup).toContain("Re-check preflight");
    expect(markup).toContain("Target URL");
  });
});
