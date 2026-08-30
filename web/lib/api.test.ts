import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { apiUrl, resetApiBaseCache, resolveApiBase } from "./api.js";

const originalApiBase = process.env.API_BASE_URL;
const originalPublicApiBase = process.env.NEXT_PUBLIC_API_BASE_URL;

function restore(name: "API_BASE_URL" | "NEXT_PUBLIC_API_BASE_URL", value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => resetApiBaseCache());
afterEach(() => {
  restore("API_BASE_URL", originalApiBase);
  restore("NEXT_PUBLIC_API_BASE_URL", originalPublicApiBase);
  resetApiBaseCache();
});

describe("legacy API base contract", () => {
  it("uses an explicitly configured API origin and trims trailing slashes", () => {
    process.env.API_BASE_URL = "https://api.test.invalid///";
    process.env.NEXT_PUBLIC_API_BASE_URL = "https://public.test.invalid";

    expect(resolveApiBase()).toBe("https://api.test.invalid");
    expect(apiUrl("ui/runs")).toBe("https://api.test.invalid/ui/runs");
  });

  it("rejects an absent origin instead of silently falling back to localhost", () => {
    delete process.env.API_BASE_URL;
    delete process.env.NEXT_PUBLIC_API_BASE_URL;

    expect(() => resolveApiBase()).toThrow("NEXT_PUBLIC_API_BASE_URL is required");
  });
});
