import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiFetch, apiFetchBlob, apiUrl, resetApiBaseCache, resolveApiBase } from "./api.js";

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
  vi.unstubAllGlobals();
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

  it("surfaces structured backend error details", async () => {
    process.env.API_BASE_URL = "https://api.test.invalid";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Provider lookup failed" }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(apiFetch("/ui/providers/lookup", { method: "POST" })).rejects.toMatchObject({
      message: "Provider lookup failed",
    });
  });

  it("routes browser requests through the proxy with the bearer token", async () => {
    const token = "test-token-not-a-credential";
    vi.stubGlobal("window", {
      location: { origin: "https://console.test", pathname: "/settings", search: "" },
      localStorage: { getItem: () => token },
    });
    vi.stubGlobal("localStorage", { getItem: () => token });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await apiFetch("/ui/config");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proxy/ui/config",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      }),
    );
  });

  it("routes authenticated binary requests through the proxy", async () => {
    const token = "test-token-not-a-credential";
    vi.stubGlobal("window", {
      location: { origin: "https://console.test", pathname: "/runs/run-1", search: "" },
    });
    vi.stubGlobal("localStorage", { getItem: () => token });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Blob(["image-bytes"], { type: "image/png" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const blob = await apiFetchBlob("/blobs/example-key");

    expect(blob.type).toBe("image/png");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/proxy/blobs/example-key",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      }),
    );
  });
});
