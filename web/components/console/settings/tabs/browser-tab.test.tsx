import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { BrowserTab } from "./browser-tab";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Settings BrowserTab (T43)", () => {
  it("shows fixed Playwright engine with no selector and validated inputs", () => {
    const markup = html(<BrowserTab config={{ browser: { max_parallel: 6, navigation_timeout_seconds: 45 }, source_layer: "runtime" } as unknown as Record<string, unknown>} />);
    expect(markup).toContain("Playwright");
    expect(markup).toContain("Active engine");
    expect(markup).toContain("Fixed — zero-config");
    expect(markup).not.toContain("BROWSER_OPTIONS");
    expect(markup).not.toContain("engine toggle");
    // validated form hints
    expect(markup).toContain("1–16");
    expect(markup).toContain("validated");
    expect(markup).toContain("runtime");
    // source badge doctrine visible
    expect(markup).toContain("env &lt; base &lt; runtime");
  });

  it("renders source badge for default layer", () => {
    const markup = html(<BrowserTab config={{} as unknown as Record<string, unknown>} />);
    expect(markup).toContain("default");
  });
});
