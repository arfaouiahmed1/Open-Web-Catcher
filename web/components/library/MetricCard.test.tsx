import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MetricCard } from "./MetricCard";

const html = (element: React.ReactElement) => renderToStaticMarkup(element);

describe("MetricCard", () => {
  it("formats numeric values and renders delta direction", () => {
    const up = html(
      <MetricCard
        label="LLM calls"
        value={42000}
        unit="calls"
        delta={{ value: 6, direction: "up" }}
        hint="vs previous run"
      />,
    );
    expect(up).toContain('data-state="success"');
    expect(up).toContain("42,000"); // Intl en-US grouping
    expect(up).toContain("calls");
    expect(up).toContain('data-delta-direction="up"');
    expect(up).toContain("vs previous run");

    const down = html(
      <MetricCard
        label="Errors"
        value={3}
        delta={{ value: 2, direction: "down" }}
      />,
    );
    expect(down).toContain('data-delta-direction="down"');

    const flat = html(
      <MetricCard label="Flat" value={0} delta={{ value: 0, direction: "flat" }} />,
    );
    expect(flat).toContain('data-delta-direction="flat"');
  });

  it("passes string values through untouched", () => {
    const markup = html(<MetricCard label="Duration" value="3m 41s" />);
    expect(markup).toContain("3m 41s");
  });

  it("supports loading / error / empty states", () => {
    expect(html(<MetricCard label="X" value="" state="loading" />)).toContain(
      'data-state="loading"',
    );
    expect(html(<MetricCard label="X" value="" state="error" />)).toContain(
      'data-state="error"',
    );
    expect(html(<MetricCard label="X" value="" />)).toContain(
      'data-state="empty"',
    );
  });
});
