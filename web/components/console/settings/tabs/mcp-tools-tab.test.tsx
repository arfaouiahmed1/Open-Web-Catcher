import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { McpToolsTab, BrowserToolManifest } from "./mcp-tools-tab";

const mockManifest: BrowserToolManifest = {
  schema_version: "owc.browser-manifest.v2",
  generated_at: "2026-09-03T00:00:00Z",
  tools: [
    {
      name: "navigate",
      kind: "mcp",
      description: "Navigate browser to URL",
      profiles: ["classification", "landing", "hosting", "embedded"],
      mutates_page: true,
      cacheable: false,
    },
    {
      name: "memory_search",
      kind: "langchain",
      description: "Search memory store",
      profiles: ["classification", "landing"],
      mutates_page: false,
      cacheable: true,
    },
  ],
};

describe("McpToolsTab", () => {
  it("renders tools and profiles directly from manifest object", () => {
    const markup = renderToStaticMarkup(<McpToolsTab manifest={mockManifest} />);
    expect(markup).toContain("owc.browser-manifest.v2");
    expect(markup).toContain("navigate");
    expect(markup).toContain("memory_search");
    expect(markup).toContain("Classification");
    expect(markup).toContain("Landing");
    expect(markup).toContain("backend");
    expect(markup).toContain("MCP");
  });

  it("renders unavailable alert when manifest is not provided", () => {
    const markup = renderToStaticMarkup(<McpToolsTab manifest={null} />);
    expect(markup).toContain("The canonical browser-tool manifest is unavailable");
  });
});
