export const RUN_STATUSES = ["", "queued", "running", "success", "partial", "failed", "cancelled"];

export function normalizeRunStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["queued", "running", "success", "partial", "failed", "cancelled"].includes(normalized)) {
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
  return "danger";
}

export function statusLabel(value) {
  const status = normalizeRunStatus(value);
  if (status === "queued") return "Queued";
  if (status === "running") return "Running";
  if (status === "success") return "Success";
  if (status === "partial") return "Partial";
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
