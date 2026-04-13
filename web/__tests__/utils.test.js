import { describe, it, expect } from "vitest";
import { cn, formatCurrency, formatNumber, formatPercent, safeJson } from "@/lib/utils";

describe("cn", () => {
  it("merges class names", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("resolves tailwind conflicts — last wins", () => {
    expect(cn("p-2", "p-4")).toBe("p-4");
  });

  it("drops falsy values", () => {
    expect(cn("foo", false, null, undefined, "bar")).toBe("foo bar");
  });
});

describe("formatCurrency", () => {
  it("formats USD values", () => {
    expect(formatCurrency(1.5)).toMatch(/\$1\.50/);
  });

  it("handles zero", () => {
    expect(formatCurrency(0)).toMatch(/\$0\.00/);
  });

  it("handles null/undefined gracefully", () => {
    expect(formatCurrency(null)).toMatch(/\$0\.00/);
    expect(formatCurrency(undefined)).toMatch(/\$0\.00/);
  });

  it("preserves micro-precision for small costs", () => {
    // formatCurrency uses up to 6 decimal places
    expect(formatCurrency(0.000123)).toMatch(/0\.000123/);
  });
});

describe("formatNumber", () => {
  it("formats integers with locale separators", () => {
    expect(formatNumber(1000000)).toMatch(/1,000,000/);
  });

  it("handles zero", () => {
    expect(formatNumber(0)).toBe("0");
  });

  it("handles null/undefined as 0", () => {
    expect(formatNumber(null)).toBe("0");
    expect(formatNumber(undefined)).toBe("0");
  });
});

describe("formatPercent", () => {
  it("converts a ratio to a percentage string", () => {
    expect(formatPercent(0.75)).toBe("75.0%");
  });

  it("handles 0 and 1 boundaries", () => {
    expect(formatPercent(0)).toBe("0.0%");
    expect(formatPercent(1)).toBe("100.0%");
  });

  it("handles null/undefined as 0%", () => {
    expect(formatPercent(null)).toBe("0.0%");
    expect(formatPercent(undefined)).toBe("0.0%");
  });
});

describe("safeJson", () => {
  it("serializes objects", () => {
    const result = safeJson({ a: 1 });
    expect(JSON.parse(result)).toEqual({ a: 1 });
  });

  it("falls back to string for non-serializable values", () => {
    const circular = {};
    circular.self = circular;
    expect(typeof safeJson(circular)).toBe("string");
  });
});
