export const RUN_STATUSES = [
  "",
  "queued",
  "running",
  "success",
  "partial",
  "no_hosting_pages",
  "page_inaccessible",
  "no_streams",
  "llm_rate_limited",
  "llm_api_down",
  "timeout",
  "site_dead",
  "redirect",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type StatusTone = "sky" | "signal" | "warning" | "success" | "danger";
export type StatusLabel =
  | "Queued"
  | "Running"
  | "Success"
  | "Partial"
  | "No hosting pages"
  | "Page inaccessible"
  | "No streams"
  | "LLM rate limited"
  | "LLM API down"
  | "Timeout"
  | "Site dead"
  | "Redirect"
  | "Failed"
  | "Cancelled"
  | "Unknown";

export interface RunRowLike {
  final_status?: unknown;
  status?: unknown;
  job_state?: unknown;
}

export function normalizeRunStatus(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if ((RUN_STATUSES as readonly string[]).includes(normalized)) {
    return normalized;
  }
  return normalized || "unknown";
}

export function statusTone(value: unknown): StatusTone {
  const status = normalizeRunStatus(value);
  if (status === "queued") return "sky";
  if (status === "running") return "signal";
  if (status === "cancelled") return "warning";
  if (status === "success") return "success";
  if (status === "partial") return "warning";
  if (status === "no_hosting_pages") return "warning";
  if (status === "no_streams") return "warning";
  if (status === "llm_rate_limited" || status === "llm_api_down") return "warning";
  if (status === "page_inaccessible" || status === "site_dead" || status === "timeout") return "danger";
  return "danger";
}

export function statusLabel(value: unknown): StatusLabel {
  const status = normalizeRunStatus(value);
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "success") return "Success";
  if (status === "partial") return "Partial";
  if (status === "no_hosting_pages") return "No hosting pages";
  if (status === "page_inaccessible") return "Page inaccessible";
  if (status === "no_streams") return "No streams";
  if (status === "llm_rate_limited") return "LLM rate limited";
  if (status === "llm_api_down") return "LLM API down";
  if (status === "timeout") return "Timeout";
  if (status === "site_dead") return "Site dead";
  if (status === "redirect") return "Redirect";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Unknown";
}

export function canCancelRun(row: RunRowLike | null | undefined): boolean {
  const status = normalizeRunStatus(
    (row as RunRowLike | null | undefined)?.final_status ??
      (row as RunRowLike | null | undefined)?.status ??
      (row as RunRowLike | null | undefined)?.job_state,
  );
  return status === "queued" || status === "running";
}

export function canDeleteRun(row: RunRowLike | null | undefined): boolean {
  return !canCancelRun(row);
}
