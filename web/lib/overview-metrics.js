export const OVERVIEW_RATE_DROPPING_STATUSES = new Set(["failed", "failure"]);

const OVERVIEW_ACTIVE_STATUSES = new Set(["queued", "running", "retrying", "leased", "active"]);

export function normalizeOverviewStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

export function isOverviewRateDroppingStatus(status) {
  return OVERVIEW_RATE_DROPPING_STATUSES.has(normalizeOverviewStatus(status));
}

function overviewNeutralFailureCount(summary, failureCount) {
  const candidates = [
    summary?.llm_provider_blocked_runs,
    summary?.llm_api_blocked_runs,
  ];
  const count = candidates.reduce((total, value) => {
    const next = Number(value || 0);
    return Number.isFinite(next) && next > 0 ? Math.max(total, next) : total;
  }, 0);
  return Math.min(Math.max(0, count), Math.max(0, Number(failureCount || 0)));
}

export function overviewFailureOnlySuccessRate(summary = {}) {
  const breakdown =
    summary?.status_breakdown &&
    typeof summary.status_breakdown === "object" &&
    !Array.isArray(summary.status_breakdown)
      ? summary.status_breakdown
      : null;

  if (!breakdown) {
    return Number(summary?.success_rate || 0);
  }

  let observedTerminal = 0;
  let failureCount = 0;

  for (const [rawStatus, rawCount] of Object.entries(breakdown)) {
    const count = Number(rawCount || 0);
    if (!Number.isFinite(count) || count <= 0) continue;

    const status = normalizeOverviewStatus(rawStatus);
    if (OVERVIEW_ACTIVE_STATUSES.has(status)) continue;

    observedTerminal += count;
    if (isOverviewRateDroppingStatus(status)) {
      failureCount += count;
    }
  }

  const reportedTerminal = Number(summary?.terminal_runs || 0);
  const denominator =
    Number.isFinite(reportedTerminal) && reportedTerminal > 0
      ? reportedTerminal
      : observedTerminal;

  if (!Number.isFinite(denominator) || denominator <= 0) return 0;

  const neutralFailures = overviewNeutralFailureCount(summary, failureCount);
  const adjustedDenominator = denominator - neutralFailures;
  const adjustedFailures = failureCount - neutralFailures;
  if (adjustedDenominator <= 0) return denominator > 0 ? 1 : 0;

  return Math.max(0, Math.min(1, 1 - adjustedFailures / adjustedDenominator));
}
