import { apiFetch } from "@/lib/api";
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

function estimateEntryQuery(entry = {}) {
  const inputTokens = toNumber(entry.input_tokens, 0);
  const cachedInputTokens = toNumber(entry.cached_input_tokens, 0);
  const cacheWriteInputTokens = toNumber(entry.cache_creation_input_tokens, 0);
  const newInputTokens = toNumber(
    entry.new_input_tokens,
    Math.max(inputTokens - cachedInputTokens - cacheWriteInputTokens, 0),
  );
  return {
    provider: String(entry.provider || "").trim(),
    model: String(entry.model_name || "").trim(),
    input_tokens: String(Math.max(newInputTokens, 0)),
    output_tokens: String(toNumber(entry.output_tokens, 0)),
    cached_input_tokens: String(Math.max(cachedInputTokens, 0)),
    cache_write_input_tokens: String(Math.max(cacheWriteInputTokens, 0)),
  };
}

export async function estimateRunCostFromApi(modelUsage = []) {
  const rows = (modelUsage || []).filter((entry) => {
    const provider = String(entry?.provider || "").trim();
    const model = String(entry?.model_name || "").trim();
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
      return apiFetch(`/ui/settings/estimate-costs?${params.toString()}`);
    }),
  );

  const totals = {
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
    const payload = result.value || {};
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
