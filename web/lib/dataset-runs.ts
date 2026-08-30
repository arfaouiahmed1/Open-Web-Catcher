import { apiFetch } from "./api";
import { estimateRunCost, synthCallsFromModelUsage } from "./pricing";

export const PRODUCTIVE_SUCCESS_STATUSES = new Set<string>(["success", "partial"]);
export const EXTERNAL_OR_EXPECTED_BLOCKER_STATUSES = new Set<string>([
  "page_inaccessible",
  "site_dead",
  "no_streams",
  "no_hosting_pages",
  "llm_api_down",
  "llm_rate_limited",
]);
export const AGENT_FAILURE_STATUSES = new Set<string>(["failed", "timeout", "redirect"]);
export const CANCELLED_STATUSES = new Set<string>(["cancelled"]);

export function toNumber(value: unknown, fallback = 0): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function terminalStatus(value: unknown): string {
  const status = String(value ?? "").trim().toLowerCase();
  if (
    [
      "success",
      "partial",
      "failed",
      "cancelled",
      "timeout",
      "site_dead",
      "redirect",
      "page_inaccessible",
      "no_hosting_pages",
      "no_streams",
      "llm_api_down",
      "llm_rate_limited",
    ].includes(status)
  )
    return status;
  return "";
}

export interface DatasetRunRow {
  final_status?: unknown;
  status?: unknown;
  run?: Record<string, unknown> & { final_status?: unknown };
  total_tokens?: unknown;
  total_cost_usd?: unknown;
  estimated_total_cost_usd?: unknown;
  model_usage?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export function datasetRunStatus(row: DatasetRunRow | Record<string, unknown> = {}): string {
  const r = row as DatasetRunRow;
  return String(r.final_status ?? r.status ?? (r.run as Record<string, unknown>)?.final_status ?? "").trim().toLowerCase() || "queued";
}

export type MetricBucket =
  | "productive_success"
  | "external_or_expected_blocker"
  | "agent_failure"
  | "cancelled"
  | "active"
  | "unknown";

export function statusMetricBucket(status: unknown): MetricBucket {
  const value = String(status ?? "").trim().toLowerCase();
  if (PRODUCTIVE_SUCCESS_STATUSES.has(value)) return "productive_success";
  if (EXTERNAL_OR_EXPECTED_BLOCKER_STATUSES.has(value)) return "external_or_expected_blocker";
  if (AGENT_FAILURE_STATUSES.has(value)) return "agent_failure";
  if (CANCELLED_STATUSES.has(value)) return "cancelled";
  if (["queued", "running", "retrying", "leased"].includes(value)) return "active";
  return "unknown";
}

export function isAdjustedSuccessStatus(status: unknown): boolean {
  const value = String(status ?? "").trim().toLowerCase();
  return PRODUCTIVE_SUCCESS_STATUSES.has(value) || EXTERNAL_OR_EXPECTED_BLOCKER_STATUSES.has(value);
}

export interface SummarizeOptions {
  getStatus?: (row: DatasetRunRow) => unknown;
}

export interface StatusMetrics {
  terminal_count: number;
  terminal_non_cancelled_count: number;
  productive_success_count: number;
  adjusted_successful_count: number;
  external_blocked_count: number;
  agent_failed_count: number;
  strict_failed_count: number;
  cancelled_count: number;
  success_rate: number;
  adjusted_success_rate: number;
}

export function summarizeStatusMetrics(
  rows: DatasetRunRow[] | null | undefined = [],
  options: SummarizeOptions = {},
): StatusMetrics {
  const getStatus = typeof options.getStatus === "function" ? options.getStatus : datasetRunStatus;
  const totals: StatusMetrics = {
    terminal_count: 0,
    terminal_non_cancelled_count: 0,
    productive_success_count: 0,
    adjusted_successful_count: 0,
    external_blocked_count: 0,
    agent_failed_count: 0,
    strict_failed_count: 0,
    cancelled_count: 0,
    success_rate: 0,
    adjusted_success_rate: 0,
  };

  for (const row of rows ?? []) {
    const status = terminalStatus(getStatus(row));
    if (!status) continue;
    totals.terminal_count += 1;
    const bucket = statusMetricBucket(status);
    if (bucket !== "cancelled") totals.terminal_non_cancelled_count += 1;
    if (bucket === "productive_success") totals.productive_success_count += 1;
    if (bucket === "external_or_expected_blocker") totals.external_blocked_count += 1;
    if (bucket === "agent_failure") totals.agent_failed_count += 1;
    if (bucket === "cancelled") totals.cancelled_count += 1;
    if (AGENT_FAILURE_STATUSES.has(status) || EXTERNAL_OR_EXPECTED_BLOCKER_STATUSES.has(status)) {
      totals.strict_failed_count += 1;
    }
  }

  totals.adjusted_successful_count = totals.productive_success_count + totals.external_blocked_count;
  totals.success_rate = totals.terminal_count
    ? Number(((totals.productive_success_count / totals.terminal_count) * 100).toFixed(1))
    : 0;
  totals.adjusted_success_rate = totals.terminal_non_cancelled_count
    ? Number(((totals.adjusted_successful_count / totals.terminal_non_cancelled_count) * 100).toFixed(1))
    : 0;
  return totals;
}

export type DatasetStatusTone = "success" | "warning" | "danger" | "live" | "default";

export function statusToneForDataset(status: unknown): DatasetStatusTone {
  const value = String(status ?? "").trim().toLowerCase();
  if (value === "success") return "success";
  if (value === "partial") return "warning";
  if (
    value === "no_hosting_pages" ||
    value === "no_streams" ||
    value === "cancelled" ||
    value === "llm_api_down" ||
    value === "llm_rate_limited"
  )
    return "warning";
  if (["failed", "page_inaccessible", "site_dead", "timeout"].includes(value)) return "danger";
  if (value === "running" || value === "retrying") return "live";
  return "default";
}

export function runTokenTotal(row: DatasetRunRow | Record<string, unknown> = {}): number {
  const r = row as DatasetRunRow & { run?: Record<string, unknown> };
  const run = (r.run ?? {}) as Record<string, unknown>;
  const direct = toNumber(run.total_tokens ?? r.total_tokens, 0);
  if (direct > 0) return direct;
  const input = toNumber(run.total_tokens_in, 0);
  const output = toNumber(run.total_tokens_out, 0);
  if (input || output) return input + output;
  return ((r.model_usage as Array<Record<string, unknown>> | undefined) ?? []).reduce(
    (total, entry) => total + toNumber(entry?.input_tokens, 0) + toNumber(entry?.output_tokens, 0),
    0,
  );
}

export interface EffectiveRunCost {
  total: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  calls: number;
  unpriced: number;
  source: string;
}

export function effectiveRunCost(
  row: DatasetRunRow | Record<string, unknown> = {},
  pricingMap: Map<string, unknown> | null = null,
): EffectiveRunCost {
  const r = row as DatasetRunRow & { run?: Record<string, unknown> };
  const run = (r.run ?? {}) as Record<string, unknown>;
  const logged =
    toNumber(run.estimated_total_cost_usd, 0) ||
    toNumber(r.total_cost_usd, 0) ||
    toNumber(r.estimated_total_cost_usd, 0);
  if (logged > 0) {
    return {
      total: logged,
      input: toNumber(run.estimated_input_cost_usd, 0),
      cached: toNumber(run.estimated_cached_input_cost_usd, 0),
      cacheWrite: toNumber(run.estimated_cache_write_cost_usd, 0),
      output: toNumber(run.estimated_output_cost_usd, 0),
      calls: toNumber(run.total_llm_calls, 0),
      unpriced: 0,
      source: "logged",
    };
  }

  const calls = synthCallsFromModelUsage((r.model_usage as unknown[]) ?? []);
  const estimated = estimateRunCost(calls, pricingMap as unknown as Parameters<typeof estimateRunCost>[1]);
  return {
    ...estimated,
    source:
      estimated.calls > 0 && estimated.unpriced === 0
        ? "priced"
        : estimated.calls > 0
          ? "partial"
          : "none",
  };
}

function estimateEntryQuery(entry: Record<string, unknown> = {}): Record<string, string> {
  const inputTokens = toNumber(entry.input_tokens, 0);
  const cachedInputTokens = toNumber(entry.cached_input_tokens, 0);
  const cacheWriteInputTokens = toNumber(entry.cache_creation_input_tokens, 0);
  const newInputTokens = toNumber(
    entry.new_input_tokens,
    Math.max(inputTokens - cachedInputTokens - cacheWriteInputTokens, 0),
  );
  return {
    provider: String(entry.provider ?? "").trim(),
    model: String(entry.model_name ?? "").trim(),
    input_tokens: String(Math.max(newInputTokens, 0)),
    output_tokens: String(toNumber(entry.output_tokens, 0)),
    cached_input_tokens: String(Math.max(cachedInputTokens, 0)),
    cache_write_input_tokens: String(Math.max(cacheWriteInputTokens, 0)),
  };
}

export interface EstimateTotals {
  total: number;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
  calls: number;
  priced: number;
  source: string;
}

export async function estimateRunCostFromApi(
  modelUsage: Array<Record<string, unknown>> | null | undefined = [],
): Promise<EstimateTotals> {
  const rows = ((modelUsage ?? []) as Array<Record<string, unknown>>).filter((entry) => {
    const provider = String(entry?.provider ?? "").trim();
    const model = String(entry?.model_name ?? "").trim();
    return Boolean(provider && model);
  });
  if (!rows.length) {
    return {
      total: 0,
      input: 0,
      cached: 0,
      cacheWrite: 0,
      output: 0,
      calls: 0,
      priced: 0,
      source: "none",
    };
  }

  const results = await Promise.allSettled(
    rows.map(async (entry) => {
      const params = new URLSearchParams(estimateEntryQuery(entry));
      return apiFetch<Record<string, unknown>>(`/ui/settings/estimate-costs?${params.toString()}`);
    }),
  );

  const totals: EstimateTotals = {
    total: 0,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    calls: rows.length,
    priced: 0,
    source: "none",
  };
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const payload = (result.value ?? {}) as Record<string, unknown>;
    if (payload.pricing_source === "no_pricing_available") continue;
    totals.total += toNumber(payload.total_cost_usd, 0);
    totals.input += toNumber(payload.input_cost_usd, 0);
    totals.cached += toNumber(payload.cached_input_cost_usd, 0);
    totals.cacheWrite += toNumber(payload.cache_write_cost_usd, 0);
    totals.output += toNumber(payload.output_cost_usd, 0);
    totals.priced += 1;
  }

  if (totals.priced === rows.length) totals.source = "estimated";
  else if (totals.priced > 0) totals.source = "estimated_partial";
  else totals.source = "unavailable";
  return totals;
}

export function summarizeModelUsage(modelUsage: Array<Record<string, unknown>> | null | undefined = []): string[] {
  return ((modelUsage ?? []) as Array<Record<string, unknown>>)
    .map((entry) => {
      const provider = String(entry?.provider ?? "").trim();
      const model = String(entry?.model_name ?? "").trim();
      if (!provider && !model) return "";
      return `${provider}${provider && model ? " / " : ""}${model}`;
    })
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);
}
