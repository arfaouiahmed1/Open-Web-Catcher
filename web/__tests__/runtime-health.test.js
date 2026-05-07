import { describe, expect, it } from "vitest";

import {
  formatBlockingReason,
  formatLaunchError,
  normalizeRuntimeStatus,
} from "@/lib/runtime-health";

describe("normalizeRuntimeStatus", () => {
  it("keeps browser, MCP, and profile readiness separate", () => {
    const status = normalizeRuntimeStatus({
      browser: {
        healthy: false,
        probe_url: "http://owc-tools:9222/json/version",
        error: "connection refused",
      },
      mcp: {
        healthy: true,
        probe_url: "http://owc-tools:3000/health",
        profiles: ["classification", "landing", "hosting", "embedded"],
      },
      preflight: {
        launch_ready: false,
        status: "blocked",
        profiles: [
          { profile: "classification", healthy: true, available: true, status: "ready" },
          { profile: "landing", healthy: true, available: true, status: "ready" },
          { profile: "hosting", healthy: true, available: true, status: "ready" },
          { profile: "embedded", healthy: true, available: true, status: "ready" },
        ],
        blocking_reasons: [
          {
            kind: "browser_unhealthy",
            message: "Browser endpoint is unavailable.",
            endpoint: "http://owc-tools:9222/json/version",
            error: "connection refused",
          },
        ],
      },
    });

    expect(status.summary.browserHealthy).toBe(false);
    expect(status.summary.mcpHealthy).toBe(true);
    expect(status.summary.profilesHealthy).toBe(true);
    expect(status.preflight.launchReady).toBe(false);
    expect(status.preflight.blockingReasons[0].kind).toBe("browser_unhealthy");
  });
});

describe("formatBlockingReason", () => {
  it("formats actionable blocking messages", () => {
    expect(
      formatBlockingReason({
        message: "Browser endpoint is unavailable.",
        endpoint: "http://owc-tools:9222/json/version",
        error: "connection refused",
      }),
    ).toContain("endpoint=http://owc-tools:9222/json/version");
  });
});

describe("formatLaunchError", () => {
  it("flattens backend preflight payloads into a readable launch error", () => {
    const text = formatLaunchError(
      {
        message: "Runtime dependencies are not ready for a new run.",
        runtime: {
          preflight: {
            blocking_reasons: [
              {
                kind: "browser_unhealthy",
                message: "Browser endpoint is unavailable.",
                endpoint: "http://owc-tools:9222/json/version",
                error: "connection refused",
              },
            ],
          },
        },
      },
      503,
    );

    expect(text).toContain("Runtime dependencies are not ready for a new run.");
    expect(text).toContain("Browser endpoint is unavailable.");
    expect(text).toContain("connection refused");
  });
});
