const REQUIRED_PROFILES = ["classification", "landing", "hosting", "embedded"];

export function normalizeRuntimeStatus(payload) {
  const browser = payload?.browser || {};
  const mcp = payload?.mcp || {};
  const preflight = payload?.preflight || {};
  const profileMap = new Map(
    Array.isArray(preflight.profiles)
      ? preflight.profiles.map((row) => [row.profile, row])
      : [],
  );
  const profiles = REQUIRED_PROFILES.map((profile) => {
    const current = profileMap.get(profile) || {};
    return {
      profile,
      healthy: Boolean(current.healthy),
      available: Boolean(current.available),
      status: current.status || (current.healthy ? "ready" : "missing"),
    };
  });
  return {
    browser,
    mcp,
    preflight: {
      launchReady: Boolean(preflight.launch_ready),
      status: preflight.status || "blocked",
      blockingReasons: Array.isArray(preflight.blocking_reasons)
        ? preflight.blocking_reasons
        : [],
      profiles,
    },
    summary: {
      browserHealthy: Boolean(browser.healthy),
      mcpHealthy: Boolean(mcp.healthy),
      profilesHealthy: profiles.every((row) => row.healthy),
    },
  };
}

export function formatBlockingReason(reason) {
  if (!reason) return "Runtime dependency is unavailable.";
  const parts = [reason.message || reason.kind || "Runtime dependency is unavailable."];
  if (reason.profile) parts.push(`profile=${reason.profile}`);
  if (reason.endpoint) parts.push(`endpoint=${reason.endpoint}`);
  if (reason.error) parts.push(`error=${reason.error}`);
  return parts.join("\n");
}

export function formatLaunchError(detail, status) {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail === "object") {
    const message = String(detail.message || "").trim();
    const runtime = detail.runtime || {};
    const reasons = Array.isArray(runtime?.preflight?.blocking_reasons)
      ? runtime.preflight.blocking_reasons.map(formatBlockingReason)
      : [];
    return [message || `Start failed (${status})`, ...reasons].join("\n\n");
  }
  return `Start failed (${status})`;
}
