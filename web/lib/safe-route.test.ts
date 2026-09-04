import { describe, expect, it } from "vitest";

import { safeReturnPath } from "./safe-route";

describe("safeReturnPath", () => {
  it("accepts same-origin absolute paths with query and hash", () => {
    expect(safeReturnPath("/runs/run-1?tab=events#latest")).toBe("/runs/run-1?tab=events#latest");
  });

  it("rejects protocol-relative and absolute external URLs", () => {
    expect(safeReturnPath("//attacker.example/login")).toBeNull();
    expect(safeReturnPath("https://attacker.example/login")).toBeNull();
  });

  it("rejects empty and malformed values", () => {
    expect(safeReturnPath("")).toBeNull();
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath("/\\\\attacker.example")).toBeNull();
  });
});
