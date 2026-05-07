import { estimateRunCost, synthCallsFromModelUsage } from "@/lib/pricing";

export function toNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

export function terminalStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["success", "partial", "failed", "cancelled"].includes(status)) return status;
  return "";
}

export function datasetRunStatus(row = {}) {
  return String(row.final_status || row.status || row.run?.final_status || "").trim().toLowerCase() || "queued";
}

export function statusToneForDataset(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "success") return "success";
  if (value === "partial") return "warning";
  if (value === "failed" || value === "cancelled") return "danger";
  if (value === "running" || value === "retrying") return "live";
  return "default";
}

export function runTokenTotal(row = {}) {
  const run = row.run || {};
  const direct = toNumber(run.total_tokens || row.total_tokens, 0);
  if (direct > 0) return direct;
  const input = toNumber(run.total_tokens_in, 0);
  const output = toNumber(run.total_tokens_out, 0);
  if (input || output) return input + output;
  return (row.model_usage || []).reduce(
    (total, entry) =>
      total + toNumber(entry?.input_tokens, 0) + toNumber(entry?.output_tokens, 0),
    0,
  );
}

export function effectiveRunCost(row = {}, pricingMap = null) {
  const run = row.run || {};
  const logged =
    toNumber(run.estimated_total_cost_usd, 0) ||
    toNumber(row.total_cost_usd, 0) ||
    toNumber(row.estimated_total_cost_usd, 0);
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

  const calls = synthCallsFromModelUsage(row.model_usage || []);
  const estimated = estimateRunCost(calls, pricingMap);
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

export function summarizeModelUsage(modelUsage = []) {
  return (modelUsage || [])
    .map((entry) => {
      const provider = String(entry?.provider || "").trim();
      const model = String(entry?.model_name || "").trim();
      if (!provider && !model) return "";
      return `${provider}${provider && model ? " / " : ""}${model}`;
    })
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);
}
