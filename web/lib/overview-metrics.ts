export const OVERVIEW_RATE_DROPPING_STATUSES = new Set<string>(["failed", "failure"]);

const OVERVIEW_ACTIVE_STATUSES = new Set<string>(["queued", "running", "retrying", "leased", "active"]);

export function normalizeOverviewStatus(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function isOverviewRateDroppingStatus(status: unknown): boolean {
  return OVERVIEW_RATE_DROPPING_STATUSES.has(normalizeOverviewStatus(status));
}

function overviewNeutralFailureCount(
  summary: Record<string, unknown> | null | undefined,
  failureCount: number,
): number {
  const candidates: unknown[] = [
    (summary as Record<string, unknown> | null | undefined)?.llm_provider_blocked_runs,
    (summary as Record<string, unknown> | null | undefined)?.llm_api_blocked_runs,
  ];
  const count = candidates.reduce<number>((total, value) => {
    const next = Number((value as number) || 0);
    return Number.isFinite(next) && next > 0 ? Math.max(total, next) : total;
  }, 0);
  return Math.min(Math.max(0, count), Math.max(0, Number(failureCount || 0)));
}

export interface OverviewSummary {
  status_breakdown?: Record<string, unknown> | null;
  terminal_runs?: unknown;
  success_rate?: unknown;
  llm_provider_blocked_runs?: unknown;
  llm_api_blocked_runs?: unknown;
}

export function overviewFailureOnlySuccessRate(summary: OverviewSummary | Record<string, unknown> = {}): number {
  const s = summary as Record<string, unknown>;
  const breakdown =
    s?.status_breakdown &&
    typeof s.status_breakdown === "object" &&
    !Array.isArray(s.status_breakdown)
      ? (s.status_breakdown as Record<string, unknown>)
      : null;

  if (!breakdown) {
    return Number((s?.success_rate as number) || 0);
  }

  let observedTerminal = 0;
  let failureCount = 0;

  for (const [rawStatus, rawCount] of Object.entries(breakdown)) {
    const count = Number((rawCount as number) || 0);
    if (!Number.isFinite(count) || count <= 0) continue;

    const status = normalizeOverviewStatus(rawStatus);
    if (OVERVIEW_ACTIVE_STATUSES.has(status)) continue;

    observedTerminal += count;
    if (isOverviewRateDroppingStatus(status)) {
      failureCount += count;
    }
  }

  const reportedTerminal = Number((s?.terminal_runs as number) || 0);
  const denominator =
    Number.isFinite(reportedTerminal) && reportedTerminal > 0
      ? reportedTerminal
      : observedTerminal;

  if (!Number.isFinite(denominator) || denominator <= 0) return 0;

  const neutralFailures = overviewNeutralFailureCount(s, failureCount);
  const adjustedDenominator = denominator - neutralFailures;
  const adjustedFailures = failureCount - neutralFailures;
  if (adjustedDenominator <= 0) return denominator > 0 ? 1 : 0;

  return Math.max(0, Math.min(1, 1 - adjustedFailures / adjustedDenominator));
}
