import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { DisplayTab } from "./display-tab";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Settings DisplayTab (Phase 1 rebuild)", () => {
  it("renders panel visibility, density, and performance groups", () => {
    const markup = html(<DisplayTab />);
    expect(markup).toContain("Panels visibility");
    expect(markup).toContain("Show browser live view");
    expect(markup).toContain("Show screenshot gallery");
    expect(markup).toContain("Show agent execution graph");
    expect(markup).toContain("Show agent plan board");
    expect(markup).toContain("Show context window monitor");
    expect(markup).toContain("Telemetry &amp; information density");
    expect(markup).toContain("Compact event rows");
    expect(markup).toContain("Show timestamps");
    expect(markup).toContain("Show tool call input arguments");
    expect(markup).toContain("Show header cost estimates");
    expect(markup).toContain("Performance &amp; polling");
    expect(markup).toContain("Screenshot live refresh interval");
    expect(markup).toContain("Max events shown in stream");
    expect(markup).toContain("owc_run_view_settings");
  });
});
