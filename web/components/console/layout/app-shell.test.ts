import { describe, expect, it } from "vitest";

import { shouldLoadActiveRuns } from "./app-shell";

describe("AppShell active-run request guard", () => {
  it("only loads protected status for authenticated console routes", () => {
    expect(shouldLoadActiveRuns("/settings", true)).toBe(true);
    expect(shouldLoadActiveRuns("/", true)).toBe(false);
    expect(shouldLoadActiveRuns("/login", true)).toBe(false);
    expect(shouldLoadActiveRuns("/signup/invite", true)).toBe(false);
    expect(shouldLoadActiveRuns("/settings", false)).toBe(false);
  });
});
