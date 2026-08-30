import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { LogViewer } from "./LogViewer";

const LINES = ["[09:12:00] run started", "", "[09:13:24] probe ok"];

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("LogViewer", () => {
  it("renders all lines with a count and follow flag", () => {
    const markup = html(<LogViewer lines={LINES} follow title="Logs" />);
    expect(markup).toContain('data-state="success"');
    expect(markup).toContain("[09:12:00] run started");
    expect(markup).toContain("[09:13:24] probe ok");
    expect(markup).toContain('data-role="line-count"');
    expect(markup).toContain("3 lines");
    expect(markup).toContain("following");
  });

  it("keeps blank lines renderable", () => {
    const markup = html(<LogViewer lines={LINES} />);
    // Blank line renders as a single space inside its div.
    expect(markup).toContain(`data-line="1" class="min-h-[1em]"`);
  });

  it("tails to maxLines with an +N earlier head", () => {
    const markup = html(<LogViewer lines={LINES} maxLines={2} />);
    expect(markup).toContain("+1 earlier");
    expect(markup).not.toContain("run started");
    expect(markup).toContain("probe ok");
  });

  it("supports loading / error / empty states", () => {
    expect(html(<LogViewer state="loading" />)).toContain('data-state="loading"');
    expect(html(<LogViewer state="error" errorLabel="tail gone" />)).toContain(
      "tail gone",
    );
    expect(html(<LogViewer lines={[]} />)).toContain('data-state="empty"');
  });
});
