export const RUN_STATUSES = [
  "",
  "queued",
  "running",
  "success",
  "partial",
  "no_hosting_pages",
  "page_inaccessible",
  "no_streams",
  "timeout",
  "site_dead",
  "redirect",
  "failed",
  "cancelled",
];

export function normalizeRunStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (RUN_STATUSES.includes(normalized)) {
    return normalized;
  }
  return normalized || "unknown";
}

export function statusTone(value) {
  const status = normalizeRunStatus(value);
  if (status === "queued") return "sky";
  if (status === "running") return "signal";
  if (status === "cancelled") return "warning";
  if (status === "success") return "success";
  if (status === "partial") return "warning";
  if (status === "no_hosting_pages") return "warning";
  if (status === "no_streams") return "warning";
  if (status === "page_inaccessible" || status === "site_dead" || status === "timeout") return "danger";
  return "danger";
}

export function statusLabel(value) {
  const status = normalizeRunStatus(value);
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "success") return "Success";
  if (status === "partial") return "Partial";
  if (status === "no_hosting_pages") return "No hosting pages";
  if (status === "page_inaccessible") return "Page inaccessible";
  if (status === "no_streams") return "No streams";
  if (status === "timeout") return "Timeout";
  if (status === "site_dead") return "Site dead";
  if (status === "redirect") return "Redirect";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Unknown";
}

export function canCancelRun(row) {
  const status = normalizeRunStatus(row?.final_status || row?.status || row?.job_state);
  return status === "queued" || status === "running";
}

export function canDeleteRun(row) {
  return !canCancelRun(row);
}
