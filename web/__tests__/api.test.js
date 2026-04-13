import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiUrl, apiFetch } from "@/lib/api";

describe("apiUrl", () => {
  it("prepends the default base URL", () => {
    expect(apiUrl("/runs")).toBe("http://localhost:8000/runs");
  });

  it("handles paths without a leading slash", () => {
    expect(apiUrl("overview")).toBe("http://localhost:8000/overview");
  });

  it("does not double-slash when path already starts with /", () => {
    expect(apiUrl("/ui/overview")).toBe("http://localhost:8000/ui/overview");
  });
});

describe("apiFetch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on a 200 response", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ total_runs: 42 }),
    });

    const data = await apiFetch("/ui/overview");
    expect(data.total_runs).toBe(42);
  });

  it("sends Content-Type: application/json by default", async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await apiFetch("/ui/overview");

    const [, options] = fetch.mock.calls[0];
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  it("merges caller-provided headers", async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
    await apiFetch("/ui/runs", { headers: { "X-Trace-Id": "abc123" } });

    const [, options] = fetch.mock.calls[0];
    expect(options.headers["X-Trace-Id"]).toBe("abc123");
    expect(options.headers["Content-Type"]).toBe("application/json");
  });

  it("throws on non-ok responses", async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => "Not found",
    });

    await expect(apiFetch("/missing")).rejects.toThrow("Not found");
  });

  it("throws a generic message when the error body is empty", async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "",
    });

    await expect(apiFetch("/broken")).rejects.toThrow("Request failed with 500");
  });
});
