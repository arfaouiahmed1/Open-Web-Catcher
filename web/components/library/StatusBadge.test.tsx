import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { StatusBadge } from "./StatusBadge";

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("StatusBadge", () => {
  it("renders a toned pill in the success state", () => {
    const markup = html(<StatusBadge label="pass" tone="success" />);
    expect(markup).toContain('data-state="success"');
    expect(markup).toContain('data-tone="success"');
    expect(markup).toContain(">pass</span>");
  });

  it("renders loading state with spinner frame", () => {
    const markup = html(<StatusBadge label="" state="loading" loadingLabel="…" />);
    expect(markup).toContain('data-state="loading"');
    expect(markup).toContain("data-role=\"state-message\"");
    expect(markup).not.toContain('data-tone=');
  });

  it("renders error and empty states", () => {
    expect(html(<StatusBadge label="" state="error" />)).toContain(
      'data-state="error"',
    );
    expect(html(<StatusBadge label="" />)).toContain('data-state="empty"');
    // Empty fallback message renders when no custom label is given.
    expect(html(<StatusBadge label="" />)).toContain("Nothing to show yet.");
  });
});
