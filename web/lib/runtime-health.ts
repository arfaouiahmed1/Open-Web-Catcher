const REQUIRED_PROFILES = ["classification", "landing", "hosting", "embedded"] as const;

export type RequiredProfile = (typeof REQUIRED_PROFILES)[number];

export interface RuntimeProfileStatus {
  profile: string;
  healthy: boolean;
  available: boolean;
  status: string;
}

export interface RuntimePayload {
  browser?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  preflight?: {
    profiles?: Array<Record<string, unknown>>;
    launch_ready?: unknown;
    status?: unknown;
    blocking_reasons?: unknown;
  };
}

export interface NormalizedRuntimeStatus {
  browser: Record<string, unknown>;
  mcp: Record<string, unknown>;
  preflight: {
    launchReady: boolean;
    status: string;
    blockingReasons: unknown[];
    profiles: RuntimeProfileStatus[];
  };
  summary: {
    browserHealthy: boolean;
    mcpHealthy: boolean;
    profilesHealthy: boolean;
  };
}

export function normalizeRuntimeStatus(payload: RuntimePayload | null | undefined): NormalizedRuntimeStatus {
  const browser = (payload?.browser ?? {}) as Record<string, unknown>;
  const mcp = (payload?.mcp ?? {}) as Record<string, unknown>;
  const preflight = (payload?.preflight ?? {}) as NonNullable<RuntimePayload["preflight"]>;
  const profileMap = new Map<string, Record<string, unknown>>(
    Array.isArray(preflight.profiles)
      ? (preflight.profiles as Array<Record<string, unknown>>).map((row) => [String((row as Record<string, unknown>).profile), row])
      : [],
  );
  const profiles: RuntimeProfileStatus[] = REQUIRED_PROFILES.map((profile) => {
    const current = profileMap.get(profile) ?? {};
    return {
      profile,
      healthy: Boolean((current as Record<string, unknown>).healthy),
      available: Boolean((current as Record<string, unknown>).available),
      status: String((current as Record<string, unknown>).status ?? ((current as Record<string, unknown>).healthy ? "ready" : "missing")),
    };
  });
  return {
    browser,
    mcp,
    preflight: {
      launchReady: Boolean((preflight as Record<string, unknown>).launch_ready),
      status: String((preflight as Record<string, unknown>).status ?? "blocked"),
      blockingReasons: Array.isArray((preflight as Record<string, unknown>).blocking_reasons)
        ? (preflight as Record<string, unknown>).blocking_reasons as unknown[]
        : [],
      profiles,
    },
    summary: {
      browserHealthy: Boolean((browser as Record<string, unknown>).healthy),
      mcpHealthy: Boolean((mcp as Record<string, unknown>).healthy),
      profilesHealthy: profiles.every((row) => row.healthy),
    },
  };
}

export interface BlockingReason {
  message?: unknown;
  kind?: unknown;
  profile?: unknown;
  endpoint?: unknown;
  error?: unknown;
}

export function formatBlockingReason(reason: BlockingReason | null | undefined): string {
  if (!reason) return "Runtime dependency is unavailable.";
  const parts: string[] = [String(reason.message ?? reason.kind ?? "Runtime dependency is unavailable.")];
  if (reason.profile) parts.push(`profile=${String(reason.profile)}`);
  if (reason.endpoint) parts.push(`endpoint=${String(reason.endpoint)}`);
  if (reason.error) parts.push(`error=${String(reason.error)}`);
  return parts.join("\n");
}

export function formatLaunchError(detail: unknown, status: unknown): string {
  if (typeof detail === "string" && detail.trim()) return detail;
  if (detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    const message = String((d.message as string | undefined) ?? "").trim();
    const runtime = (d.runtime ?? {}) as Record<string, unknown>;
    const preflight = (runtime?.preflight ?? {}) as Record<string, unknown>;
    const reasons = Array.isArray(preflight.blocking_reasons)
      ? (preflight.blocking_reasons as BlockingReason[]).map(formatBlockingReason)
      : [];
    return [message || `Start failed (${String(status)})`, ...reasons].join("\n\n");
  }
  return `Start failed (${String(status)})`;
}
